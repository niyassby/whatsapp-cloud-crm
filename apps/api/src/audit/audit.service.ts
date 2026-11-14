import { Injectable } from '@nestjs/common';
import { Prisma, type TenantTx, withTenant } from '@wacrm/db';
import type { RequestMeta } from '../common/request-meta';
import { PrismaService } from '../db/prisma.service';
import { requestContext } from '../tenancy/request-context';

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
  WHATSAPP_CONNECTED: 'whatsapp.connected',
  WHATSAPP_DISCONNECTED: 'whatsapp.disconnected',
  WHATSAPP_REGISTERED: 'whatsapp.registered',
  WEBHOOK_REPLAYED: 'whatsapp.webhook_replayed',
  CONTACT_CONSENT_CHANGED: 'contact.consent_changed',
  CONTACT_DELETED: 'contact.deleted',
  CONTACTS_MERGED: 'contact.merged',
  CONTACTS_BULK_CHANGED: 'contact.bulk_changed',
  CONTACTS_IMPORT_STARTED: 'contact.import_started',
  CONTACTS_EXPORT_STARTED: 'contact.export_started',
  CONTACTS_EXPORT_DOWNLOADED: 'contact.export_downloaded',
  OPT_OUT_KEYWORDS_CHANGED: 'contact.opt_out_keywords_changed',
  TEMPLATE_SUBMITTED: 'template.submitted',
  TEMPLATE_DELETED: 'template.deleted',
  WALLET_SETTINGS_CHANGED: 'wallet.settings_changed',
  WALLET_EXPORTED: 'wallet.exported',
  BILLING_PROFILE_CHANGED: 'billing.profile_changed',
  BILLING_CHECKOUT_STARTED: 'billing.checkout_started',
  BILLING_CANCEL_REQUESTED: 'billing.cancel_requested',
  WALLET_TOPUP_STARTED: 'wallet.topup_started',
  AUTOMATION_CHANGED: 'automation.changed',
  FLOW_CHANGED: 'flow.changed',
  INTEGRATION_CHANGED: 'integration.changed',
  AI_CHANGED: 'ai.changed',
  REPORT_EXPORTED: 'report.exported',
  REPORT_SCHEDULE_CHANGED: 'report_schedule.changed',
  API_KEY_CREATED: 'api_key.created',
  API_KEY_REVOKED: 'api_key.revoked',
  WEBHOOK_ENDPOINT_CREATED: 'webhook_endpoint.created',
  WEBHOOK_ENDPOINT_CHANGED: 'webhook_endpoint.changed',
  WEBHOOK_ENDPOINT_DELETED: 'webhook_endpoint.deleted',
  WEBHOOK_SECRET_ROTATED: 'webhook_endpoint.secret_rotated',
  WEBHOOK_DELIVERY_REPLAYED: 'webhook_delivery.replayed',
  CAMPAIGN_LAUNCHED: 'campaign.launched',
  CAMPAIGN_PAUSED: 'campaign.paused',
  CAMPAIGN_RESUMED: 'campaign.resumed',
  CAMPAIGN_CANCELLED: 'campaign.cancelled',
  IMPERSONATION_STARTED: 'impersonation.started',
  IMPERSONATION_ENDED: 'impersonation.ended',
  CLIENT_CREATED: 'partner.client_created',
  CLIENT_CHANGED: 'partner.client_changed',
  CLIENT_SUSPENDED: 'partner.client_suspended',
  CLIENT_RESUMED: 'partner.client_resumed',
  CLIENT_DELETED: 'partner.client_deleted',
  WALLET_CREDITED: 'wallet.credited',
  PLAN_SET: 'billing.plan_set',
  CHANNEL_CHANGED: 'channel.changed',
  QR_CODE_CHANGED: 'qr_code.changed',
  GROUP_CHANGED: 'group.changed',
  CALLING_CHANGED: 'calling.changed',
  CATALOG_SYNCED: 'catalog.synced',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  action: AuditAction;
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
  meta?: RequestMeta;
  /** Only needed where the request context does not already carry it (starting a session). */
  impersonationId?: string;
}

export const PlatformAuditAction = {
  PARTNER_CREATED: 'partner.created',
  PARTNER_CHANGED: 'partner.changed',
  PARTNER_MEMBER_ADDED: 'partner.member_added',
  PARTNER_MEMBER_REMOVED: 'partner.member_removed',
  PARTNER_MARKUP_CHANGED: 'partner.markup_changed',
  PLAN_CHANGED: 'plan.changed',
  WHOLESALE_PRICE_CHANGED: 'plan.wholesale_price_changed',
  RATE_CARD_ADDED: 'rate_card.added',
  STATEMENT_CLOSED: 'statement.closed',
  STATEMENT_PAID: 'statement.paid',
  ORG_SUSPENDED: 'org.suspended',
  ORG_RESUMED: 'org.resumed',
} as const;
export type PlatformAuditAction = (typeof PlatformAuditAction)[keyof typeof PlatformAuditAction];

export interface PlatformAuditEntry {
  action: PlatformAuditAction;
  actorUserId: string;
  partnerId?: string | null;
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
        // Everything done while impersonating is marked, without each caller having to remember.
        impersonationId: entry.impersonationId ?? requestContext.get()?.impersonationId ?? null,
      },
    });
  }

  /**
   * Partner and platform actions that belong to no one workspace (a partner created, a plan or
   * rate changed, a statement paid). Needs the partner's or a platform admin's context.
   */
  async recordPlatform(tx: TenantTx, entry: PlatformAuditEntry): Promise<void> {
    await tx.platformAuditLog.createMany({
      data: [
        {
          actorUserId: entry.actorUserId,
          partnerId: entry.partnerId ?? null,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          metadata: entry.metadata ?? Prisma.JsonNull,
          ip: entry.meta?.ip ?? null,
        },
      ],
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
