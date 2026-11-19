import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@wacrm/shared';
import type { Redis } from 'ioredis';
import { API_ENV, type ApiEnv } from '../env';
import { REDIS } from './infra.tokens';

/**
 * Fixed-window counters in Redis. Shared by every API instance, so limits hold behind a load
 * balancer. Callers name keys `rl:<bucket>:<subject>`; they are stored under `QUEUE_PREFIX`
 * (`wacrm:rl:...`), so two environments sharing one Redis never share counters.
 */
@Injectable()
export class RateLimiter {
  private readonly prefix: string;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    this.prefix = `${env.QUEUE_PREFIX}:`;
  }

  /** Increment and return the new count; the window starts at the first hit. */
  async hit(name: string, windowSeconds: number): Promise<number> {
    const key = this.prefix + name;
    const result = await this.redis.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
    const count = result?.[0]?.[1];
    if (typeof count !== 'number') throw new Error(`Rate limiter INCR failed for ${key}`);
    return count;
  }

  /** Throw RATE_LIMITED if `key` already reached `limit` (without incrementing). */
  async assertNotBlocked(name: string, limit: number): Promise<void> {
    const key = this.prefix + name;
    const raw = await this.redis.get(key);
    if (raw !== null && Number(raw) >= limit) await this.throwLimited(key);
  }

  /** Count this attempt and throw RATE_LIMITED once it exceeds `limit`. */
  async consume(name: string, limit: number, windowSeconds: number): Promise<void> {
    const count = await this.hit(name, windowSeconds);
    if (count > limit) await this.throwLimited(this.prefix + name);
  }

  async reset(name: string): Promise<void> {
    await this.redis.del(this.prefix + name);
  }

  private async throwLimited(key: string): Promise<never> {
    const ttl = await this.redis.ttl(key);
    const retryAfterSeconds = ttl > 0 ? ttl : 60;
    throw new AppError(ErrorCode.RATE_LIMITED, 'Too many attempts. Try again later.', {
      retryAfterSeconds,
    });
  }
}
