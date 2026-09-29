import {
  classifyGeminiFailure,
  geminiUserMessage,
  shouldTryNextGeminiModel,
  type GeminiFailKind,
} from "./geminiError";
import { preferTunisianField, roundMoney } from "./tunisianNumber";
import { isJunkName, type ScanLine, type ScanResult } from "./mapInvoice";

/** Du plus performant au plus léger. Tous sont essayés automatiquement. */
const MODEL_LADDER = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-flash",
  "gemini-flash-latest",
  "gemini-2.0-flash",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
] as const;
const CALL_DEADLINE_MS = 105_000;
const MODEL_ATTEMPTS = 2;
const LADDER_PASSES = 2;
const MP_CATEGORIES = [
  "Biscuit et chocolaterie",
  "Charcuterie et fromage",
  "Emballage et papier",
  "Fruit",
  "Fruits secs et épicerie",
  "Légumes et plantes",
  "Pâtes et dérivés farine",
  "Produits conservés et surgelés",
  "Produit laitier",
  "Viandes rouges",
  "Volailles",
  "Boisson",
  "Fruits de mer",
];

const SCHEMA = {
  type: "OBJECT",
  properties: {
    supplierName: { type: "STRING" },
    supplierMf: { type: "STRING" },
    supplierPhone: { type: "STRING" },
    clientName: { type: "STRING" },
    clientPhone: { type: "STRING" },
    number: { type: "STRING" },
    date: { type: "STRING" },
    dueDate: { type: "STRING" },
    totalHt: { type: "NUMBER" },
    vatAmount: { type: "NUMBER" },
    stampDuty: { type: "NUMBER" },
    totalTtc: { type: "NUMBER" },
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          code: { type: "STRING" },
          designation: { type: "STRING" },
          category: { type: "STRING" },
          subcategory: { type: "STRING" },
          quantity: { type: "NUMBER" },
          unitPrice: { type: "NUMBER" },
          vatRate: { type: "NUMBER" },
          lineTotal: { type: "NUMBER" },
        },
        required: ["designation", "quantity", "unitPrice", "lineTotal"],
      },
    },
  },
  required: ["supplierName", "number", "lines", "totalHt", "totalTtc"],
};

export type GeminiPage = {
  mimeType: string;
  base64: string;
};

export class GeminiAnalyzeError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "GeminiAnalyzeError";
    this.status = status;
  }
}

