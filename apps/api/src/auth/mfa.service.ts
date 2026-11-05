import { Inject, Injectable } from '@nestjs/common';
import { withDbContext } from '@wacrm/db';
import { AppError, ErrorCode, type TotpSetupResponse } from '@wacrm/shared';
import { generateTotpSecret, SecretBox, totpAad, totpUri, verifyTotp } from '@wacrm/shared/server';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { RateLimiter } from '../infra/rate-limiter.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

/** Optional TOTP 2FA. The secret is stored envelope-encrypted, bound to the user row. */
@Injectable()
export class MfaService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBox,
    private readonly passwords: PasswordService,
    private readonly rateLimiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  /** Generate a new (not yet active) secret. Re-running replaces a pending secret. */
  async setup(userId: string): Promise<TotpSetupResponse> {
    const secret = generateTotpSecret();
    const email = await withDbContext(this.prisma.client, { userId }, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true, totpEnabledAt: true },
      });
      if (user.totpEnabledAt)
        throw new AppError(ErrorCode.MFA_ALREADY_ENABLED, '2FA is already enabled');
      await tx.user.update({
        where: { id: userId },
        data: { totpSecretEnc: this.secrets.encrypt(secret, totpAad(userId)), totpLastStep: null },
      });
      return user.email;
    });
    return { secret, otpauthUrl: totpUri({ secret, account: email, issuer: this.env.APP_NAME }) };
  }

  /** Confirm the authenticator works, then turn 2FA on. */
  async enable(userId: string, code: string, meta: RequestMeta): Promise<void> {
    await this.rateLimiter.consume(`rl:mfa-enable:user:${userId}`, 10, 900);
    await withDbContext(this.prisma.client, { userId }, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { totpSecretEnc: true, totpEnabledAt: true },
      });
      if (user.totpEnabledAt)
        throw new AppError(ErrorCode.MFA_ALREADY_ENABLED, '2FA is already enabled');
      if (!user.totpSecretEnc)
        throw new AppError(ErrorCode.MFA_NOT_ENABLED, 'Start 2FA setup first');
      const step = verifyTotp(this.secrets.decrypt(user.totpSecretEnc, totpAad(userId)), code);
      if (step === null) throw new AppError(ErrorCode.MFA_INVALID, 'Invalid code');
      await tx.user.update({
        where: { id: userId },
        data: { totpEnabledAt: new Date(), totpLastStep: step },
      });
    });
    await this.audit.recordForUser(userId, await this.auth.activeOrgIds(userId), {
      action: AuditAction.MFA_ENABLED,
      meta,
    });
  }

  /** Turning 2FA off needs both the password and a current code. */
  async disable(userId: string, password: string, code: string, meta: RequestMeta): Promise<void> {
    await this.rateLimiter.consume(`rl:mfa-disable:user:${userId}`, 5, 900);
    await withDbContext(this.prisma.client, { userId }, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { passwordHash: true, totpSecretEnc: true, totpEnabledAt: true },
      });
      if (!user.totpEnabledAt || !user.totpSecretEnc) {
        throw new AppError(ErrorCode.MFA_NOT_ENABLED, '2FA is not enabled');
      }
      if (!(await this.passwords.verify(user.passwordHash, password))) {
        throw new AppError(ErrorCode.INVALID_CREDENTIALS, 'Incorrect password');
      }
      if (verifyTotp(this.secrets.decrypt(user.totpSecretEnc, totpAad(userId)), code) === null) {
        throw new AppError(ErrorCode.MFA_INVALID, 'Invalid code');
      }
      await tx.user.update({
        where: { id: userId },
        data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null },
      });
    });
    await this.audit.recordForUser(userId, await this.auth.activeOrgIds(userId), {
      action: AuditAction.MFA_DISABLED,
      meta,
    });
  }
}
