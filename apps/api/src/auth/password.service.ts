import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// OWASP argon2id baseline: 19 MiB, 2 iterations, 1 lane. Algorithm defaults to argon2id.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  /** Hash of a random string, verified when the user does not exist to equalise timing. */
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(passwordHash: string | null | undefined, password: string): Promise<boolean> {
    if (!passwordHash) {
      this.dummyHash ??= hash('timing-equaliser-not-a-real-password', OPTIONS);
      await verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    try {
      return await verify(passwordHash, password);
    } catch {
      // Malformed stored hash: treat as a failed login, never as success.
      return false;
    }
  }
}
