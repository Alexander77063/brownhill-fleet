/** App-level secret encryption for tenant-supplied API keys (AES-256-GCM).
 *
 *  Defence-in-depth on top of the deny-all `tenant_ai_secrets` table: even a
 *  service-role read of that table yields ciphertext, useless without the master
 *  key in `TENANT_AI_ENC_KEY` (32 bytes, base64). Dormant like the other secrets
 *  in this app — if the key is absent or malformed, encryption is unavailable and
 *  callers fail CLOSED (the AI feature reports "not configured"), never throwing
 *  a raw error at the user.
 *
 *  AES-256-GCM is implemented here with the Web Crypto API
 *  (`globalThis.crypto.subtle`) — the same primitives the browser exposes, and
 *  the same ones Node 19+ ships under the same global. Using Web Crypto
 *  keeps this file free of `node:crypto` so the Next standalone build can
 *  bundle it without the bundler trying to resolve the `node:` URI scheme.
 *
 *  Functions are async because the underlying SubtleCrypto API is
 *  Promise-based. Callers already live in Server Actions or route handlers,
 *  so awaiting is fine. The few existing call sites (4 files) have been
 *  updated to await.
 */

export interface SealedSecret {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

function masterKey(): Uint8Array | null {
  const raw = process.env.TENANT_AI_ENC_KEY;
  if (!raw) return null;
  try {
    const bin = atob(raw);
    if (bin.length !== 32) return null;
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when a valid 32-byte master key is configured. */
export function encryptionAvailable(): boolean {
  return masterKey() !== null;
}

/** Seal a plaintext secret. Returns null (fail closed) when no master key
 *  or when the platform's Web Crypto is unavailable. */
export async function sealSecret(plaintext: string): Promise<SealedSecret | null> {
  const key = masterKey();
  if (!key) return null;
  try {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      // TextEncoder's Uint8Array and our key bytes are typed
      // `Uint8Array<ArrayBufferLike>`; SubtleCrypto's importKey wants
      // `BufferSource` = `ArrayBufferView<ArrayBuffer> | ArrayBuffer`.
      // The runtime values are byte-identical (no SharedArrayBuffer in
      // play), but TS strict types refuse the implicit conversion. Cast
      // through `unknown` so the call site stays readable.
      key as unknown as ArrayBufferView<ArrayBuffer>,
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const ciphertext = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as unknown as ArrayBufferView<ArrayBuffer> },
        cryptoKey,
        new TextEncoder().encode(plaintext) as unknown as ArrayBufferView<ArrayBuffer>,
      ),
    );
    // Web Crypto appends the 16-byte auth tag to the ciphertext; split it
    // out so the on-disk shape matches the Node `createCipheriv` form
    // and so older stored values round-trip cleanly.
    const authTag = ciphertext.subarray(ciphertext.length - 16);
    const ctNoTag = ciphertext.subarray(0, ciphertext.length - 16);
    return {
      ciphertext: bytesToB64(ctNoTag),
      iv: bytesToB64(iv),
      authTag: bytesToB64(authTag),
    };
  } catch {
    return null;
  }
}

/** Open a sealed secret. Returns null when no master key, when tampering
 *  is detected (auth tag mismatch), or when the platform's Web Crypto
 *  is unavailable. */
export async function openSecret(sealed: SealedSecret): Promise<string | null> {
  const key = masterKey();
  if (!key) return null;
  try {
    const iv = b64ToBytes(sealed.iv);
    const authTag = b64ToBytes(sealed.authTag);
    const ctBytes = b64ToBytes(sealed.ciphertext);
    const ciphertext = new Uint8Array(ctBytes.length + authTag.length);
    ciphertext.set(ctBytes, 0);
    ciphertext.set(authTag, ctBytes.length);

    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      key as unknown as ArrayBufferView<ArrayBuffer>,
      'AES-GCM',
      false,
      ['decrypt'],
    );
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as ArrayBufferView<ArrayBuffer> },
      cryptoKey,
      ciphertext as unknown as ArrayBufferView<ArrayBuffer>,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
