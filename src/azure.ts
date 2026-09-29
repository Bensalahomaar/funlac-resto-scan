const API_VERSION = "2024-11-30";
const POLL_MS = 1000;
const POLL_MAX = 45;

export class AzureAnalyzeError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "AzureAnalyzeError";
    this.status = status;
  }
}

export async function analyzeInvoice(
  endpoint: string,
  key: string,
  base64: string,
): Promise<Record<string, unknown>> {
  const root = endpoint.replace(/\/+$/, "");
  const url =
    `${root}/documentintelligence/documentModels/prebuilt-invoice:analyze` +
    `?api-version=${API_VERSION}`;

  const started = await postAnalyze(url, key, base64);
  if (started.status === 429) {
    await sleep(2000);
    const retry = await postAnalyze(url, key, base64);
    if (retry.status === 429) throw new AzureAnalyzeError("QUOTA", 429);
    return finishAnalyze(retry, key);
  }
  return finishAnalyze(started, key);
}

async function postAnalyze(url: string, key: string, base64: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ base64Source: base64 }),
  });
}

async function finishAnalyze(started: Response, key: string): Promise<Record<string, unknown>> {
  if (started.status === 401 || started.status === 403) {
    throw new AzureAnalyzeError("Clé Azure invalide.", started.status);
  }
  if (!started.ok) {
    throw new AzureAnalyzeError(await azureErrorMessage(started), started.status);
  }

  const op = started.headers.get("operation-location") || started.headers.get("Operation-Location");
  if (!op) {
    throw new AzureAnalyzeError("Azure n’a pas renvoyé d’opération.");
  }
  return poll(op, key);
}

async function azureErrorMessage(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  if (/InvalidContent|corrupted|unsupported/i.test(raw)) {
    return "Document illisible pour Azure. Reprends une photo nette, tableau entier visible.";
  }
  if (response.status === 400) {
    return "Document illisible pour Azure. Reprends une photo nette, tableau entier visible.";
  }
  return raw.slice(0, 280) || `Azure ${response.status}`;
}

async function poll(operationUrl: string, key: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < POLL_MAX; i += 1) {
    const response = await fetch(operationUrl, {
      headers: { "Ocp-Apim-Subscription-Key": key },
    });
    if (response.status === 429) {
      await response.text().catch(() => "");
      await sleep(1500);
      continue;
    }
    const body = (await response.json().catch(() => ({}))) as {
      status?: string;
      error?: { message?: string };
      analyzeResult?: Record<string, unknown>;
    };
    const status = String(body.status || "").toLowerCase();
    if (status === "succeeded") {
      return (body.analyzeResult || body) as Record<string, unknown>;
    }
    if (status === "failed") {
      throw new AzureAnalyzeError(body.error?.message || "Analyse Azure en échec.", response.status || 400);
    }
    if (!response.ok) {
      throw new AzureAnalyzeError(body.error?.message || `Azure ${response.status}`, response.status);
    }
    await sleep(POLL_MS);
  }
  throw new AzureAnalyzeError("TIMEOUT", 504);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
