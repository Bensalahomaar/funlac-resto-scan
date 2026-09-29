import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { analyzeInvoice, AzureAnalyzeError } from "./azure";
import { mapAzureInvoice } from "./mapInvoice";
import { analyzeInvoiceWithGemini, GeminiAnalyzeError, type GeminiPage } from "./geminiInvoice";
import {
  emptyGeminiKeyStatus,
  geminiKeySuffix,
  isPlausibleGeminiKey,
} from "./geminiKeyFormat";
import { loadStoredGeminiKey, loadStoredGeminiKeyStatus, saveStoredGeminiKey } from "./geminiKeyStore";

const MAX_BYTES = 4_000_000;
const ALLOWED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "application/pdf"]);
const PORT = Number(process.env.PORT || 8787);

let liveGeminiKey = "";
let liveGeminiUpdatedAt = "";

loadDotEnv();
initFirebaseAdmin();

const server = http.createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`FunLac scan API on :${PORT}`);
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  cors(req, res);
  const url = req.url?.split("?")[0] || "";
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (url === "/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true });
    return;
  }
  try {
    if (url === "/api/geminiKeyStatus" && (req.method === "GET" || req.method === "POST")) {
      sendJson(res, 200, await geminiStatus());
      return;
    }
    if (url === "/api/geminiKey" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req, 8_000)) as { key?: string };
        sendJson(res, 200, await persistGeminiKey(String(body.key || "")));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Enregistrement impossible.";
        sendJson(res, 400, { code: "invalid-argument", message: message.slice(0, 180) });
      }
      return;
    }
    if (req.method !== "POST" || (url !== "/api/scanInvoice" && url !== "/api/rereadInvoice")) {
      sendJson(res, 404, { code: "not-found", message: "Route inconnue." });
      return;
    }
    const body = JSON.parse(await readBody(req, 6_000_000)) as {
      mimeType?: string;
      base64?: string;
      pages?: GeminiPage[];
      knownSuppliers?: string[];
    };
    if (url === "/api/rereadInvoice") {
      await handleReread(body, res);
      return;
    }
    await handleScan(body, res);
  } catch (error) {
    sendScanError(res, error);
  }
}

async function handleScan(
  body: { mimeType?: string; base64?: string },
  res: ServerResponse,
): Promise<void> {
  const mimeType = String(body.mimeType || "").toLowerCase();
  const base64 = String(body.base64 || "").replace(/\s/g, "");
  if (!ALLOWED_MIME.has(mimeType)) {
    sendJson(res, 400, { code: "invalid-argument", message: "Envoie une photo JPEG/PNG ou un PDF (max 2 pages)." });
    return;
  }
  if (!base64) {
    sendJson(res, 400, { code: "invalid-argument", message: "Document vide." });
    return;
  }
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) {
    sendJson(res, 400, { code: "invalid-argument", message: "Document illisible." });
    return;
  }
  if (bytes.length > MAX_BYTES) {
    sendJson(res, 400, { code: "invalid-argument", message: "Fichier trop lourd pour le palier gratuit Azure (max 4 Mo)." });
    return;
  }
  const azureEndpoint = String(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || "").trim().replace(/\/+$/, "");
  const azureKey = String(process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY || "").trim();
  if (!azureEndpoint || !azureKey) {
    sendJson(res, 503, {
      code: "failed-precondition",
      message: "Azure n’est pas configuré (variables Render AZURE_DOCUMENT_INTELLIGENCE_*).",
    });
    return;
  }
  const analyzeResult = await analyzeInvoice(azureEndpoint, azureKey, base64);
  sendJson(res, 200, mapAzureInvoice(analyzeResult));
}

async function handleReread(
  body: { mimeType?: string; base64?: string; pages?: GeminiPage[]; knownSuppliers?: string[] },
  res: ServerResponse,
): Promise<void> {
  const geminiKey = await resolveGeminiKey();
  if (!geminiKey) {
    sendJson(res, 503, {
      code: "failed-precondition",
      message: "Gemini n’est pas configuré. Un admin peut coller une nouvelle clé dans Mon compte.",
    });
    return;
  }
  if (!isPlausibleGeminiKey(geminiKey)) {
    sendJson(res, 503, {
      code: "failed-precondition",
      message: "Clé Gemini invalide. Colle une nouvelle clé dans Mon compte.",
    });
    return;
  }
  const raw = Array.isArray(body.pages) && body.pages.length
    ? body.pages
    : body.base64
      ? [{ mimeType: body.mimeType || "image/jpeg", base64: body.base64 }]
      : [];
  const pages: GeminiPage[] = [];
  let total = 0;
  for (const page of raw.slice(0, 2)) {
    const mimeType = String(page.mimeType || "image/jpeg").toLowerCase();
    const base64 = String(page.base64 || "").replace(/\s/g, "");
    if (!ALLOWED_MIME.has(mimeType) || !base64) continue;
    const size = Buffer.from(base64, "base64").length;
    if (!size) continue;
    total += size;
    if (total > MAX_BYTES) {
      sendJson(res, 400, { code: "invalid-argument", message: "Image trop lourde pour Gemini (max 4 Mo)." });
      return;
    }
    pages.push({ mimeType, base64 });
  }
  if (!pages.length) {
    sendJson(res, 400, { code: "invalid-argument", message: "Document vide." });
    return;
  }
  const result = await analyzeInvoiceWithGemini(
    geminiKey,
    pages,
    Array.isArray(body.knownSuppliers) ? body.knownSuppliers : [],
  );
  sendJson(res, 200, result);
}