export async function analyzeInvoiceWithGemini(
  key: string,
  pages: GeminiPage[],
  knownSuppliers: string[] = [],
): Promise<ScanResult> {
  if (!key) throw new GeminiAnalyzeError("Gemini n’est pas configuré (secret Functions).", 503);
  if (!pages.length) throw new GeminiAnalyzeError("Aucune image à envoyer à Gemini.", 400);

  const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = pages.slice(0, 2).map((page) => ({
    inlineData: {
      mimeType: page.mimeType || "image/jpeg",
      data: page.base64.replace(/\s/g, ""),
    },
  }));
  parts.push({ text: buildPrompt(knownSuppliers) });

  const started = Date.now();
  const failures: GeminiFailKind[] = [];
  let lastError = "Lecture Gemini impossible.";

  for (let pass = 0; pass < LADDER_PASSES; pass++) {
    for (const model of MODEL_LADDER) {
      if (Date.now() - started > CALL_DEADLINE_MS) break;
      for (let attempt = 1; attempt <= MODEL_ATTEMPTS; attempt++) {
        if (Date.now() - started > CALL_DEADLINE_MS) break;
        try {
          const raw = await callGemini(key, model, parts, remaining(started));
          return mapGeminiInvoice(raw, model);
        } catch (error) {
          lastError = error instanceof Error ? error.message : lastError;
          const status = error instanceof GeminiAnalyzeError ? error.status : 0;
          const kind = classifyGeminiFailure(status, lastError);
          failures.push(kind);
          if (kind === "invalid_key") {
            throw new GeminiAnalyzeError(geminiUserMessage(kind), 503);
          }
          if (!shouldTryNextGeminiModel(kind)) {
            throw error instanceof GeminiAnalyzeError ? error : new GeminiAnalyzeError(lastError, 503);
          }
          if (attempt < MODEL_ATTEMPTS && (kind === "overloaded" || kind === "rate_limit" || kind === "timeout")) {
            await pause(kind === "timeout" ? 200 : 450 * attempt);
            continue;
          }
          break;
        }
      }
    }
  }
  throw new GeminiAnalyzeError(geminiUserMessage(pickFailure(failures), lastError), statusFor(pickFailure(failures)));
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPrompt(suppliers: string[]): string {
  const names = [...new Set(suppliers.map((name) => name.trim()).filter(Boolean))].slice(0, 20);
  return `Tu es un expert-comptable tunisien. Lis la facture (photo/PDF) et extrais TOUTES les lignes du tableau produits.

Règles strictes :
- Dinar tunisien, millimes : 3 décimales. 18,403 = 18.403 ; 1,000 = 1 ; 0,680 = 0.680.
- Colonnes typiques : CODE | DESIGNATION | QTE | P.U. HT | REM | TVA | TOT. HT.
- code : UNIQUEMENT le code FOURNISSEUR de la ligne s'il est imprimé. Vide sinon. Ne t'en sers PAS pour classer le produit.
- category : une des catégories stock si elle est évidente : ${MP_CATEGORIES.join(", ")}. Vide si tu n'es pas sûr.
- subcategory : nom court du produit de stock (ex. TOMATE, HUILE VEGETAL, EAU). Vide si tu n'es pas sûr.
- Ignore les codes internes / FunLac : on classe par catégorie et sous-catégorie.
- Les chiffres DANS le nom restent dans designation : "BOITE PIZZA 31 EXTRA", "22CL", "3L", "2.5KG", "4P", "60GR", "75GX2". Ce n'est PAS la quantité.
- La quantité est UNIQUEMENT la colonne QTE (souvent 1,000 / 48,000 / 0,340).
- N'omets AUCUNE ligne produit. N'invente aucune ligne, surtout pas un article d'une facture précédente.
- Recopie la désignation EXACTE du document. Deux noms proches sont deux articles différents : MOJITO FRAISE n'est PAS MOJITO BLEU.
- N'inclus PAS dans les lignes produits : adresse, BL, signature, en-tête, "ROUTE MANZEL…".
- TVA ligne : 7, 13 ou 19 si écrite, sinon 0.
- Timbre fiscal souvent 1.000 DT.
- date et dueDate au format YYYY-MM-DD.
- supplierMf : matricule fiscal fournisseur.
- number : n° facture, pas le code client.
- clientPhone : téléphone du CLIENT (case Client / Tél / GSM). Obligatoire s'il est visible.
- supplierPhone : téléphone du FOURNISSEUR (en-tête). Si un seul n° est visible, mets-le dans clientPhone ET supplierPhone.
- totalHt, vatAmount, totalTtc : copie EXACTE des totaux du BAS de facture (TOT HT, TVA, NET À PAYER / TOT TTC). Ne les recalcule PAS à partir des lignes.

${names.length ? `Fournisseurs déjà connus (noms seulement) : ${names.join(", ")}.` : ""}`;
}

async function callGemini(
  key: string,
  model: string,
  parts: unknown[],
  budgetMs: number,
): Promise<Record<string, unknown>> {
  const attempts = [true, false];
  let last: unknown = new GeminiAnalyzeError("Lecture Gemini impossible.", 503);
  for (const withSchema of attempts) {
    if (budgetMs < 4_000) break;
    const timeoutMs = timeoutFor(model, budgetMs);
    const t0 = Date.now();
    try {
      return await callGeminiOnce(key, model, parts, withSchema, timeoutMs);
    } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : "";
      const status = error instanceof GeminiAnalyzeError ? error.status : 0;
      const kind = classifyGeminiFailure(status, message);
      if (kind === "invalid_key" || kind === "model_missing") throw error;
      budgetMs -= Date.now() - t0;
      if (kind === "timeout") throw error;
      if (kind === "overloaded" || kind === "rate_limit" || kind === "quota" || kind === "bad_request" || kind === "empty") {
        continue;
      }
      throw error;
    }
  }
  throw last instanceof Error ? last : new GeminiAnalyzeError("Lecture Gemini impossible.", 503);
}

