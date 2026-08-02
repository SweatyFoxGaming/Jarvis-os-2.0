import crypto from "crypto";

// Application-level encryption for anything stored in oauth_tokens — real
// people's real Google refresh tokens, not just Jarvis's own operational
// state. Protects against the realistic threat here (someone getting query
// access to Postgres — a backup leak, a compromised process — without also
// having this key), which matters more for a self-hosted deployment than
// disk-level encryption would. AES-256-GCM: IV + auth tag + ciphertext
// packed into one stored string (colon-separated, each base64), so a single
// TEXT column holds everything needed to decrypt.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // 96-bit IV is the GCM-recommended size

function getKey(): Buffer {
  const raw = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "OAUTH_TOKEN_ENCRYPTION_KEY is not set — generate one with `openssl rand -base64 32` and set it before storing any OAuth tokens."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `OAUTH_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}) — generate one with \`openssl rand -base64 32\`.`
    );
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptToken(stored: string): string | null {
  try {
    const key = getKey();
    const [ivB64, authTagB64, ciphertextB64] = stored.split(":");
    if (!ivB64 || !authTagB64 || !ciphertextB64) return null;
    const iv = Buffer.from(ivB64, "base64");
    const authTag = Buffer.from(authTagB64, "base64");
    const ciphertext = Buffer.from(ciphertextB64, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf-8");
  } catch {
    // Tampered ciphertext, wrong key, corrupt/garbage input — all fail
    // closed the same way: treat as undecryptable, never throw past this
    // boundary, never partially return something that looks plausible.
    return null;
  }
}
