import { Inject, Injectable } from '@nestjs/common';
import { hasFeature, withTenant } from '@wacrm/db';
import { AppError, type ApiScope, ErrorCode } from '@wacrm/shared';
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { RateLimiter } from '../infra/rate-limiter.service';
import type { AuthContext } from '../tenancy/request-context';
import { TokenService } from './token.service';

const KEY_PATTERN = /^wak_([a-f0-9]{16})_[A-Za-z0-9_-]{32,}$/;
const LAST_USED_RESOLUTION_MS = 60_000;

interface KeyRow {
  id: string;
  org_id: string;
  key_hash: string;
  scopes: string[];
  created_by_id: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

export interface ApiKeyRate {
  limit: number;
  remaining: number;
}

const invalid = () => new AppError(ErrorCode.UNAUTHENTICATED, 'Invalid API key');

/** Checks a key from `Authorization: Bearer wak_...`. Keys only work on /v1, and sessions never do. */
@Injectable()
export class ApiKeyAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly limiter: RateLimiter,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /** Every failure reads the same, so a caller learns nothing about which keys exist. */
  async authenticate(
    raw: string | undefined,
    scope: ApiScope,
  ): Promise<{
    auth: AuthContext;
    rate: ApiKeyRate;
  }> {
    const prefix = raw?.match(KEY_PATTERN)?.[1];
    if (!raw || !prefix) throw invalid();

    // Reviewed raw SQL: a definer function, since no org is known until the key is read.
    const [row] = await this.prisma.client.$queryRaw<KeyRow[]>`
      SELECT id, org_id, key_hash, scopes, created_by_id, expires_at, revoked_at, last_used_at
      FROM api_key_lookup(${prefix})`;
    if (!row) throw invalid();
    const given = Buffer.from(this.tokens.hashToken(raw));
    const stored = Buffer.from(row.key_hash);
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) throw invalid();
    if (row.revoked_at) throw invalid();
    if (row.expires_at && row.expires_at <= new Date()) throw invalid();
    // A key acts for whoever made it, for attribution. Without them it has no owner, so it stops.
    if (!row.created_by_id) throw invalid();

    const limit = this.env.API_RATE_LIMIT_PER_MINUTE;
    const used = await this.limiter.hit(`rl:apikey:${row.id}`, 60);
    if (used > limit) {
      throw new AppError(ErrorCode.RATE_LIMITED, 'Too many requests for this API key', {
        retryAfterSeconds: 60,
        limitPerMinute: limit,
      });
    }

    if (!row.scopes.includes(scope)) {
      throw new AppError(ErrorCode.FORBIDDEN, `This API key does not have the ${scope} scope`, {
        missing: [scope],
      });
    }

    const orgId = row.org_id;
    const allowed = await withTenant(this.prisma.client, { orgId }, async (tx) => {
      const org = await tx.organization.findUnique({
        where: { id: orgId },
        select: { status: true, deletedAt: true },
      });
      // A deleted workspace's keys are simply invalid. A suspended one says why.
      if (!org || org.deletedAt) throw invalid();
      if (org.status === 'suspended') {
        throw new AppError(ErrorCode.ORG_SUSPENDED, 'This workspace is suspended');
      }
      const ok = await hasFeature(tx, orgId, 'public_api');
      // Not on every request: it would mean a write for each read.
      const stale = new Date(Date.now() - LAST_USED_RESOLUTION_MS);
      if (ok && (!row.last_used_at || row.last_used_at < stale)) {
        await tx.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
      }
      return ok;
    });
    if (!allowed) {
      throw new AppError(
        ErrorCode.PLAN_FEATURE_UNAVAILABLE,
        'The public API is not on this workspace’s plan',
        { feature: 'public_api' },
      );
    }

    return {
      auth: {
        userId: row.created_by_id,
        orgId,
        // What the services need to run. Access is decided by the key's scopes, not this role.
        role: 'admin',
        apiKeyId: row.id,
      },
      rate: { limit, remaining: Math.max(0, limit - used) },
    };
  }
}