async function callGeminiOnce(
  key: string,
  model: string,
  parts: unknown[],
  withSchema: boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const generationConfig: Record<string, unknown> = { temperature: 0, maxOutputTokens: 8192 };
  if (withSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = SCHEMA;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig,
        }),
      },
      timeoutMs,
    );
  } catch (error) {
    const lastMessage = error instanceof Error ? error.message : "TIMEOUT";
    if (/TIMEOUT|aborted/i.test(lastMessage)) throw new GeminiAnalyzeError(geminiUserMessage("timeout"), 504);
    throw error;
  }
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
    candidates?: { content?: { parts?: { thought?: boolean; text?: string }[] }; finishReason?: string }[];
  };
  const lastMessage = String(body?.error?.message || `Gemini ${response.status}`);
  if (response.ok) {
    const partsOut = Array.isArray(body?.candidates?.[0]?.content?.parts)
      ? body.candidates[0].content.parts
      : [];
    const text = partsOut
      .filter((part) => !part.thought && part.text)
      .map((part) => part.text || "")
      .join("");
    if (!text.trim()) {
      const block = body?.candidates?.[0]?.finishReason;
      throw new GeminiAnalyzeError(
        block && block !== "STOP"
          ? `Gemini a interrompu la lecture (${block}).`
          : geminiUserMessage("empty"),
        502,
      );
    }
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    try {
      return JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      throw new GeminiAnalyzeError("Réponse Gemini illisible. Réessaie avec une photo plus nette.", 502);
    }
  }
  const kind = classifyGeminiFailure(response.status, lastMessage);
  if (kind === "invalid_key") throw new GeminiAnalyzeError(geminiUserMessage(kind), 503);
  if (kind === "overloaded") throw new GeminiAnalyzeError("high demand", 503);
  if (kind === "quota") throw new GeminiAnalyzeError("quota", 429);
  if (kind === "rate_limit") throw new GeminiAnalyzeError("rate limit", 429);
  if (kind === "model_missing") throw new GeminiAnalyzeError("MODEL_MISSING", 404);
  throw new GeminiAnalyzeError(lastMessage, response.status >= 400 ? response.status : 503);
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(4_000, ms));
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function remaining(started: number): number {
  return Math.max(4_000, CALL_DEADLINE_MS - (Date.now() - started));
}

function timeoutFor(model: string, budgetMs: number): number {
  const preferred = /lite/i.test(model) ? 10_000 : 14_000;
  return Math.max(6_000, Math.min(preferred, budgetMs - 800));
}

function pickFailure(failures: GeminiFailKind[]): GeminiFailKind {
  const unique = [...new Set(failures)];
  if (unique.length === 1) return unique[0];
  if (failures.every((kind) => kind === "quota" || kind === "model_missing")) return "quota";
  if (failures.every((kind) => kind === "overloaded" || kind === "rate_limit" || kind === "model_missing")) {
    return "overloaded";
  }
  if (failures.includes("timeout")) return "timeout";
  if (failures.includes("empty") || failures.includes("bad_request")) return "empty";
  return failures[failures.length - 1] || "other";
}

function statusFor(kind: GeminiFailKind): number {
  if (kind === "quota" || kind === "rate_limit") return 429;
  if (kind === "timeout") return 504;
  if (kind === "bad_request") return 400;
  return 503;
}