async function resolveGeminiKey(): Promise<string> {
  if (liveGeminiKey) return liveGeminiKey;
  const stored = await loadStoredGeminiKey();
  if (stored) return stored;
  return String(process.env.GEMINI_API_KEY || "").trim();
}

async function persistGeminiKey(raw: string) {
  const key = raw.trim();
  if (!isPlausibleGeminiKey(key)) {
    throw new Error("Clé Gemini invalide. Colle une clé AI Studio (AQ… ou AIza…).");
  }
  liveGeminiKey = key;
  liveGeminiUpdatedAt = new Date().toISOString();
  try {
    return await saveStoredGeminiKey(key);
  } catch {
    return { configured: true, suffix: geminiKeySuffix(key), updatedAt: liveGeminiUpdatedAt };
  }
}

async function geminiStatus() {
  if (liveGeminiKey) {
    return { configured: true, suffix: geminiKeySuffix(liveGeminiKey), updatedAt: liveGeminiUpdatedAt };
  }
  try {
    const stored = await loadStoredGeminiKeyStatus();
    if (stored.configured) return stored;
  } catch {
    /* admin absent */
  }
  const envKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!envKey) return emptyGeminiKeyStatus();
  return { configured: true, suffix: geminiKeySuffix(envKey), updatedAt: "" };
}

function initFirebaseAdmin(): void {
  if (getApps().length) return;
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  if (!raw) return;
  try {
    const creds = JSON.parse(raw) as object;
    initializeApp({ credential: cert(creds), projectId: "funlac-resto" });
  } catch (error) {
    console.error("FIREBASE_SERVICE_ACCOUNT invalide", error instanceof Error ? error.message : error);
  }
}

function loadDotEnv(): void {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  for (const line of text.split(/\r\n|\n|\r/)) {
    const match = line.match(/^\s*([^#=]+)=(.*)$/);
    if (!match) continue;
    const name = match[1].trim();
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[name]) process.env[name] = value;
  }
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = String(req.headers.origin || "");
  if (
    origin === "https://funlac-resto.web.app"
    || origin === "https://funlac-resto.firebaseapp.com"
    || /^https?:\/\/localhost:\d+$/.test(origin)
    || /^https?:\/\/127\.0\.0\.1:\d+$/.test(origin)
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
}

function sendScanError(res: ServerResponse, error: unknown): void {
  if (error instanceof GeminiAnalyzeError) {
    const status = geminiHttpStatus(error.status);
    sendJson(res, status, {
      code: geminiCode(error.status, error.message),
      message: error.message.slice(0, 180),
    });
    return;
  }
  const azureStatus = error instanceof AzureAnalyzeError ? error.status : 0;
  const message = error instanceof Error ? error.message : "Lecture impossible.";
  if (azureStatus === 429 || /QUOTA/i.test(message)) {
    sendJson(res, 429, { code: "resource-exhausted", message: "Quota Azure atteint (500 pages/mois)." });
    return;
  }
  if (azureStatus === 504 || /TIMEOUT/i.test(message)) {
    sendJson(res, 504, { code: "deadline-exceeded", message: "Azure met trop longtemps à répondre." });
    return;
  }
  if (azureStatus === 401 || azureStatus === 403 || /clé azure invalide/i.test(message)) {
    sendJson(res, 503, { code: "failed-precondition", message: "Clé Azure invalide." });
    return;
  }
  if (azureStatus >= 400 && azureStatus < 500) {
    sendJson(res, 400, {
      code: "invalid-argument",
      message: /invalidcontent|corrupted|unsupported/i.test(message)
        ? "Document illisible pour Azure. Reprends une photo nette, tableau entier visible."
        : message.slice(0, 180) || "Document illisible. Reprends une photo nette, tableau entier visible.",
    });
    return;
  }
  sendJson(res, 503, { code: "unavailable", message: message.slice(0, 180) || "Scan indisponible." });
}

function geminiHttpStatus(status: number): number {
  if (status === 429 || status === 504) return status;
  if (status >= 400 && status < 500) return 400;
  return 503;
}

function geminiCode(status: number, message: string): string {
  if (status === 429 && /quota/i.test(message)) return "resource-exhausted";
  if (status === 429) return "unavailable";
  if (status === 504) return "deadline-exceeded";
  if (/clé gemini invalide|n’est pas configuré/i.test(message)) return "failed-precondition";
  if (status >= 400 && status < 500) return "invalid-argument";
  return "unavailable";
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
