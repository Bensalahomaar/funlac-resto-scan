import { HttpsError, onCall } from "firebase-functions/v2/https";
import { loadStoredGeminiKeyStatus, saveStoredGeminiKey } from "./geminiKeyStore";

export const saveGeminiKey = onCall(
  {
    region: "europe-west1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 15,
    memory: "256MiB",
  },
  async (request) => {
    const key = String((request.data as { key?: string } | undefined)?.key || "");
    try {
      return await saveStoredGeminiKey(key);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Enregistrement impossible.";
      throw new HttpsError("invalid-argument", message.slice(0, 180));
    }
  },
);

export const geminiKeyStatus = onCall(
  {
    region: "europe-west1",
    cors: true,
    invoker: "public",
    timeoutSeconds: 15,
    memory: "256MiB",
  },
  async () => loadStoredGeminiKeyStatus(),
);
