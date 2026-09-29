import { HttpsError, onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { analyzeInvoice, AzureAnalyzeError } from "./azure";
import { mapAzureInvoice } from "./mapInvoice";

const azureEndpoint = defineSecret("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT");
const azureKey = defineSecret("AZURE_DOCUMENT_INTELLIGENCE_KEY");

const AZURE_MAX_BYTES = 4_000_000;
const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "application/pdf"]);

type ScanRequest = {
  mimeType?: string;
  base64?: string;
};

export const scanInvoice = onCall(
  {
    region: "europe-west1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 60,
    memory: "256MiB",
    secrets: [azureEndpoint, azureKey],
  },
  async (request) => {
    const { endpoint, key } = readAzure();
    if (!endpoint || !key) {
      throw new HttpsError(
        "failed-precondition",
        "Azure Document Intelligence n’est pas configuré (secrets Functions).",
      );
    }

    const data = (request.data || {}) as ScanRequest;
    const mimeType = String(data.mimeType || "").toLowerCase();
    const base64 = String(data.base64 || "").replace(/\s/g, "");
    if (!ALLOWED_MIME.has(mimeType)) {
      throw new HttpsError("invalid-argument", "Envoie une photo JPEG/PNG ou un PDF (max 2 pages).");
    }
    if (!base64) {
      throw new HttpsError("invalid-argument", "Document vide.");
    }
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) {
      throw new HttpsError("invalid-argument", "Document illisible.");
    }
    if (bytes.length > AZURE_MAX_BYTES) {
      throw new HttpsError("invalid-argument", "Fichier trop lourd pour le palier gratuit Azure (max 4 Mo).");
    }

    try {
      const analyzeResult = await analyzeInvoice(endpoint, key, base64);
      return mapAzureInvoice(analyzeResult);
    } catch (error) {
      throw toHttpsError(error);
    }
  },
);

function readAzure(): { endpoint: string; key: string } {
  return {
    endpoint: secretOrEnv(azureEndpoint, "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT").replace(/\/+$/, ""),
    key: secretOrEnv(azureKey, "AZURE_DOCUMENT_INTELLIGENCE_KEY"),
  };
}

function secretOrEnv(secret: ReturnType<typeof defineSecret>, envName: string): string {
  try {
    const value = secret.value();
    if (value) return value.trim();
  } catch {
    /* secret unbound (émulateur / .env) */
  }
  return String(process.env[envName] || "").trim();
}

function toHttpsError(error: unknown): HttpsError {
  if (error instanceof HttpsError) return error;
  const status = error instanceof AzureAnalyzeError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Lecture Azure impossible.";
  if (status === 429 || /QUOTA/i.test(message)) {
    return new HttpsError("resource-exhausted", "Quota Azure atteint (500 pages/mois).");
  }
  if (status === 504 || /TIMEOUT/i.test(message)) {
    return new HttpsError("deadline-exceeded", "Azure met trop longtemps à répondre.");
  }
  if (status === 401 || status === 403) {
    return new HttpsError("failed-precondition", "Clé Azure invalide.");
  }
  if (status >= 400 && status < 500) {
    return new HttpsError("invalid-argument", "Document illisible pour Azure. Reprends une photo nette, tableau entier visible.");
  }
  return new HttpsError("unavailable", message.slice(0, 180) || "Azure indisponible.");
}
