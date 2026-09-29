import { harvestLinesFromContent, sameLine, type HarvestedLine } from "./harvestLines";
import { preferTunisianField, roundMoney } from "./tunisianNumber";

export type ScanLine = {
  id: string;
  code: string;
  designation: string;
  productKey: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  vatRate: number;
  lineTotal: number;
  category?: string;
  subcategory?: string;
};

export type ScanResult = {
  number: string;
  date: string;
  dueDate: string;
  supplierName: string;
  supplierMf: string;
  supplierPhone: string;
  clientName: string;
  clientPhone: string;
  lines: ScanLine[];
  totalHt: number;
  vatAmount: number;
  stampDuty: number;
  totalTtc: number;
  statusGuess: "paid" | "unpaid";
  paidAt: string;
  confidence: number;
  warnings: string[];
  engine: string;
  ocrText: string;
};

type AzureField = {
  type?: string;
  content?: string;
  valueString?: string;
  valueNumber?: number;
  valueDate?: string;
  valuePhoneNumber?: string;
  valueAddress?: { streetAddress?: string; houseNumber?: string; road?: string; city?: string };
  valueCurrency?: { amount?: number; currencyCode?: string };
  valueArray?: AzureField[];
  valueObject?: Record<string, AzureField>;
  confidence?: number;
};

type AzureDocument = {
  docType?: string;
  confidence?: number;
  fields?: Record<string, AzureField>;
};

export function mapAzureInvoice(analyzeResult: Record<string, unknown>): ScanResult {
  const documents = Array.isArray(analyzeResult.documents)
    ? (analyzeResult.documents as AzureDocument[])
    : [];
  const doc = documents[0] || {};
  const fields = doc.fields || {};
  const content = String(analyzeResult.content || "");

  const totalHt = money(num(fields.SubTotal));
  const vatAmount = money(num(fields.TotalTax));
  let totalTtc = money(num(fields.InvoiceTotal) || num(fields.AmountDue));
  const remainder = money(totalTtc - totalHt - vatAmount);
  const stampDuty = remainder >= 0.4 && remainder <= 1.6 ? remainder : 1;
  if (!totalTtc && totalHt) {
    totalTtc = money(totalHt + vatAmount + stampDuty);
  }

  const lines = mergeHarvest(mapItems(fields.Items), harvestLinesFromContent(content), totalHt);

  const harvest = [
    str(fields.VendorName),
    addressText(fields.VendorAddress),
    str(fields.CustomerName),
    addressText(fields.CustomerAddress),
    str(fields.BillingAddressRecipient),
    content,
  ].join("\n");
  const supplierPhone = phone(fields.VendorPhoneNumber) || harvestPhone(harvest);
  const clientPhone =
    phone(fields.CustomerPhoneNumber) || harvestPhone(harvest, supplierPhone ? [supplierPhone] : []) || supplierPhone;

  const warnings: string[] = [];
  if (!lines.length) warnings.push("Azure n’a trouvé aucune ligne produit.");
  const sum = money(lines.reduce((s, line) => s + line.lineTotal, 0));
  if (totalHt && sum && Math.abs(sum - totalHt) / totalHt > 0.08) {
    warnings.push(
      `Somme des lignes (${sum.toFixed(3)}) différente du TOT HT (${totalHt.toFixed(3)}). Corrige les totaux du document si besoin.`,
    );
  }

  const confidence = lines.length
    ? Math.round(Math.min(99, Math.max(40, (doc.confidence || 0.9) * 100)))
    : 40;

  return {
    number: str(fields.InvoiceId),
    date: date(fields.InvoiceDate),
    dueDate: date(fields.DueDate),
    supplierName: str(fields.VendorName) || str(fields.VendorAddressRecipient),
    supplierMf: str(fields.VendorTaxId),
    supplierPhone,
    clientName: str(fields.CustomerName) || str(fields.CustomerAddressRecipient),
    clientPhone,
    lines,
    totalHt,
    vatAmount,
    stampDuty,
    totalTtc,
    statusGuess: "unpaid",
    paidAt: "",
    confidence,
    warnings,
    engine: "Azure Invoice",
    ocrText: content.trim(),
  };
}

function mapItems(field?: AzureField): ScanLine[] {
  const rows = field?.valueArray || [];
  const lines: ScanLine[] = [];
  for (const row of rows) {
    const item = row.valueObject || {};
    const code = str(item.ProductCode).toUpperCase();
    let designation = str(item.Description);
    if (isJunkName(designation)) designation = "";
    if (designation.length < 2) designation = code || designation;
    let quantity = qty(item.Quantity);
    const unitPrice = money(num(item.UnitPrice));
    let lineTotal = money(num(item.Amount) || quantity * unitPrice);
    if (quantity <= 0 && unitPrice <= 0 && lineTotal <= 0) continue;
    if (!designation && !code && lineTotal <= 0) continue;
    if (!designation) designation = code || "Article";
    if (quantity <= 0) quantity = 1;
    if (lineTotal <= 0 && unitPrice > 0) lineTotal = money(quantity * unitPrice);
    const taxAmount = num(item.Tax);
    const taxRate = num(item.TaxRate, "rate");
    lines.push({
      id: uid("ln"),
      code,
      designation,
      productKey: "",
      quantity,
      unit: str(item.Unit) || inferUnit(designation),
      unitPrice,
      vatRate: vat(taxRate || (lineTotal ? (taxAmount / lineTotal) * 100 : 0)),
      lineTotal,
    });
  }
  return lines;
}

