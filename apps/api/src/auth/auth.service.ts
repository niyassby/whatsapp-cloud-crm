import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type TenantTx, withDbContext, withTenant } from '@wacrm/db';
import {
  AppError,
  type AuthTokensResponse,
  ErrorCode,
  type LoginInput,
  type LoginResponse,
  type MeResponse,
  type OrgSummary,
  type ResetPasswordInput,
  rolePermissions,
  type SignupInput,
} from '@wacrm/shared';
import { SecretBox, totpAad, verifyTotp } from '@wacrm/shared/server';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { MAILER, type Mailer, type MailMessage } from '../infra/mailer';
import { RateLimiter } from '../infra/rate-limiter.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { resetPasswordMail, verifyEmailMail } from './mail-templates';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const EMAIL_VERIFICATION_TTL_MS = 24 * 3600_000;
const PASSWORD_RESET_TTL_MS = 3600_000;
const LOGIN_WINDOW_S = 15 * 60;
const LOGIN_MAX_FAILS_PER_EMAIL = 5;
const LOGIN_MAX_PER_IP = 30;

export interface UserLookupRow {
  id: string;
  password_hash: string;
  status: 'active' | 'disabled';
  totp_enabled: boolean;
}

/** Tokens to hand back to the controller: access token in the body, refresh in a cookie. */
export interface SessionTokens extends AuthTokensResponse {
  refreshToken: string;
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'org'}-${randomBytes(3).toString('hex')}`;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordService,
    private readonly rateLimiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly secrets: SecretBox,
    private readonly realtime: RealtimeGateway,
  ) {}

  // ------------------------------------------------------------------ signup

  async signup(input: SignupInput, meta: RequestMeta): Promise<SessionTokens> {
    await this.rateLimiter.consume(`rl:signup:ip:${meta.ip}`, 10, 3600);
    if (await this.lookupUserByEmail(input.email)) {
      throw new AppError(ErrorCode.EMAIL_TAKEN, 'An account with this email already exists');
    }

    const userId = randomUUID();
    const orgId = randomUUID();
    const passwordHash = await this.passwords.hash(input.password);
    const verify = this.tokens.newOpaqueToken();

    let refresh: { raw: string; familyId: string };
    try {
      refresh = await withTenant(this.prisma.client, { orgId, userId }, async (tx) => {
        await tx.user.create({
          data: {
            id: userId,
            email: input.email,
            name: input.name,
            passwordHash,
            lastLoginAt: new Date(),
          },
        });
        await tx.organization.create({
          data: { id: orgId, name: input.orgName, slug: slugify(input.orgName) },
        });
        await tx.membership.create({ data: { orgId, userId, role: 'owner' } });
        await tx.authToken.create({
          data: {
            userId,
            type: 'email_verification',
            tokenHash: verify.hash,
            expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
          },
        });
        await this.audit.record(tx, orgId, {
          action: AuditAction.SIGNUP,
          actorUserId: userId,
          targetType: 'organization',
          targetId: orgId,
          meta,
        });
        return this.tokens.issueRefresh(tx, { userId, orgId, meta });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(ErrorCode.EMAIL_TAKEN, 'An account with this email already exists');
      }
      throw err;
    }

    this.sendMail(
      verifyEmailMail(this.env.APP_NAME, input.email, this.link('/verify-email', verify.raw)),
    );
    return this.sessionTokens(userId, orgId, refresh);
  }

  // ------------------------------------------------------------------ login

  async login(
    input: LoginInput,
    meta: RequestMeta,
  ): Promise<LoginResponse & Partial<SessionTokens>> {
    const emailKey = `rl:login:email:${input.email}`;
    await this.rateLimiter.consume(`rl:login:ip:${meta.ip}`, LOGIN_MAX_PER_IP, LOGIN_WINDOW_S);
    await this.rateLimiter.assertNotBlocked(emailKey, LOGIN_MAX_FAILS_PER_EMAIL);

    const user = await this.lookupUserByEmail(input.email);
    const ok = await this.passwords.verify(user?.password_hash, input.password);
    if (!user || !ok) {
      await this.rateLimiter.hit(emailKey, LOGIN_WINDOW_S);
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, 'Incorrect email or password');
    }
    if (user.status !== 'active')
      throw new AppError(ErrorCode.ACCOUNT_DISABLED, 'Account disabled');
    await this.rateLimiter.reset(emailKey);

    if (user.totp_enabled) return { mfaRequired: true, mfaToken: this.tokens.signMfa(user.id) };
    return this.startSession(user.id, meta, AuditAction.LOGIN);
  }

  async verifyMfa(mfaToken: string, code: string, meta: RequestMeta): Promise<SessionTokens> {
    const userId = this.tokens.verifyMfa(mfaToken);
    const key = `rl:mfa:user:${userId}`;
    await this.rateLimiter.assertNotBlocked(key, 5);

    const ok = await withDbContext(this.prisma.client, { userId }, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { totpSecretEnc: true, totpEnabledAt: true, totpLastStep: true, status: true },
      });
      if (!user?.totpSecretEnc || !user.totpEnabledAt || user.status !== 'active') return false;
      const step = verifyTotp(this.secrets.decrypt(user.totpSecretEnc, totpAad(userId)), code);
      // Reject replays: each time step can be used once.
      if (step === null || (user.totpLastStep !== null && step <= user.totpLastStep)) return false;
      await tx.user.update({ where: { id: userId }, data: { totpLastStep: step } });
      return true;
    });
    if (!ok) {
      await this.rateLimiter.hit(key, LOGIN_WINDOW_S);
      throw new AppError(ErrorCode.MFA_INVALID, 'Invalid code');
    }
    await this.rateLimiter.reset(key);
    return this.startSession(userId, meta, AuditAction.LOGIN_MFA);
  }

  /** Start a new session (refresh family) in the user's first active org. */
  async startSession(
    userId: string,
    meta: RequestMeta,
    action: AuditAction,
    preferOrgId?: string,
  ): Promise<SessionTokens> {
    const orgId = await withDbContext(this.prisma.client, { userId }, async (tx) => {
      const preferred = preferOrgId
        ? await tx.membership.findFirst({ where: { userId, orgId: preferOrgId, status: 'active' } })
        : null;
      const first =
        preferred ??
        (await tx.membership.findFirst({
          where: { userId, status: 'active' },
          orderBy: { createdAt: 'asc' },
        }));
      return first?.orgId ?? null;
    });

    const refresh = await withDbContext(
      this.prisma.client,
      { userId, orgId: orgId ?? undefined },
      async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
        if (orgId) await this.audit.record(tx, orgId, { action, actorUserId: userId, meta });
        return this.tokens.issueRefresh(tx, { userId, orgId, meta });
      },
    );
    return this.sessionTokens(userId, orgId, refresh);
  }

  // ------------------------------------------------------------------ sessions

  async refresh(rawRefresh: string, meta: RequestMeta): Promise<SessionTokens> {
    try {
      const rotated = await this.tokens.rotate(
        rawRefresh,
        // Keep the session's org only while the membership is still active.
        async (tx: TenantTx, userId, orgId) => {
          if (!orgId) return null;
          await tx.$queryRaw`SELECT set_config('app.org_id', ${orgId}, true)`;
          const m = await tx.membership.findUnique({ where: { orgId_userId: { orgId, userId } } });
          return m?.status === 'active' ? orgId : null;
        },
        meta,
      );
      return this.sessionTokens(rotated.userId, rotated.orgId, {
        raw: rotated.raw,
        familyId: rotated.familyId,
      });
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.REFRESH_REUSE_DETECTED) {
        const userId = String(err.details?.userId);
        this.logger.warn(`refresh token reuse detected for user ${userId}; session revoked`);
        await this.audit.recordForUser(userId, await this.activeOrgIds(userId), {
          action: AuditAction.REFRESH_REUSE_DETECTED,
          meta,
        });
        throw new AppError(ErrorCode.REFRESH_REUSE_DETECTED, err.message);
      }
      throw err;
    }
  }

  async logout(rawRefresh: string | undefined): Promise<void> {
    if (!rawRefresh) return;
    const found = await this.tokens.lookupRefresh(rawRefresh);
    if (!found) return;
    await withDbContext(this.prisma.client, { userId: found.user_id }, (tx) =>
      this.tokens.revokeFamilyTx(tx, found.family_id, 'logout'),
    );
    this.realtime.disconnectSession(found.family_id);
  }

  async switchOrg(userId: string, sessionId: string, orgId: string): Promise<AuthTokensResponse> {
    const ok = await withTenant(this.prisma.client, { orgId, userId }, async (tx) => {
      const m = await tx.membership.findUnique({ where: { orgId_userId: { orgId, userId } } });
      if (m?.status !== 'active') return false;
      // Remember the org on the session so refreshes keep it.
      await tx.refreshToken.updateMany({
        where: { familyId: sessionId, revokedAt: null },
        data: { orgId },
      });
      return true;
    });
    if (!ok) throw new AppError(ErrorCode.FORBIDDEN, 'You are not a member of this organization');
    return {
      accessToken: this.tokens.signAccess({ sub: userId, org: orgId, sid: sessionId }),
      expiresIn: this.tokens.accessTtlSeconds,
    };
  }

  async me(userId: string, currentOrgId: string | undefined): Promise<MeResponse> {
    const { user, memberships } = await withDbContext(
      this.prisma.client,
      { userId },
      async (tx) => ({
        user: await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { id: true, email: true, name: true, emailVerifiedAt: true, totpEnabledAt: true },
        }),
        memberships: await tx.membership.findMany({
          where: { userId, status: 'active', organization: { deletedAt: null } },
          orderBy: { createdAt: 'asc' },
          select: { role: true, organization: { select: { id: true, name: true, slug: true } } },
        }),
      }),
    );
    const orgs: OrgSummary[] = memberships.map((m) => ({ ...m.organization, role: m.role }));
    const currentOrg = orgs.find((o) => o.id === currentOrgId) ?? null;
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerifiedAt !== null,
        totpEnabled: user.totpEnabledAt !== null,
      },
      orgs,
      currentOrg,
      permissions: currentOrg ? [...rolePermissions[currentOrg.role]] : [],
    };
  }

  // ------------------------------------------------------------------ email verification

  async verifyEmail(rawToken: string): Promise<void> {
    const token = await this.consumeAuthToken(
      rawToken,
      'email_verification',
      async (tx, userId) => {
        await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
      },
    );
    await this.audit.recordForUser(token.userId, await this.activeOrgIds(token.userId), {
      action: AuditAction.EMAIL_VERIFIED,
    });
  }

  async resendVerification(userId: string): Promise<void> {
    await this.rateLimiter.consume(`rl:verify-resend:user:${userId}`, 3, 3600);
    const verify = this.tokens.newOpaqueToken();
    const email = await withDbContext(this.prisma.client, { userId }, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true, emailVerifiedAt: true },
      });
      if (user.emailVerifiedAt) return null;
      await tx.authToken.updateMany({
        where: { userId, type: 'email_verification', usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.authToken.create({
        data: {
          userId,
          type: 'email_verification',
          tokenHash: verify.hash,
          expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
        },
      });
      return user.email;
    });
    if (email)
      this.sendMail(
        verifyEmailMail(this.env.APP_NAME, email, this.link('/verify-email', verify.raw)),
      );
  }

  // ------------------------------------------------------------------ password reset

  /** Always succeeds from the caller's point of view (no account enumeration). */
  async forgotPassword(email: string, meta: RequestMeta): Promise<void> {
    await this.rateLimiter.consume(`rl:forgot:ip:${meta.ip}`, 10, 3600);
    await this.rateLimiter.consume(`rl:forgot:email:${email}`, 3, 3600);
    const user = await this.lookupUserByEmail(email);
    if (!user || user.status !== 'active') return;

    const reset = this.tokens.newOpaqueToken();
    await withDbContext(this.prisma.client, { userId: user.id }, async (tx) => {
      // Only the newest link works.
      await tx.authToken.updateMany({
        where: { userId: user.id, type: 'password_reset', usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.authToken.create({
        data: {
          userId: user.id,
          type: 'password_reset',
          tokenHash: reset.hash,
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
        },
      });
    });
    this.sendMail(
      resetPasswordMail(this.env.APP_NAME, email, this.link('/reset-password', reset.raw)),
    );
  }

  /** Sets the new password and signs out every session. */
  async resetPassword(input: ResetPasswordInput, meta: RequestMeta): Promise<void> {
    await this.rateLimiter.consume(`rl:reset:ip:${meta.ip}`, 20, 3600);
    const passwordHash = await this.passwords.hash(input.password);
    const token = await this.consumeAuthToken(input.token, 'password_reset', async (tx, userId) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: new Date() },
      });
      await this.tokens.revokeAllForUserTx(tx, userId, 'password_reset');
    });
    this.realtime.disconnectUser(token.userId);
    await this.audit.recordForUser(token.userId, await this.activeOrgIds(token.userId), {
      action: AuditAction.PASSWORD_RESET,
      meta,
    });
  }

  // ------------------------------------------------------------------ helpers

  async lookupUserByEmail(email: string): Promise<UserLookupRow | null> {
    const rows = await this.prisma.client.$queryRaw<UserLookupRow[]>`
      SELECT * FROM auth_lookup_user_by_email(${email})`;
    return rows[0] ?? null;
  }

  async activeOrgIds(userId: string): Promise<string[]> {
    const rows = await withDbContext(this.prisma.client, { userId }, (tx) =>
      tx.membership.findMany({ where: { userId, status: 'active' }, select: { orgId: true } }),
    );
    return rows.map((r) => r.orgId);
  }

  /** Validate a single-use emailed token and apply `fn` atomically with marking it used. */
  private async consumeAuthToken(
    raw: string,
    type: 'email_verification' | 'password_reset',
    fn: (tx: TenantTx, userId: string) => Promise<void>,
  ): Promise<{ userId: string }> {
    const rows = await this.prisma.client.$queryRaw<
      { id: string; user_id: string; expires_at: Date; used_at: Date | null }[]
    >`SELECT * FROM auth_lookup_auth_token(${this.tokens.hashToken(raw)}, ${type}::"AuthTokenType")`;
    const row = rows[0];
    const invalid = new AppError(ErrorCode.TOKEN_INVALID, 'This link is invalid or has expired');
    if (!row || row.used_at || row.expires_at.getTime() <= Date.now()) throw invalid;

    const used = await withDbContext(this.prisma.client, { userId: row.user_id }, async (tx) => {
      // Conditional update = single use even under concurrent requests.
      const claimed = await tx.authToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) return false;
      await fn(tx, row.user_id);
      return true;
    });
    if (!used) throw invalid;
    return { userId: row.user_id };
  }

  sessionTokens(
    userId: string,
    orgId: string | null,
    refresh: { raw: string; familyId: string },
  ): SessionTokens {
    return {
      accessToken: this.tokens.signAccess({
        sub: userId,
        org: orgId ?? undefined,
        sid: refresh.familyId,
      }),
      expiresIn: this.tokens.accessTtlSeconds,
      refreshToken: refresh.raw,
    };
  }

  link(path: string, token: string): string {
    return `${this.env.WEB_URL}${path}?token=${encodeURIComponent(token)}`;
  }

  /**
   * Send in the background: the HTTP response never waits on SMTP, and failures are always
   * logged (never thrown into the request).
   * TODO: move to a BullMQ queue with retries. These bodies hold one-time links, so job data
   * must be encrypted or hold only a reference, not sit in Redis in plain text.
   */
  sendMail(message: MailMessage): void {
    this.mailer.send(message).catch((err: unknown) => {
      this.logger.error(
        `failed to send "${message.subject}"`,
        err instanceof Error ? err.stack : String(err),
      );
    });
  }
}
