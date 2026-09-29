import { getApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  emptyGeminiKeyStatus,
  geminiKeySuffix,
  isPlausibleGeminiKey,
  type GeminiKeyStatus,
} from "./geminiKeyFormat";

const KEY_DOC = "settings/gemini";
const META_DOC = "settings/gemini-meta";

function db() {
  const app = getApp();
  try {
    return getFirestore(app, "default");
  } catch {
    return getFirestore(app);
  }
}

export async function loadStoredGeminiKey(): Promise<string> {
  try {
    const snap = await db().doc(KEY_DOC).get();
    return String(snap.data()?.key || "").trim();
  } catch {
    return "";
  }
}

export async function loadStoredGeminiKeyStatus(): Promise<GeminiKeyStatus> {
  try {
    const snap = await db().doc(META_DOC).get();
    const data = snap.data() || {};
    const suffix = String(data.suffix || "").trim();
    const updatedAt = String(data.updatedAt || "").trim();
    if (suffix) return { configured: true, suffix, updatedAt };
    const key = await loadStoredGeminiKey();
    if (!key) return emptyGeminiKeyStatus();
    return { configured: true, suffix: geminiKeySuffix(key), updatedAt };
  } catch {
    return emptyGeminiKeyStatus();
  }
}

export async function saveStoredGeminiKey(raw: string): Promise<GeminiKeyStatus> {
  const key = raw.trim();
  if (!isPlausibleGeminiKey(key)) {
    throw new Error("Clé Gemini invalide. Colle une clé AI Studio (AQ… ou AIza…).");
  }
  const updatedAt = new Date().toISOString();
  const suffix = geminiKeySuffix(key);
  const firestore = db();
  await firestore.doc(KEY_DOC).set({ key, updatedAt }, { merge: true });
  await firestore.doc(META_DOC).set({ configured: true, suffix, updatedAt }, { merge: true });
  return { configured: true, suffix, updatedAt };
}
