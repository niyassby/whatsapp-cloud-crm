/**
 * Phase 4.4 jobs: data exports and erasure, the end of a workspace's deletion grace period,
 * expiring export files, and retention. Queue `privacy` (concurrency 1, its own).
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import {
  contactExport,
  eraseContact,
  expireOldMessages,
  exportOrgTables,
  PRIVACY_FILE_DAYS,
  softDeleteWorkspaceTx,
  withTenant,
} from '@wacrm/db';
import { identityHash } from '@wacrm/shared/server';
import type { WorkerDeps } from '../deps';

const fileKey = (orgId: string, requestId: string, ext: string) =>
  `orgs/${orgId}/privacy/${requestId}.${ext}`;

async function finish(
  deps: WorkerDeps,
  orgId: string,
  id: string,
  data: { status: string; fileKey?: string; fileSize?: number; error?: string },
) {
  await withTenant(deps.db, { orgId }, (tx) =>
    tx.privacyRequest.update({
      where: { id },
      data: {
        ...data,
        completedAt: new Date(),
        ...(data.fileKey
          ? { expiresAt: new Date(Date.now() + PRIVACY_FILE_DAYS * 86_400_000) }
          : {}),
      },
    }),
  );
  deps.publisher.emit(orgId, 'privacy:updated', { id });
}

/** Run one export or erasure request. Safe to run again: a finished request is left alone. */
export async function runPrivacyRequest(
  deps: WorkerDeps,
  orgId: string,
  requestId: string,
): Promise<string> {
  const request = await withTenant(deps.db, { orgId }, async (tx) => {
    const r = await tx.privacyRequest.findUnique({ where: { id: requestId } });
    if (!r || r.status === 'done' || r.status === 'expired') return null;
    await tx.privacyRequest.update({ where: { id: requestId }, data: { status: 'running' } });
    return r;
  });
  if (!request) return 'skipped';

  try {
    if (request.kind === 'contact_export') {
      const doc = await withTenant(deps.db, { orgId }, (tx) =>
        contactExport(tx, request.contactId as string),
      );
      const bytes = Buffer.from(JSON.stringify(doc, null, 2), 'utf8');
      const key = fileKey(orgId, requestId, 'json');
      await deps.storage.put(key, bytes, 'application/json');
      await finish(deps, orgId, requestId, {
        status: 'done',
        fileKey: key,
        fileSize: bytes.length,
      });
      return 'done';
    }

    if (request.kind === 'contact_erase') {
      if (!deps.identitySecret) throw new Error('No key for erased-number hashes');
      const secret = deps.identitySecret;
      const result = await withTenant(
        deps.db,
        { orgId },
        (tx) =>
          eraseContact(tx, {
            orgId,
            contactId: request.contactId as string,
            hash: (v) => identityHash(secret, orgId, v),
          }),
        { timeout: 120_000 },
      );
      // Files only after the database change has committed; a failed delete is retried by the
      // job, and the keys are already gone from every row.
      for (const key of result.mediaKeys) await deps.storage.delete(key);
      await finish(deps, orgId, requestId, { status: 'done' });
      return 'done';
    }

    if (request.kind === 'org_export') {
      // Streamed to a temporary file and uploaded from disk: a workspace can be large.
      const dir = await mkdtemp(path.join(tmpdir(), 'wacrm-export-'));
      const file = path.join(dir, 'export.ndjson.gz');
      try {
        const gzip = createGzip();
        const out = gzip.pipe(createWriteStream(file));
        await exportOrgTables(
          (fn) => withTenant(deps.db, { orgId }, fn, { timeout: 120_000 }),
          (lines) =>
            new Promise<void>((resolve) => {
              if (gzip.write(lines)) resolve();
              else gzip.once('drain', resolve);
            }),
        );
        await new Promise<void>((resolve, reject) => {
          out.on('finish', resolve);
          out.on('error', reject);
          gzip.end();
        });
        const key = fileKey(orgId, requestId, 'ndjson.gz');
        await deps.storage.putFile(key, file, 'application/gzip');
        const { size } = await stat(file);
        await finish(deps, orgId, requestId, { status: 'done', fileKey: key, fileSize: size });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return 'done';
    }
    throw new Error(`Unknown request kind ${request.kind}`);
  } catch (err) {
    await finish(deps, orgId, requestId, {
      status: 'failed',
      error: String(err instanceof Error ? err.message : err).slice(0, 500),
    });
    throw err;
  }
}

/**
 * The daily privacy pass: workspaces past their deletion grace period are soft-deleted, export
 * files past their week are removed, and retention periods are applied.
 */
export async function runPrivacyTick(
  deps: WorkerDeps,
  opts: { logRetentionDays: number },
  now = new Date(),
): Promise<{
  deleted: number;
  purged: number;
  expired: number;
  messages: number;
  logs: number;
}> {
  let deleted = 0;
  for (const { org_id } of await deps.db.$queryRaw<{ org_id: string }[]>`
      SELECT org_id FROM privacy_due_org_deletions(${now}::timestamptz)`) {
    await withTenant(deps.db, { orgId: org_id }, async (tx) => {
      const result = await softDeleteWorkspaceTx(
        tx,
        org_id,
        'Workspace deleted at the owner’s request',
      );
      await tx.auditLog.create({
        data: {
          orgId: org_id,
          action: 'privacy.org_deleted',
          targetType: 'organization',
          targetId: org_id,
          metadata: result,
        },
      });
    });
    deleted++;
  }

  // A week after the soft delete, the data goes: files first, then the organization row, which
  // takes every tenant row with it through the cascading keys. The policy on organizations
  // allows this delete only for such a workspace, in its own context.
  let purged = 0;
  for (const { org_id } of await deps.db.$queryRaw<{ org_id: string }[]>`
      SELECT org_id FROM privacy_due_org_purges(${now}::timestamptz)`) {
    await deps.storage.deletePrefix(`orgs/${org_id}/`);
    const removed = await withTenant(
      deps.db,
      { orgId: org_id },
      (tx) => tx.$executeRaw`DELETE FROM organizations WHERE id = ${org_id}::uuid`,
      { timeout: 600_000 },
    );
    purged += removed;
  }

  let expired = 0;
  for (const r of await deps.db.$queryRaw<{ id: string; org_id: string }[]>`
      SELECT id, org_id FROM privacy_expired_requests(${now}::timestamptz, 500)`) {
    const row = await withTenant(deps.db, { orgId: r.org_id }, (tx) =>
      tx.privacyRequest.findUnique({ where: { id: r.id }, select: { fileKey: true } }),
    );
    if (row?.fileKey) await deps.storage.delete(row.fileKey);
    await withTenant(deps.db, { orgId: r.org_id }, (tx) =>
      tx.privacyRequest.update({ where: { id: r.id }, data: { status: 'expired', fileKey: null } }),
    );
    expired++;
  }

  let messages = 0;
  for (const t of await deps.db.$queryRaw<{ org_id: string; days: number }[]>`
      SELECT org_id, days FROM retention_targets()`) {
    for (;;) {
      const batch = await withTenant(deps.db, { orgId: t.org_id }, (tx) =>
        expireOldMessages(tx, t.days),
      );
      for (const key of batch.mediaKeys) await deps.storage.delete(key);
      messages += batch.messages;
      if (batch.messages < 5000) break;
    }
  }

  let logs = 0;
  const cutoff = new Date(now.getTime() - opts.logRetentionDays * 86_400_000);
  for (;;) {
    const [counts] = await deps.db.$queryRaw<{ ai_logs: number; flow_steps: number }[]>`
      SELECT * FROM retention_blank_old(${cutoff}::timestamptz, 5000)`;
    const n = (counts?.ai_logs ?? 0) + (counts?.flow_steps ?? 0);
    logs += n;
    if (n === 0) break;
  }
  return { deleted, purged, expired, messages, logs };
}