export function mapGeminiInvoice(raw: Record<string, unknown>, model: string): ScanResult {
  const rows = Array.isArray(raw.lines) ? raw.lines : [];
  const lines: ScanLine[] = [];
  for (const row of rows) {
    const item = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    const code = String(item.code || "").trim().toUpperCase();
    let designation = String(item.designation || "").replace(/\s+/g, " ").trim();
    if (isJunkName(designation)) designation = "";
    if (designation.length < 2) designation = code || designation;
    if (!designation) continue;
    let quantity = gemNum(item.quantity, "qty");
    const unitPrice = gemNum(item.unitPrice, "money");
    let lineTotal = gemNum(item.lineTotal, "money") || roundMoney(quantity * unitPrice);
    if (quantity <= 0 && unitPrice <= 0 && lineTotal <= 0) continue;
    if (quantity <= 0) quantity = 1;
    if (lineTotal <= 0 && unitPrice > 0) lineTotal = roundMoney(quantity * unitPrice);
    lines.push({
      id: uid("ln"),
      code,
      designation,
      productKey: "",
      quantity,
      unit: inferUnit(designation),
      unitPrice,
      vatRate: vat(item.vatRate),
      lineTotal,
      category: String(item.category || "").trim(),
      subcategory: String(item.subcategory || "").trim(),
    });
  }

  const totalHt = gemNum(raw.totalHt, "money");
  const vatAmount = gemNum(raw.vatAmount, "money");
  const stampDuty = gemNum(raw.stampDuty, "money") || 1;
  let totalTtc = gemNum(raw.totalTtc, "money");
  if (!totalTtc && totalHt) totalTtc = roundMoney(totalHt + vatAmount + stampDuty);

  const warnings: string[] = [];
  if (!lines.length) warnings.push("Gemini n’a trouvé aucune ligne produit.");
  const sum = roundMoney(lines.reduce((s, line) => s + line.lineTotal, 0));
  if (totalHt && sum && Math.abs(sum - totalHt) / totalHt > 0.08) {
    warnings.push(
      `Somme des lignes (${sum.toFixed(3)}) différente du TOT HT (${totalHt.toFixed(3)}). Corrige les totaux du document si besoin.`,
    );
  }

  return {
    number: String(raw.number || "").trim(),
    date: String(raw.date || "").trim(),
    dueDate: String(raw.dueDate || "").trim(),
    supplierName: String(raw.supplierName || "").trim(),
    supplierMf: String(raw.supplierMf || "").trim(),
    supplierPhone: String(raw.supplierPhone || "").trim(),
    clientName: String(raw.clientName || "").trim(),
    clientPhone: String(raw.clientPhone || "").trim(),
    lines,
    totalHt,
    vatAmount,
    stampDuty,
    totalTtc,
    statusGuess: "unpaid",
    paidAt: "",
    confidence: lines.length ? 96 : 40,
    warnings,
    engine: modelLabel(model),
    ocrText: "",
  };
}

function gemNum(value: unknown, kind: "money" | "qty" | "rate"): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return kind === "rate" ? value : preferTunisianField(String(value), value, kind);
  }
  if (typeof value === "string") return preferTunisianField(value, 0, kind);
  return 0;
}

function vat(value: unknown): number {
  const n = gemNum(value, "rate");
  if (n === 7 || n === 13 || n === 19) return n;
  if (n > 0 && n <= 1) return Number((n * 100).toFixed(0));
  return 0;
}

function inferUnit(name: string): string {
  if (/\bkg\b|kilo/i.test(name)) return "kg";
  if (/\b(\d+\s*l|litre|cl|ml)\b/i.test(name)) return "L";
  return "u";
}

function modelLabel(model: string): string {
  if (model.includes("3.8")) return "Gemini 3.8 Flash";
  if (model.includes("3.6")) return "Gemini 3.6 Flash";
  if (model.includes("3.5")) return "Gemini 3.5 Flash";
  if (model.includes("3.1-flash-lite")) return "Gemini 3.1 Flash Lite";
  if (model.includes("3.1")) return "Gemini 3.1 Flash";
  if (model.includes("2.0")) return "Gemini 2.0 Flash";
  if (model.includes("lite")) return "Gemini Flash Lite";
  if (model.includes("flash-latest")) return "Gemini Flash";
  return "Gemini";
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
