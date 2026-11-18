import { Inject, Injectable } from '@nestjs/common';
import { ORG_DELETION_GRACE_DAYS, type PrivacyKind, type TenantTx } from '@wacrm/db';
import {
  AppError,
  ErrorCode,
  type PrivacyRequestDto,
  type PrivacySettingsDto,
} from '@wacrm/shared';
import type { ObjectStorage } from '@wacrm/shared/server';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { OBJECT_STORAGE } from '../infra/infra.tokens';
import { QueuesService } from '../infra/queues.service';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

export interface PrivacyActor {
  orgId: string;
  userId: string;
  meta?: RequestMeta;
}

type RequestRow = Awaited<ReturnType<TenantTx['privacyRequest']['findUniqueOrThrow']>>;

const toDto = (r: RequestRow): PrivacyRequestDto => ({
  id: r.id,
  kind: r.kind as PrivacyKind,
  contactId: r.contactId,
  status: r.status as PrivacyRequestDto['status'],
  fileSize: r.fileSize,
  error: r.error,
  createdAt: r.createdAt.toISOString(),
  completedAt: r.completedAt?.toISOString() ?? null,
  expiresAt: r.expiresAt?.toISOString() ?? null,
});

const AUDIT_FOR: Record<PrivacyKind, AuditAction> = {
  contact_export: AuditAction.PRIVACY_CONTACT_EXPORTED,
  contact_erase: AuditAction.PRIVACY_CONTACT_ERASED,
  org_export: AuditAction.PRIVACY_ORG_EXPORTED,
};

@Injectable()
export class PrivacyService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly queues: QueuesService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** Record the request, audit it, and queue it for the worker. */
  async request(
    actor: PrivacyActor,
    kind: PrivacyKind,
    contactId?: string,
  ): Promise<PrivacyRequestDto> {
    const row = await this.db.run(async (tx) => {
      if (contactId) {
        const contact = await tx.contact.findUnique({
          where: { id: contactId },
          select: { id: true, erasedAt: true },
        });
        if (!contact) throw new AppError(ErrorCode.NOT_FOUND, 'Contact not found');
        if (contact.erasedAt) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, 'This contact has already been erased');
        }
      }
      const created = await tx.privacyRequest.create({
        data: { orgId: actor.orgId, kind, contactId: contactId ?? null, requestedBy: actor.userId },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AUDIT_FOR[kind],
        actorUserId: actor.userId,
        targetType: contactId ? 'contact' : 'organization',
        targetId: contactId ?? actor.orgId,
        metadata: { requestId: created.id },
        meta: actor.meta,
      });
      return created;
    });
    await this.queues.privacy.add(
      'request',
      { kind: 'request', orgId: actor.orgId, requestId: row.id },
      { jobId: `privacy-${row.id}` },
    );
    return toDto(row);
  }

  /** Workspace-wide requests for owners; contact requests for anyone who manages contacts. */
  async list(scope: 'contact' | 'org', contactId?: string): Promise<PrivacyRequestDto[]> {
    const rows = await this.db.run((tx) =>
      tx.privacyRequest.findMany({
        where:
          scope === 'org'
            ? { kind: 'org_export' }
            : {
                kind: { in: ['contact_export', 'contact_erase'] },
                ...(contactId ? { contactId } : {}),
              },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
    return rows.map(toDto);
  }

  /** A 5-minute link to a finished export. Downloads are audited: the file leaves the app. */
  async download(
    actor: PrivacyActor,
    id: string,
    scope: 'contact' | 'org',
  ): Promise<{ url: string }> {
    const row = await this.db.run(async (tx) => {
      const r = await tx.privacyRequest.findUnique({ where: { id } });
      const allowed = scope === 'org' ? r?.kind === 'org_export' : r?.kind === 'contact_export';
      if (!r || !allowed) throw new AppError(ErrorCode.NOT_FOUND, 'Export not found');
      if (r.status !== 'done' || !r.fileKey) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'This export is not ready, or has expired');
      }
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.PRIVACY_REQUEST_DOWNLOADED,
        actorUserId: actor.userId,
        targetType: 'privacy_request',
        targetId: id,
        meta: actor.meta,
      });
      return r;
    });
    const name = row.kind === 'org_export' ? 'workspace-export.ndjson.gz' : 'contact-export.json';
    return {
      url: await this.storage.signedUrl(row.fileKey as string, {
        expiresIn: 300,
        filename: name,
        inline: false,
      }),
    };
  }

  async settings(orgId: string): Promise<PrivacySettingsDto> {
    const org = await this.db.run((tx) =>
      tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { messageRetentionDays: true, deletionRequestedAt: true, purgeAfter: true },
      }),
    );
    return {
      messageRetentionDays: org.messageRetentionDays,
      deletionRequestedAt: org.deletionRequestedAt?.toISOString() ?? null,
      deletesAt: org.purgeAfter?.toISOString() ?? null,
    };
  }

  async setRetention(actor: PrivacyActor, days: number | null): Promise<PrivacySettingsDto> {
    await this.db.run(async (tx) => {
      const before = await tx.organization.findUniqueOrThrow({
        where: { id: actor.orgId },
        select: { messageRetentionDays: true },
      });
      await tx.organization.update({
        where: { id: actor.orgId },
        data: { messageRetentionDays: days },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.PRIVACY_RETENTION_CHANGED,
        actorUserId: actor.userId,
        metadata: { from: before.messageRetentionDays ?? 'forever', to: days ?? 'forever' },
        meta: actor.meta,
      });
    });
    return this.settings(actor.orgId);
  }

  /**
   * Ask to delete the workspace. Nothing goes at once: after the grace period the worker
   * soft-deletes it, and an operator's purge removes the data. The owner can cancel until then.
   */
  async requestDeletion(actor: PrivacyActor, confirmName: string): Promise<PrivacySettingsDto> {
    await this.db.run(async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: actor.orgId },
        select: { name: true, partnerId: true, purgeAfter: true },
      });
      if (org.partnerId) {
        throw new AppError(
          ErrorCode.MANAGED_BY_PARTNER,
          'Your partner manages this workspace; ask them to delete it',
        );
      }
      if (confirmName.trim() !== org.name.trim()) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Type the workspace name to confirm');
      }
      if (org.purgeAfter) return;
      const now = new Date();
      const purgeAfter = new Date(now.getTime() + ORG_DELETION_GRACE_DAYS * 86_400_000);
      await tx.organization.update({
        where: { id: actor.orgId },
        data: { deletionRequestedAt: now, purgeAfter },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.PRIVACY_ORG_DELETION_REQUESTED,
        actorUserId: actor.userId,
        metadata: { deletesAt: purgeAfter.toISOString() },
        meta: actor.meta,
      });
    });
    return this.settings(actor.orgId);
  }

  async cancelDeletion(actor: PrivacyActor): Promise<PrivacySettingsDto> {
    await this.db.run(async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: actor.orgId },
        select: { purgeAfter: true },
      });
      if (!org.purgeAfter) return;
      await tx.organization.update({
        where: { id: actor.orgId },
        data: { deletionRequestedAt: null, purgeAfter: null },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.PRIVACY_ORG_DELETION_CANCELLED,
        actorUserId: actor.userId,
        meta: actor.meta,
      });
    });
    return this.settings(actor.orgId);
  }
}
