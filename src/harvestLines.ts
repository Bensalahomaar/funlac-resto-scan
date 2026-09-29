import { parseTunisianNumber, roundMoney } from "./tunisianNumber";

export type HarvestedLine = {
  code: string;
  designation: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
  lineTotal: number;
  unit: string;
};

export function harvestLinesFromContent(content: string): HarvestedLine[] {
  const lines: HarvestedLine[] = [];
  for (const raw of String(content || "").split(/\r?\n/)) {
    const row = raw.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    if (!row) continue;
    const parsed = parseHarvestLine(row);
    if (!parsed) continue;
    if (lines.some((line) => sameLine(line, parsed))) continue;
    lines.push(parsed);
  }
  return lines;
}

export function sameLine(
  a: { code: string; designation: string; quantity: number; unitPrice: number; lineTotal: number },
  b: { code: string; designation: string; quantity: number; unitPrice: number; lineTotal: number },
): boolean {
  if (a.code && b.code && a.code === b.code) return true;
  const da = normName(a.designation);
  const db = normName(b.designation);
  if (da && db && da === db && close(a.unitPrice, b.unitPrice)) return true;
  if (close(a.quantity, b.quantity) && close(a.unitPrice, b.unitPrice) && close(a.lineTotal, b.lineTotal)) return true;
  if (da && db && close(a.lineTotal, b.lineTotal) && close(a.unitPrice, b.unitPrice) && (da.includes(db) || db.includes(da))) {
    return true;
  }
  return false;
}

export function parseHarvestLine(row: string): HarvestedLine | null {
  let line = row.replace(/[;:_=]+/g, " ").replace(/\s+/g, " ").trim();
  if (line.length < 4 || isSkipRow(line)) return null;

  const tokens = line.split(/\s+/).filter(Boolean);
  const tail: string[] = [];
  while (tokens.length) {
    const last = tokens[tokens.length - 1];
    if (!isAmountToken(last)) break;
    tail.unshift(tokens.pop() as string);
  }

  let vatRate = 0;
  const amounts: number[] = [];
  for (const token of tail) {
    const compact = token.replace(/\s/g, "");
    if (/^(7|13|19)(?:[.,]0{1,2})?$/.test(compact)) {
      vatRate = Number(compact.split(/[.,]/)[0]);
      continue;
    }
    const value = parseTunisianNumber(compact, "money");
    if (value === 7 || value === 13 || value === 19) {
      vatRate = value;
      continue;
    }
    if (value > 0) amounts.push(value);
  }
  if (amounts.length < 2) return null;

  let quantity = 0;
  let unitPrice = 0;
  let lineTotal = 0;
  if (amounts.length === 2) {
    const [a, b] = amounts;
    if (looksLikeQty(a) && a * b > 0) {
      quantity = a;
      unitPrice = b;
      lineTotal = roundMoney(a * b);
    } else if (b > a && a > 0) {
      quantity = roundMoney(b / a);
      unitPrice = a;
      lineTotal = b;
    } else {
      quantity = looksLikeQty(a) ? a : 1;
      unitPrice = b;
      lineTotal = roundMoney(quantity * unitPrice);
    }
  } else {
    lineTotal = amounts[amounts.length - 1];
    const rest = amounts.slice(0, -1);
    const qtyHit = rest.find((value) => looksLikeQty(value));
    const priceHit = [...rest].reverse().find((value) => value !== qtyHit && value >= 0.01);
    quantity = qtyHit && qtyHit !== lineTotal ? qtyHit : looksLikeQty(rest[0]) ? rest[0] : 1;
    unitPrice = priceHit && priceHit !== quantity ? priceHit : roundMoney(lineTotal / (quantity || 1));
  }

  if (unitPrice < 0.01 || quantity <= 0 || quantity > 5000 || lineTotal < 0.01) return null;

  const peeled = peelCode(tokens.join(" "));
  const designation = tidyName(peeled.rest);
  if (!isPlausibleName(designation)) return null;

  return {
    code: peeled.code,
    designation,
    quantity,
    unitPrice: roundMoney(unitPrice),
    vatRate,
    lineTotal: roundMoney(lineTotal),
    unit: inferUnit(designation),
  };
}

function isSkipRow(row: string): boolean {
  const n = row.toLowerCase();
  if (/^(code|designation|qte|quantit|p\.?u\.?|tot|tva|rem|base|timbre|page|mail|rib|client|adresse|signature|produit|taux)/i.test(n)) {
    return true;
  }
  if (/\b(tot\s*h\.?t|total\s*(ht|tva|ttc)|net\s*a\s*payer|montant\s*tva|bon de livraison)\b/i.test(n) && countAmounts(row) < 3) {
    return true;
  }
  return false;
}

function countAmounts(row: string): number {
  return (row.match(/\d+[.,]\d{2,3}/g) || []).length;
}

function isAmountToken(token: string): boolean {
  const compact = token.replace(/\s/g, "");
  if (!compact || /[A-Za-zÀ-ÿ%]/.test(compact)) return false;
  if (/^(7|13|19)(?:[.,]0{1,2})?$/.test(compact)) return true;
  if (/^\d{1,5}[.,]\d{2,3}$/.test(compact)) return true;
  if (/^\d{4,6}$/.test(compact)) return true;
  return false;
}

function looksLikeQty(value: number): boolean {
  if (value <= 0 || value > 2000) return false;
  const millis = Math.round(value * 1000);
  if (millis % 1000 === 0) return true;
  if (value < 100 && millis % 10 === 0) return true;
  return value <= 80;
}

function peelCode(text: string): { code: string; rest: string } {
  const raw = text.trim();
  const labeled = raw.match(/^(?:code|r[ée]f(?:[ée]rence)?|art(?:icle)?)\s*[:.#]?\s*([A-Z0-9][A-Z0-9./-]{1,16})\b\s*/i);
  if (labeled) return { code: labeled[1].toUpperCase(), rest: raw.slice(labeled[0].length).trim() };
  const leading = raw.match(/^(\d{3,14}|[A-Z]{1,4}[-/]?\d{2,12})(?=\s+[A-Za-zÀ-ÿ])/);
  if (!leading || /^(7|13|19)$/.test(leading[1])) return { code: "", rest: raw };
  return { code: leading[1].toUpperCase(), rest: raw.slice(leading[0].length).trim() };
}

function tidyName(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^[-–:.,]+|[-–:.,]+$/g, "").trim();
}

function isPlausibleName(value: string): boolean {
  if (value.length < 2) return false;
  if (!/[A-Za-zÀ-ÿ]/.test(value)) return false;
  if (/^(route|adresse|client|facture|total|timbre|signature|code|designation|qte)$/i.test(value)) return false;
  return true;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.02 || (a > 0 && Math.abs(a - b) / a < 0.015);
}

function normName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function inferUnit(name: string): string {
  if (/\bkg\b|kilo/i.test(name)) return "kg";
  if (/\b(\d+\s*l|litre|cl|ml)\b/i.test(name)) return "L";
  return "u";
}
