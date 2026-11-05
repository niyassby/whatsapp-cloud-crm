/**
 * AES-256-GCM envelope encryption for secrets at rest (WhatsApp tokens, integration
 * credentials, TOTP secrets). Server-only.
 *
 * Each value gets a fresh random data key (DEK). The DEK encrypts the plaintext; the key
 * encryption key (KEK, from ENCRYPTION_KEY) encrypts the DEK. Ciphertext format:
 *
 *   v1.<kid>.<wrapIv>.<wrappedDek+tag>.<iv>.<ciphertext+tag>   (base64url parts)
 *
 * `kid` identifies the KEK, so rotation works by configuring the new key as current and the
 * old one as previous; `needsReencrypt` tells a background job which rows to rewrite.
 * Optional `aad` binds a ciphertext to its row (e.g. "phone_numbers:<id>:token") so it
 * cannot be copied to another row.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AAD for each stored secret: binds the ciphertext to its row so it cannot be copied. */
export const totpAad = (userId: string) => `users:${userId}:totp`;
export const phoneTokenAad = (id: string) => `phone_numbers:${id}:token`;
export const phonePinAad = (id: string) => `phone_numbers:${id}:pin`;

export class DecryptionError extends Error {
  readonly code = 'DECRYPTION_FAILED';
  constructor(message = 'Unable to decrypt value') {
    super(message);
    this.name = 'DecryptionError';
  }
}

interface Kek {
  kid: string;
  key: Buffer;
}

function parseKey(base64: string, label: string): Kek {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) {
    throw new Error(`${label} must be 32 bytes, base64 encoded (openssl rand -base64 32)`);
  }
  const kid = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return { kid, key };
}

function seal(key: Buffer, plaintext: Buffer, aad?: Buffer): [Buffer, Buffer] {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return [iv, body];
}

function open(key: Buffer, iv: Buffer, body: Buffer, aad?: Buffer): Buffer {
  if (body.length < TAG_BYTES) throw new DecryptionError();
  const decipher = createDecipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch (err) {
    throw new DecryptionError(err instanceof Error ? err.message : undefined);
  }
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

export class SecretBox {
  private readonly current: Kek;
  private readonly keys: Map<string, Kek>;

  /**
   * @param currentKey base64 32-byte KEK used for new encryptions (ENCRYPTION_KEY)
   * @param previousKeys older KEKs still accepted for decryption during rotation
   */
  constructor(currentKey: string, previousKeys: string[] = []) {
    this.current = parseKey(currentKey, 'ENCRYPTION_KEY');
    this.keys = new Map([[this.current.kid, this.current]]);
    for (const k of previousKeys) {
      const kek = parseKey(k, 'ENCRYPTION_KEY_PREVIOUS');
      this.keys.set(kek.kid, kek);
    }
  }

  encrypt(plaintext: string, aad?: string): string {
    const dek = randomBytes(32);
    const aadBuf = aad === undefined ? undefined : Buffer.from(aad, 'utf8');
    const [wrapIv, wrapped] = seal(this.current.key, dek, Buffer.from(this.current.kid));
    const [iv, body] = seal(dek, Buffer.from(plaintext, 'utf8'), aadBuf);
    dek.fill(0);
    return [VERSION, this.current.kid, b64(wrapIv), b64(wrapped), b64(iv), b64(body)].join('.');
  }

  decrypt(ciphertext: string, aad?: string): string {
    const parts = ciphertext.split('.');
    if (parts.length !== 6 || parts[0] !== VERSION)
      throw new DecryptionError('Malformed ciphertext');
    const [, kid, wrapIv, wrapped, iv, body] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const kek = this.keys.get(kid);
    if (!kek) throw new DecryptionError(`Unknown key id ${kid}`);
    const dek = open(kek.key, unb64(wrapIv), unb64(wrapped), Buffer.from(kid));
    try {
      const aadBuf = aad === undefined ? undefined : Buffer.from(aad, 'utf8');
      return open(dek, unb64(iv), unb64(body), aadBuf).toString('utf8');
    } finally {
      dek.fill(0);
    }
  }

  /** True if the value was encrypted under a key other than the current one. */
  needsReencrypt(ciphertext: string): boolean {
    return ciphertext.split('.')[1] !== this.current.kid;
  }
}
