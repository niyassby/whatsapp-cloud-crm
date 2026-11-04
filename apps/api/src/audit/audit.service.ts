import { Injectable } from '@nestjs/common';
import { Prisma, type TenantTx, withTenant } from '@wacrm/db';
import type { RequestMeta } from '../common/request-meta';
import { PrismaService } from '../db/prisma.service';

/** Stable audit action names. Add here; never rename. */
export const AuditAction = {
  SIGNUP: 'auth.signup',
  LOGIN: 'auth.login',
  LOGIN_MFA: 'auth.login_mfa',
  PASSWORD_RESET: 'auth.password_reset',
  REFRESH_REUSE_DETECTED: 'auth.refresh_reuse_detected',
  MFA_ENABLED: 'auth.2fa_enabled',
  MFA_DISABLED: 'auth.2fa_disabled',
  EMAIL_VERIFIED: 'auth.email_verified',
  ORG_CREATED: 'org.created',
  ORG_UPDATED: 'org.updated',
  INVITE_CREATED: 'team.invite_created',
  INVITE_REVOKED: 'team.invite_revoked',
  INVITE_ACCEPTED: 'team.invite_accepted',
  ROLE_CHANGED: 'team.role_changed',
  MEMBER_REMOVED: 'team.member_removed',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  action: AuditAction;
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
  meta?: RequestMeta;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Record inside an existing tenant transaction (preferred: atomic with the change). */
  async record(tx: TenantTx, orgId: string, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        orgId,
        action: entry.action,
        actorUserId: entry.actorUserId ?? null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: entry.metadata ?? Prisma.JsonNull,
        ip: entry.meta?.ip ?? null,
        userAgent: entry.meta?.userAgent ?? null,
      },
    });
  }

  /**
   * User-level security events (password reset, 2FA changes, refresh-token reuse) are written
   * to every org the user actively belongs to, so each org's admins can see them.
   */
  async recordForUser(userId: string, orgIds: string[], entry: AuditEntry): Promise<void> {
    for (const orgId of orgIds) {
      await withTenant(this.prisma.client, { orgId, userId }, (tx) =>
        this.record(tx, orgId, { actorUserId: userId, ...entry }),
      );
    }
  }
}
