export type GeminiKeyStatus = {
  configured: boolean;
  suffix: string;
  updatedAt: string;
};

export function geminiKeySuffix(key: string): string {
  const value = key.trim();
  if (value.length < 4) return "";
  return value.slice(-4);
}

export function isPlausibleGeminiKey(key: string): boolean {
  const value = key.trim();
  return value.length >= 20 && /^(AIza|AQ\.)/.test(value);
}

export function emptyGeminiKeyStatus(): GeminiKeyStatus {
  return { configured: false, suffix: "", updatedAt: "" };
}
