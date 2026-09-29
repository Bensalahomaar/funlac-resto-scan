import { HttpsError, onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { classifyGeminiFailure, geminiUserMessage } from "./geminiError";
import { analyzeInvoiceWithGemini, GeminiAnalyzeError, type GeminiPage } from "./geminiInvoice";
import { loadStoredGeminiKey } from "./geminiKeyStore";

const geminiKey = defineSecret("GEMINI_API_KEY");

const GEMINI_MAX_BYTES = 4_000_000;
const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "application/pdf"]);

type RereadRequest = {
  mimeType?: string;
  base64?: string;
  pages?: GeminiPage[];
  knownSuppliers?: string[];
};

export const rereadInvoice = onCall(
  {
    region: "europe-west1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 60,
    memory: "256MiB",
    secrets: [geminiKey],
  },
  async (request) => {
    const key = await resolveGeminiKey();
    if (!key) {
      throw new HttpsError(
        "failed-precondition",
        "Gemini n’est pas configuré. Un admin peut coller une nouvelle clé dans Mon compte.",
      );
    }

    const data = (request.data || {}) as RereadRequest;
    const pages = normalizePages(data);
    if (!pages.length) {
      throw new HttpsError("invalid-argument", "Document vide.");
    }

    try {
      return await analyzeInvoiceWithGemini(key, pages, Array.isArray(data.knownSuppliers) ? data.knownSuppliers : []);
    } catch (error) {
      throw toHttpsError(error);
    }
  },
);

async function resolveGeminiKey(): Promise<string> {
  const stored = await loadStoredGeminiKey();
  if (stored) return stored;
  return readGeminiKey();
}

function readGeminiKey(): string {
  try {
    const value = geminiKey.value();
    if (value) return value.trim();
  } catch {
    /* secret unbound */
  }
  return String(process.env.GEMINI_API_KEY || "").trim();
}

function normalizePages(data: RereadRequest): GeminiPage[] {
  const raw = Array.isArray(data.pages) && data.pages.length
    ? data.pages
    : data.base64
      ? [{ mimeType: data.mimeType || "image/jpeg", base64: data.base64 }]
      : [];
  const pages: GeminiPage[] = [];
  let total = 0;
  for (const page of raw.slice(0, 2)) {
    const mimeType = String(page.mimeType || "image/jpeg").toLowerCase();
    const base64 = String(page.base64 || "").replace(/\s/g, "");
    if (!ALLOWED_MIME.has(mimeType) || !base64) continue;
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) continue;
    total += bytes.length;
    if (total > GEMINI_MAX_BYTES) {
      throw new HttpsError("invalid-argument", "Image trop lourde pour Gemini (max 4 Mo).");
    }
    pages.push({ mimeType, base64 });
  }
  return pages;
}

function toHttpsError(error: unknown): HttpsError {
  if (error instanceof HttpsError) return error;
  const status = error instanceof GeminiAnalyzeError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Lecture Gemini impossible.";
  const kind = classifyGeminiFailure(status, message);
  const text = geminiUserMessage(kind, message);
  if (kind === "quota") return new HttpsError("resource-exhausted", text);
  if (kind === "timeout") return new HttpsError("deadline-exceeded", text);
  if (kind === "invalid_key") return new HttpsError("failed-precondition", text);
  if (kind === "bad_request") return new HttpsError("invalid-argument", text);
  return new HttpsError("unavailable", text);
}
