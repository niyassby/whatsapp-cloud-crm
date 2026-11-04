import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError, SecretBox } from './crypto';

const key = () => randomBytes(32).toString('base64');

describe('SecretBox', () => {
  const box = new SecretBox(key());

  it('round-trips', () => {
    const ct = box.encrypt('EAAG-super-secret-token');
    expect(ct).not.toContain('super-secret');
    expect(box.decrypt(ct)).toBe('EAAG-super-secret-token');
  });

  it('uses a fresh data key and iv every time', () => {
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('binds ciphertext to its AAD', () => {
    const ct = box.encrypt('secret', 'phone_numbers:1:token');
    expect(box.decrypt(ct, 'phone_numbers:1:token')).toBe('secret');
    expect(() => box.decrypt(ct, 'phone_numbers:2:token')).toThrow(DecryptionError);
    expect(() => box.decrypt(ct)).toThrow(DecryptionError);
  });

  it('detects tampering', () => {
    const parts = box.encrypt('secret').split('.');
    const body = Buffer.from(parts[5]!, 'base64url');
    body[0] = body[0]! ^ 0xff;
    parts[5] = body.toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow(DecryptionError);
  });

  it('rejects malformed input and unknown keys', () => {
    expect(() => box.decrypt('nope')).toThrow(DecryptionError);
    expect(() => new SecretBox(key()).decrypt(box.encrypt('x'))).toThrow(/Unknown key id/);
  });

  it('supports rotation with a previous key', () => {
    const oldKey = key();
    const oldBox = new SecretBox(oldKey);
    const ct = oldBox.encrypt('rotate-me');

    const rotated = new SecretBox(key(), [oldKey]);
    expect(rotated.decrypt(ct)).toBe('rotate-me');
    expect(rotated.needsReencrypt(ct)).toBe(true);
    const fresh = rotated.encrypt('rotate-me');
    expect(rotated.needsReencrypt(fresh)).toBe(false);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
