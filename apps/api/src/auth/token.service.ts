import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type TenantTx, withDbContext } from '@wacrm/db';
import { AppError, ErrorCode } from '@wacrm/shared';
import { generateOpaqueToken, hashOpaqueToken } from '@wacrm/shared/server';
import jwt from 'jsonwebtoken';
import type { RequestMeta } from '../common/request-meta';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';

const ISSUER = 'wacrm';
const ACCESS_AUDIENCE = 'wacrm:access';
const MFA_AUDIENCE = 'wacrm:mfa';
const MFA_TTL_SECONDS = 300;

export interface AccessClaims {
  /** user id */
  sub: string;
  /** selected org id, absent when the user has no org */
  org?: string;
  /** session (refresh-token family) id */
  sid: string;
  /** expiry, seconds since the epoch (set on verified tokens) */
  exp?: number;
}

export interface RefreshLookupRow {
  id: string;
  user_id: string;
  family_id: string;
  org_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by_id: string | null;
}

export type RevokeReason = 'rotated' | 'logout' | 'reuse_detected' | 'password_reset';

@Injectable()
export class TokenService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
  ) {}

  get accessTtlSeconds(): number {
    return this.env.ACCESS_TOKEN_TTL_SECONDS;
  }

  get refreshTtlSeconds(): number {
    return this.env.REFRESH_TOKEN_TTL_DAYS * 86_400;
  }

  // ------------------------------------------------------------- access + mfa JWTs

  signAccess(claims: AccessClaims): string {
    const payload: Record<string, string> = { sid: claims.sid };
    if (claims.org) payload.org = claims.org;
    return jwt.sign(payload, this.env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      subject: claims.sub,
      issuer: ISSUER,
      audience: ACCESS_AUDIENCE,
      expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
      jwtid: randomUUID(),
    });
  }

  verifyAccess(token: string): AccessClaims {
    const payload = this.verify(token, ACCESS_AUDIENCE);
    const sid = payload.sid;
    const org = payload.org;
    if (typeof payload.sub !== 'string' || typeof sid !== 'string') {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Invalid access token');
    }
    return {
      sub: payload.sub,
      sid,
      org: typeof org === 'string' ? org : undefined,
      exp: payload.exp,
    };
  }

  /** Short-lived proof that the password step passed; exchanged with a TOTP code. */
  signMfa(userId: string): string {
    return jwt.sign({}, this.env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      subject: userId,
      issuer: ISSUER,
      audience: MFA_AUDIENCE,
      expiresIn: MFA_TTL_SECONDS,
    });
  }

  verifyMfa(token: string): string {
    const payload = this.verify(token, MFA_AUDIENCE, ErrorCode.MFA_INVALID);
    if (typeof payload.sub !== 'string')
      throw new AppError(ErrorCode.MFA_INVALID, 'Invalid MFA token');
    return payload.sub;
  }

  private verify(
    token: string,
    audience: string,
    code:
      typeof ErrorCode.UNAUTHENTICATED | typeof ErrorCode.MFA_INVALID = ErrorCode.UNAUTHENTICATED,
  ): jwt.JwtPayload {
    try {
      const payload = jwt.verify(token, this.env.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience,
      });
      if (typeof payload === 'string') throw new Error('unexpected string payload');
      return payload;
    } catch {
      throw new AppError(code, 'Invalid or expired token');
    }
  }

  // ------------------------------------------------------------- opaque tokens

  hashToken(raw: string): string {
    return hashOpaqueToken(raw, this.env.JWT_REFRESH_SECRET);
  }

  /** New random token plus the hash to store. */
  newOpaqueToken(): { raw: string; hash: string } {
    const raw = generateOpaqueToken();
    return { raw, hash: this.hashToken(raw) };
  }

  // ------------------------------------------------------------- refresh tokens

  /** Create a refresh token inside a transaction whose context has app.user_id = userId. */
  async issueRefresh(
    tx: TenantTx,
    opts: { userId: string; orgId: string | null; familyId?: string; meta?: RequestMeta },
  ): Promise<{ raw: string; id: string; familyId: string }> {
    const { raw, hash } = this.newOpaqueToken();
    const familyId = opts.familyId ?? randomUUID();
    const row = await tx.refreshToken.create({
      data: {
        userId: opts.userId,
        familyId,
        tokenHash: hash,
        orgId: opts.orgId,
        expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000),
        ip: opts.meta?.ip ?? null,
        userAgent: opts.meta?.userAgent ?? null,
      },
      select: { id: true },
    });
    return { raw, id: row.id, familyId };
  }

  /** Pre-auth lookup through the SECURITY DEFINER function. */
  async lookupRefresh(raw: string): Promise<RefreshLookupRow | null> {
    const rows = await this.prisma.client.$queryRaw<RefreshLookupRow[]>`
      SELECT * FROM auth_lookup_refresh_token(${this.hashToken(raw)})`;
    return rows[0] ?? null;
  }

  /**
   * Rotate a refresh token. Reuse of an already rotated or revoked token revokes the whole
   * family and throws REFRESH_REUSE_DETECTED (the caller audits it).
   */
  async rotate(
    raw: string,
    resolveOrg: (tx: TenantTx, userId: string, orgId: string | null) => Promise<string | null>,
    meta?: RequestMeta,
  ): Promise<{ userId: string; familyId: string; orgId: string | null; raw: string }> {
    const found = await this.lookupRefresh(raw);
    if (!found) throw new AppError(ErrorCode.SESSION_INVALID, 'Session expired. Log in again.');

    const result = await withDbContext(
      this.prisma.client,
      { userId: found.user_id },
      async (tx) => {
        // Serialise concurrent refreshes of the same token.
        const [current] = await tx.$queryRaw<
          { revoked_at: Date | null; revoked_reason: string | null; expires_at: Date }[]
        >`
        SELECT revoked_at, revoked_reason, expires_at
        FROM refresh_tokens WHERE id = ${found.id}::uuid FOR UPDATE`;
        if (!current) return { kind: 'invalid' as const };
        if (current.revoked_at) {
          // A rotated token presented again means it was copied: kill the whole session.
          if (current.revoked_reason !== 'rotated') return { kind: 'invalid' as const };
          await this.revokeFamilyTx(tx, found.family_id, 'reuse_detected');
          return { kind: 'reuse' as const };
        }
        if (current.expires_at.getTime() <= Date.now()) return { kind: 'invalid' as const };

        const orgId = await resolveOrg(tx, found.user_id, found.org_id);
        const next = await this.issueRefresh(tx, {
          userId: found.user_id,
          orgId,
          familyId: found.family_id,
          meta,
        });
        await tx.refreshToken.update({
          where: { id: found.id },
          data: { revokedAt: new Date(), revokedReason: 'rotated', replacedById: next.id },
        });
        return { kind: 'ok' as const, orgId, raw: next.raw };
      },
    );

    if (result.kind === 'reuse') {
      throw new AppError(ErrorCode.REFRESH_REUSE_DETECTED, 'Session revoked. Log in again.', {
        userId: found.user_id,
      });
    }
    if (result.kind === 'invalid') {
      throw new AppError(ErrorCode.SESSION_INVALID, 'Session expired. Log in again.');
    }
    return {
      userId: found.user_id,
      familyId: found.family_id,
      orgId: result.orgId,
      raw: result.raw,
    };
  }

  async revokeFamilyTx(tx: TenantTx, familyId: string, reason: RevokeReason): Promise<void> {
    await tx.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeAllForUserTx(tx: TenantTx, userId: string, reason: RevokeReason): Promise<void> {
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }
}
