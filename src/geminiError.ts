export type GeminiFailKind =
  | "quota"
  | "rate_limit"
  | "overloaded"
  | "invalid_key"
  | "model_missing"
  | "timeout"
  | "bad_request"
  | "empty"
  | "other";

export function classifyGeminiFailure(status: number, message: string): GeminiFailKind {
  const blob = `${status} ${message}`;
  if (
    /clé gemini invalide|API key not valid|API_KEY_INVALID|API_KEY_SERVICE_BLOCKED/i.test(blob) &&
    !/ACCESS_TOKEN_TYPE/i.test(blob)
  ) {
    return "invalid_key";
  }
  if (status === 404 || /MODEL_MISSING|not found|no longer available|ACCESS_TOKEN_TYPE/i.test(blob)) {
    return "model_missing";
  }
  if (status === 504 || /TIMEOUT|aborted|deadline/i.test(blob)) return "timeout";
  if (status === 503 || /high demand|overloaded|UNAVAILABLE|try again later|BUSY/i.test(blob)) {
    return "overloaded";
  }
  if ((status === 429 || /resource.exhausted/i.test(blob)) && /quota|billing/i.test(blob)) {
    return "quota";
  }
  if (status === 429 || /rate[- ]limit|too many requests/i.test(blob)) return "rate_limit";
  if (/exceeded your current quota|quota exceeded/i.test(blob)) return "quota";
  if (status === 400 || /invalid argument|unable to process input/i.test(blob)) return "bad_request";
  if (/aucun contenu|illisible|interrompu/i.test(blob)) return "empty";
  return "other";
}

export function geminiUserMessage(kind: GeminiFailKind, fallback = "Lecture Gemini impossible."): string {
  switch (kind) {
    case "quota":
      return "Quota Gemini atteint sur tous les modèles.";
    case "rate_limit":
      return "Gemini a limité tous les modèles. Relance Relire avec Gemini.";
    case "overloaded":
      return "Lecture Gemini impossible après tous les modèles. Relance Relire avec Gemini.";
    case "invalid_key":
      return "Clé Gemini invalide. Colle une nouvelle clé dans Mon compte.";
    case "timeout":
      return "Gemini met trop longtemps à répondre. Réessaie.";
    case "model_missing":
      return "Modèle Gemini indisponible. Réessaie.";
    case "bad_request":
      return "Document illisible pour Gemini. Reprends une photo nette, tableau entier visible.";
    case "empty":
      return "Gemini n’a renvoyé aucun contenu. Réessaie avec une photo plus nette.";
    default:
      return fallback.slice(0, 180) || "Lecture Gemini impossible.";
  }
}

export function shouldTryNextGeminiModel(kind: GeminiFailKind): boolean {
  return kind !== "invalid_key";
}
