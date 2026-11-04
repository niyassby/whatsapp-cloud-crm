import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@wacrm/shared';
import type { Redis } from 'ioredis';
import { REDIS } from './infra.tokens';

/**
 * Fixed-window counters in Redis. Shared by every API instance, so limits hold behind a load
 * balancer. Keys are namespaced `rl:<bucket>:<subject>`.
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Increment and return the new count; the window starts at the first hit. */
  async hit(key: string, windowSeconds: number): Promise<number> {
    const result = await this.redis.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
    const count = result?.[0]?.[1];
    if (typeof count !== 'number') throw new Error(`Rate limiter INCR failed for ${key}`);
    return count;
  }

  /** Throw RATE_LIMITED if `key` already reached `limit` (without incrementing). */
  async assertNotBlocked(key: string, limit: number): Promise<void> {
    const raw = await this.redis.get(key);
    if (raw !== null && Number(raw) >= limit) await this.throwLimited(key);
  }

  /** Count this attempt and throw RATE_LIMITED once it exceeds `limit`. */
  async consume(key: string, limit: number, windowSeconds: number): Promise<void> {
    const count = await this.hit(key, windowSeconds);
    if (count > limit) await this.throwLimited(key);
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }

  private async throwLimited(key: string): Promise<never> {
    const ttl = await this.redis.ttl(key);
    const retryAfterSeconds = ttl > 0 ? ttl : 60;
    throw new AppError(ErrorCode.RATE_LIMITED, 'Too many attempts. Try again later.', {
      retryAfterSeconds,
    });
  }
}
