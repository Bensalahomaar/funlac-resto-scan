export type NumberKind = "money" | "qty" | "rate";

/**
 * Millimes tunisiens : 1,400 / 1.400 / 1400 → 1.4 DT.
 * Azure valueNumber traite souvent la virgule comme séparateur de milliers (12500).
 */
export function parseTunisianNumber(raw: string, kind: NumberKind = "money"): number {
  const cleaned = String(raw || "")
    .replace(/\u00a0/g, " ")
    .replace(/[^\d,.\-]/g, "")
    .replace(/\s/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === ",") return 0;

  let value = 0;
  if (cleaned.includes(",") && cleaned.includes(".")) {
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    if (lastComma > lastDot) {
      value = Number(cleaned.replace(/\./g, "").replace(",", ".")) || 0;
    } else {
      value = Number(cleaned.replace(/,/g, "")) || 0;
    }
  } else if (cleaned.includes(",")) {
    const last = cleaned.lastIndexOf(",");
    const intPart = cleaned.slice(0, last).replace(/[.,]/g, "");
    const frac = cleaned.slice(last + 1);
    value = Number(`${intPart}.${frac}`) || 0;
  } else {
    const parts = cleaned.split(".");
    if (parts.length === 2 && parts[1].length === 3) {
      value = Number(cleaned) || 0;
    } else if (parts.length > 2) {
      const last = parts.pop() as string;
      value = Number(`${parts.join("")}.${last}`) || 0;
    } else {
      value = Number(cleaned) || 0;
    }
  }

  if (!Number.isFinite(value) || value === 0) return 0;
  if (kind === "rate") return value;
  if (!/[.,]/.test(cleaned)) return millimesIfNeeded(value);
  return value;
}

export function millimesIfNeeded(n: number): number {
  if (!Number.isFinite(n) || n === 0) return 0;
  if (Number.isInteger(n) && Math.abs(n) >= 1000 && Math.abs(n) / 1000 < 10000) {
    return n / 1000;
  }
  return n;
}

export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(3));
}

export function preferTunisianField(text: string, azureNumber: number, kind: NumberKind = "money"): number {
  const fromText = parseTunisianNumber(text, kind);
  if (kind === "rate") return azureNumber || fromText;
  const compact = String(text || "").replace(/\s/g, "");
  const hasSep = /[.,]/.test(compact);
  if (hasSep && fromText > 0) return fromText;
  if (fromText > 0) {
    if (azureNumber >= 1000 && fromText < azureNumber / 10) return fromText;
    return fromText;
  }
  return millimesIfNeeded(azureNumber);
}
