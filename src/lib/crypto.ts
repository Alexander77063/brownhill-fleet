/** App-level secret encryption for tenant-supplied API keys (AES-256-GCM).
 *
 *  Defence-in-depth on top of the deny-all `tenant_ai_secrets` table: even a
 *  service-role read of that table yields ciphertext, useless without the master
 *  key in `TENANT_AI_ENC_KEY` (32 bytes, base64). Dormant like the other secrets
 *  in this app — if the key is absent or malformed, encryption is unavailable and
 *  callers fail CLOSED (the AI feature reports "not configured"), never throwing
 *  a raw error at the user.
 */
import crypto from "node:crypto";

export interface SealedSecret {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

function masterKey(): Buffer | null {
  const raw = process.env.TENANT_AI_ENC_KEY;
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** True when a valid 32-byte master key is configured. */
export function encryptionAvailable(): boolean {
  return masterKey() !== null;
}

/** Seal a plaintext secret. Returns null (fail closed) when no master key. */
export function sealSecret(plaintext: string): SealedSecret | null {
  const key = masterKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Open a sealed secret. Returns null when no master key or on tamper/mismatch. */
export function openSecret(sealed: SealedSecret): string | null {
  const key = masterKey();
  if (!key) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}
