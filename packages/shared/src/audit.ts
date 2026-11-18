/**
 * The audit log viewer (Phase 4.4): filters, how actions read, and the CSV export. Shared by the
 * workspace's Settings > Audit log and the platform console.
 */
import { z } from 'zod';
import type { AuditLogDto } from './auth';
import { cursorQuerySchema } from './auth';
import { csvCell } from './contacts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `action` is a whole name (`team.role_changed`) or a group (`team`). */
export const auditQuerySchema = cursorQuerySchema.extend({
  action: z
    .string()
    .regex(/^[a-z_0-9]+(\.[a-z_0-9]+)?$/)
    .optional(),
  actorUserId: z.uuid().optional(),
  /** Days in UTC, both included. */
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
export const auditExportSchema = auditQuerySchema.omit({ cursor: true, limit: true });
export type AuditExportQuery = z.infer<typeof auditExportSchema>;

/** At most this many rows in one export; narrow the dates for more. */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;

/** The `created_at` bounds of a filter: [from 00:00 UTC, the day after `to`). */
export function auditDateBounds(q: { from?: string; to?: string }): { gte?: Date; lt?: Date } {
  return {
    ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}),
    ...(q.to ? { lt: new Date(Date.parse(`${q.to}T00:00:00Z`) + 86_400_000) } : {}),
  };
}

export const AUDIT_GROUPS: Record<string, string> = {
  auth: 'Sign-in and security',
  org: 'Workspace',
  team: 'Team',
  whatsapp: 'WhatsApp',
  contact: 'Contacts',
  template: 'Templates',
  campaign: 'Campaigns',
  wallet: 'Wallet',
  billing: 'Billing',
  api_key: 'API keys',
  webhook_endpoint: 'Webhooks',
  automation: 'Automation',
  flow: 'Flows',
  integration: 'Integrations',
  ai: 'AI assistant',
  channel: 'Channels',
  report: 'Reports',
  privacy: 'Data export and erasure',
  audit: 'Audit log',
  impersonation: 'Outside access',
  partner: 'Partner',
};

export const AUDIT_LABELS: Record<string, string> = {
  'auth.signup': 'Created the workspace',
  'auth.login': 'Logged in',
  'auth.login_mfa': 'Logged in with 2FA',
  'auth.password_reset': 'Reset their password',
  'auth.refresh_reuse_detected': 'Session revoked: token reuse detected',
  'auth.2fa_enabled': 'Turned on 2FA',
  'auth.2fa_disabled': 'Turned off 2FA',
  'auth.email_verified': 'Verified their email',
  'org.created': 'Created the workspace',
  'org.updated': 'Updated workspace settings',
  'team.invite_created': 'Invited a teammate',
  'team.invite_revoked': 'Revoked an invitation',
  'team.invite_accepted': 'Joined via invitation',
  'team.role_changed': 'Changed a role',
  'team.member_removed': 'Removed a member',
  'whatsapp.connected': 'Connected a WhatsApp number',
  'whatsapp.disconnected': 'Disconnected a WhatsApp number',
  'whatsapp.registered': 'Registered a WhatsApp number',
  'whatsapp.webhook_replayed': 'Replayed a webhook event',
  'contact.consent_changed': 'Changed a contact’s consent',
  'contact.deleted': 'Deleted a contact',
  'contact.merged': 'Merged contacts',
  'contact.export_started': 'Started a contact export',
  'contact.export_downloaded': 'Downloaded a contact export',
  'impersonation.started': 'Opened this workspace from outside',
  'impersonation.ended': 'Left this workspace',
  'partner.client_created': 'Created this workspace for a client',
  'partner.client_changed': 'Changed the workspace name or limits',
  'partner.client_suspended': 'Suspended this workspace',
  'partner.client_resumed': 'Restored this workspace',
  'partner.client_deleted': 'Deleted this workspace',
  'wallet.credited': 'Added funds to the wallet',
  'billing.plan_set': 'Set the plan',
  'report.exported': 'Exported a report',
  'report_schedule.changed': 'Changed a scheduled report',
  'audit.exported': 'Exported the audit log',
  'privacy.contact_exported': 'Exported a contact’s data',
  'privacy.contact_erased': 'Erased a contact’s data',
  'privacy.org_exported': 'Exported all workspace data',
  'privacy.org_deletion_requested': 'Asked to delete the workspace',
  'privacy.org_deletion_cancelled': 'Cancelled deleting the workspace',
  'privacy.retention_changed': 'Changed how long data is kept',
  'privacy.org_deleted': 'Deleted the workspace after the waiting period',
  'privacy.request_downloaded': 'Downloaded a data export',
};

export const auditLabel = (action: string) => AUDIT_LABELS[action] ?? action;

/** A short reading of an entry's details for people. */
export function auditDetail(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object') return '';
  const m = metadata as Record<string, unknown>;
  if (m.reason) return `Reason: ${String(m.reason)}`;
  if (m.amount) return String(m.amount) + (m.note ? ` (${String(m.note)})` : '');
  if (m.plan) return String(m.plan);
  if (m.from && m.to) return `${String(m.from)} → ${String(m.to)}`;
  if (m.email) return `${String(m.email)}${m.role ? ` as ${String(m.role)}` : ''}`;
  if (m.role) return String(m.role);
  return Object.entries(m)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ');
}

/** The audit log as CSV. Cells go through `csvCell`, so nothing becomes a formula. */
export function auditToCsv(items: AuditLogDto[]): string {
  const header = [
    'When (UTC)',
    'Who',
    'Outside access',
    'Action',
    'What',
    'Details',
    'Target',
    'IP',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const i of items) {
    lines.push(
      [
        i.createdAt,
        i.actorName ?? (i.impersonated ? 'Outside admin' : 'System'),
        i.impersonated ? 'yes' : '',
        i.action,
        auditLabel(i.action),
        JSON.stringify(i.metadata ?? null),
        i.targetType ? `${i.targetType}:${i.targetId ?? ''}` : '',
        i.ip ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n');
}