function mergeHarvest(azureLines: ScanLine[], harvested: HarvestedLine[], totalHt: number): ScanLine[] {
  const filled = azureLines.map((line) => {
    const usable = line.designation.length >= 2 && !isJunkName(line.designation);
    if (usable) return line;
    const hit = harvested.find(
      (row) =>
        sameLine(line, row) ||
        (close(line.lineTotal, row.lineTotal) && close(line.unitPrice, row.unitPrice)),
    );
    if (!hit) {
      return { ...line, designation: line.designation || line.code || "Article" };
    }
    return {
      ...line,
      designation: hit.designation,
      code: line.code || hit.code,
      unit: line.unit || hit.unit,
      quantity: line.quantity > 0 ? line.quantity : hit.quantity,
      unitPrice: line.unitPrice > 0 ? line.unitPrice : hit.unitPrice,
      lineTotal: line.lineTotal > 0 ? line.lineTotal : hit.lineTotal,
      vatRate: line.vatRate || hit.vatRate,
    };
  });

  const sum = money(filled.reduce((s, line) => s + line.lineTotal, 0));
  const mismatch = !filled.length || (totalHt > 0 && sum > 0 && Math.abs(sum - totalHt) / totalHt > 0.08);
  if (!mismatch) return filled;

  const extras = harvested.filter((row) => !filled.some((line) => sameLine(line, row)));
  return [
    ...filled,
    ...extras.map((row) => ({
      id: uid("ln"),
      code: row.code,
      designation: row.designation,
      productKey: "",
      quantity: row.quantity,
      unit: row.unit,
      unitPrice: row.unitPrice,
      vatRate: row.vatRate,
      lineTotal: row.lineTotal,
    })),
  ];
}

function str(field?: AzureField): string {
  if (!field) return "";
  return String(field.valueString || field.content || "").replace(/\s+/g, " ").trim();
}

function azureNumeric(field?: AzureField): number {
  if (!field) return 0;
  if (typeof field.valueNumber === "number" && Number.isFinite(field.valueNumber)) return field.valueNumber;
  if (field.valueCurrency && typeof field.valueCurrency.amount === "number") return field.valueCurrency.amount;
  return 0;
}

function fieldText(field?: AzureField): string {
  if (!field) return "";
  return String(field.content || field.valueString || "");
}

function num(field?: AzureField, kind: "money" | "rate" = "money"): number {
  if (!field) return 0;
  return preferTunisianField(fieldText(field), azureNumeric(field), kind);
}

function qty(field?: AzureField): number {
  if (!field) return 0;
  return preferTunisianField(fieldText(field), azureNumeric(field), "qty");
}

function date(field?: AzureField): string {
  const raw = String(field?.valueDate || str(field) || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const m = raw.match(/^(\d{1,2})[/.\\-](\d{1,2})[/.\\-](\d{2,4})$/);
  if (!m) return raw;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function phone(field?: AzureField): string {
  const raw = String(field?.valuePhoneNumber || str(field) || "");
  return digitsPhone(raw);
}

function addressText(field?: AzureField): string {
  const addr = field?.valueAddress;
  if (!addr) return str(field);
  return [addr.houseNumber, addr.road, addr.streetAddress, addr.city, str(field)].filter(Boolean).join(" ");
}

function harvestPhone(text: string, exclude: string[] = []): string {
  const labeled = text.match(/(?:tel|t[ée]l|gsm)\s*[:.]?\s*(?:\+?216[\s.]*)?([0-9][0-9.\s]{7,})/i);
  if (labeled) {
    const value = digitsPhone(labeled[1]);
    if (value && !exclude.includes(value)) return value;
  }
  const hits = [...text.matchAll(/\b(?:\+?216[\s.]*)?([2-9]\d{7})\b/g)].map((match) => match[1]);
  return hits.find((value) => !exclude.includes(value)) ?? "";
}

function digitsPhone(value: string): string {
  const digits = value.replace(/[^\d]/g, "");
  if (digits.startsWith("216") && digits.length >= 11) return digits.slice(3, 11);
  if (digits.length >= 8) return digits.slice(0, 8);
  return digits;
}

function vat(n: number): number {
  let rate = n;
  if (rate > 0 && rate <= 1) rate *= 100;
  const rounded = Math.round(rate);
  if (rounded === 7 || rounded === 13 || rounded === 19) return rounded;
  if (Math.abs(rate - 19) < 1.5) return 19;
  if (Math.abs(rate - 13) < 1.5) return 13;
  if (Math.abs(rate - 7) < 1.5) return 7;
  return 0;
}

function money(n: number): number {
  return roundMoney(n);
}

function inferUnit(name: string): string {
  if (/\bkg\b|kilo/i.test(name)) return "kg";
  if (/\b(\d+\s*l|litre|cl|ml)\b/i.test(name)) return "L";
  return "u";
}

export function isJunkName(value: string): boolean {
  const n = value.replace(/\s+/g, " ").trim();
  if (!n) return true;
  if (/^(route|adresse|client|facture|total|timbre|signature|code|designation|qte|quantit[ée]?|ste)$/i.test(n)) {
    return true;
  }
  if (/^route\b/i.test(n) && n.length > 8) return true;
  if (/^(tot\.?\s*ht|net\s*[àa]\s*payer|n[°o]\s*facture)/i.test(n)) return true;
  return false;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.02 || (a > 0 && Math.abs(a - b) / a < 0.015);
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
