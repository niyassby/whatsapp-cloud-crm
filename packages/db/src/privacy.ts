/**
 * Phase 4.4: data export and erasure per contact and per workspace (GDPR and India's DPDP Act),
 * and message retention.
 *
 * Erasure keeps the contact row, opted out and with nothing personal on it, so billing, campaign
 * counts and reports still add up and an opt-out cannot be lost. Message bodies, files, notes,
 * tags, identities, flow and broadcast values go; append-only history (consent proof, AI logs,
 * flow step details) is blanked by the reviewed definer function `privacy_erase_contact_history`.
 * The person's number and email are kept only as a keyed hash in `erased_identities`.
 *
 * Reviewed raw SQL: bound parameters, under the tenant's RLS context. Table names in the export
 * come from the database catalogue, never from input.
 */
import { Prisma } from './generated/prisma/client';
import type { TenantTx } from './tenant';
import { disconnectWabaTx } from './whatsapp';

export const PRIVACY_KINDS = ['contact_export', 'contact_erase', 'org_export'] as const;
export type PrivacyKind = (typeof PRIVACY_KINDS)[number];

/** Export files are kept this long, then deleted. */
export const PRIVACY_FILE_DAYS = 7;
/** An owner can cancel a workspace deletion until this many days after asking. */
export const ORG_DELETION_GRACE_DAYS = 14;

export const ERASED_NAME = 'Erased contact';

/**
 * Erase one contact (and any duplicates merged into it) in the current workspace. Returns the
 * storage keys of their message files, which the caller deletes once the transaction commits.
 * Safe to run again: an erased contact is left alone.
 */
export async function eraseContact(
  tx: TenantTx,
  input: { orgId: string; contactId: string; hash: (value: string) => string },
): Promise<{ mediaKeys: string[]; contacts: number }> {
  const [primary] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM contacts WHERE id = ${input.contactId}::uuid FOR UPDATE`;
  if (!primary) throw new Error('Contact not found');
  const group = await tx.contact.findMany({
    where: { OR: [{ id: input.contactId }, { mergedIntoId: input.contactId }], erasedAt: null },
    select: { id: true, waId: true, email: true },
  });
  if (group.length === 0) return { mediaKeys: [], contacts: 0 };
  const ids = group.map((c) => c.id);

  // The numbers and emails, kept only as keyed hashes.
  const hashes = group.flatMap((c) => [c.waId, c.email].filter((v): v is string => Boolean(v)));
  if (hashes.length) {
    await tx.erasedIdentity.createMany({
      data: hashes.map((v) => ({ orgId: input.orgId, hash: input.hash(v) })),
      skipDuplicates: true,
    });
  }

  const conversations = await tx.conversation.findMany({
    where: { contactId: { in: ids } },
    select: { id: true },
  });
  const conversationIds = conversations.map((c) => c.id);
  let mediaKeys: string[] = [];
  if (conversationIds.length) {
    mediaKeys = (
      await tx.$queryRaw<{ media_key: string }[]>`
        SELECT media_key FROM messages
        WHERE conversation_id = ANY(${conversationIds}::uuid[]) AND media_key IS NOT NULL`
    ).map((r) => r.media_key);
    // Keep what a message was and when (billing, reports), not what it said. A template keeps
    // its id so template reports still count it.
    await tx.$executeRaw`
      UPDATE messages SET
        body = NULL,
        content = CASE WHEN content ? 'templateId'
                       THEN jsonb_build_object('templateId', content->'templateId', 'erased', true)
                       ELSE NULL END,
        media_key = NULL, media_meta_id = NULL, media_filename = NULL,
        error_message = NULL
      WHERE conversation_id = ANY(${conversationIds}::uuid[])`;
    await tx.conversation.updateMany({
      where: { id: { in: conversationIds } },
      data: { lastMessagePreview: null, adHeadline: null },
    });
  }

  await tx.contactNote.deleteMany({ where: { contactId: { in: ids } } });
  await tx.contactTag.deleteMany({ where: { contactId: { in: ids } } });
  await tx.contactIdentity.deleteMany({ where: { contactId: { in: ids } } });
  await tx.campaignRecipient.updateMany({
    where: { contactId: { in: ids } },
    data: { variables: {}, errorMessage: null },
  });
  await tx.$executeRaw`
    UPDATE flow_runs SET variables = '{}'::jsonb, input = NULL,
           trigger = jsonb_build_object('type', trigger->'type')
    WHERE contact_id = ANY(${ids}::uuid[])`;

  const now = new Date();
  await tx.contact.updateMany({
    where: { id: { in: ids } },
    data: {
      name: ERASED_NAME,
      waId: null,
      email: null,
      customFields: {},
      optInStatus: 'opted_out',
      optInProof: null,
      optInSource: 'erased',
      optOutAt: now,
      erasedAt: now,
      deletedAt: now,
    },
  });
  for (const id of ids) {
    await tx.$executeRaw`SELECT privacy_erase_contact_history(${id}::uuid)`;
  }
  return { mediaKeys, contacts: ids.length };
}

/** Whether a number or email was erased in this workspace, by its keyed hash. */
export async function isErasedIdentity(tx: TenantTx, orgId: string, hash: string) {
  return (await tx.erasedIdentity.count({ where: { orgId, hash } })) > 0;
}

/** Of these hashes, the ones that were erased. For imports. */
export async function erasedAmong(tx: TenantTx, orgId: string, hashes: string[]) {
  if (hashes.length === 0) return new Set<string>();
  const rows = await tx.erasedIdentity.findMany({
    where: { orgId, hash: { in: hashes } },
    select: { hash: true },
  });
  return new Set(rows.map((r) => r.hash));
}

/** Everything held about one contact, as one JSON document (the subject access request). */
export async function contactExport(tx: TenantTx, contactId: string) {
  const contact = await tx.contact.findUniqueOrThrow({
    where: { id: contactId },
    include: {
      tags: { include: { tag: { select: { name: true } } } },
      notes: { select: { body: true, createdAt: true } },
    },
  });
  const [identities, consent, conversations, recipients, conversions, flowRuns] = await Promise.all(
    [
      tx.contactIdentity.findMany({
        where: { contactId },
        select: { externalId: true, handle: true, createdAt: true },
      }),
      tx.contactConsentEvent.findMany({
        where: { contactId },
        orderBy: { createdAt: 'asc' },
        select: { status: true, source: true, proof: true, createdAt: true },
      }),
      tx.conversation.findMany({
        where: { contactId },
        select: { id: true, status: true, createdAt: true, channel: { select: { kind: true } } },
      }),
      tx.campaignRecipient.findMany({
        where: { contactId },
        select: {
          status: true,
          sentAt: true,
          repliedAt: true,
          campaign: { select: { name: true } },
        },
      }),
      tx.conversion.findMany({
        where: { contactId },
        select: { source: true, amountMicros: true, currency: true, occurredAt: true },
      }),
      tx.flowRun.findMany({
        where: { contactId },
        select: { status: true, variables: true, startedAt: true, endedAt: true },
      }),
    ],
  );
  const messages = conversations.length
    ? await tx.message.findMany({
        where: { conversationId: { in: conversations.map((c) => c.id) } },
        orderBy: [{ createdAt: 'asc' }],
        select: {
          conversationId: true,
          createdAt: true,
          direction: true,
          type: true,
          status: true,
          body: true,
          content: true,
          mediaFilename: true,
          mediaMime: true,
        },
      })
    : [];
  return {
    format: 'wacrm-contact-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    contact: {
      name: contact.name,
      phone: contact.waId ? `+${contact.waId}` : null,
      email: contact.email,
      customFields: contact.customFields,
      tags: contact.tags.map((t) => t.tag.name),
      consent: {
        status: contact.optInStatus,
        optedInAt: contact.optInAt,
        source: contact.optInSource,
        optedOutAt: contact.optOutAt,
      },
      createdAt: contact.createdAt,
    },
    identities,
    consentHistory: consent,
    notes: contact.notes,
    conversations: conversations.map((c) => ({
      channel: c.channel.kind,
      status: c.status,
      startedAt: c.createdAt,
      messages: messages
        .filter((m) => m.conversationId === c.id)
        .map(({ conversationId: _c, ...m }) => m),
    })),
    broadcasts: recipients.map((r) => ({
      campaign: r.campaign.name,
      status: r.status,
      sentAt: r.sentAt,
      repliedAt: r.repliedAt,
    })),
    purchases: conversions.map((c) => ({
      source: c.source,
      amount: Number(c.amountMicros) / 1_000_000,
      currency: c.currency,
      at: c.occurredAt,
    })),
    automatedConversations: flowRuns,
  };
}

/** Columns never exported: credentials, token hashes and secrets. */
const SECRET_COLUMN = /(_enc|_hash|^token|_token|secret|password)/;
/** Derived tables, rebuilt from the rest. */
const SKIP_TABLES = /^analytics_/;

/**
 * Every row of every tenant table this workspace can read, as NDJSON lines
 * `{"table": ..., "row": {...}}`, a batch at a time, handed to `write`. Credentials and token
 * hashes are left out. `run` opens a tenant transaction per batch.
 */
export async function exportOrgTables(
  run: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>,
  write: (lines: string) => Promise<void>,
): Promise<Record<string, number>> {
  const tables = await run(
    (tx) =>
      tx.$queryRaw<{ table_name: string; columns: string[]; has_id: boolean }[]>`
      SELECT c.table_name,
             array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns,
             bool_or(c.column_name = 'id') AS has_id
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.table_name IN (SELECT table_name FROM information_schema.columns
                             WHERE table_schema = 'public' AND column_name = 'org_id')
      GROUP BY c.table_name
      ORDER BY c.table_name`,
  );
  const counts: Record<string, number> = {};
  for (const t of tables) {
    if (SKIP_TABLES.test(t.table_name)) continue;
    const secret = t.columns.filter((c) => SECRET_COLUMN.test(c));
    // Fixed names from the catalogue, quoted; never from input.
    const table = Prisma.raw(`"${t.table_name.replace(/"/g, '')}"`);
    let after: string | null = null;
    counts[t.table_name] = 0;
    for (;;) {
      const rows: { row: Record<string, unknown>; id: string | null }[] = await run((tx) =>
        t.has_id
          ? tx.$queryRaw`
              SELECT to_jsonb(x) - ${secret}::text[] AS row, x.id::text AS id
              FROM ${table} x
              WHERE ${after}::text IS NULL OR x.id::text > ${after}::text
              ORDER BY x.id::text
              LIMIT 2000`
          : tx.$queryRaw`SELECT to_jsonb(x) - ${secret}::text[] AS row, NULL::text AS id FROM ${table} x`,
      );
      if (rows.length === 0) break;
      await write(
        rows.map((r) => JSON.stringify({ table: t.table_name, row: r.row })).join('\n') + '\n',
      );
      counts[t.table_name]! += rows.length;
      if (!t.has_id || rows.length < 2000) break;
      after = rows.at(-1)!.id;
    }
  }
  return counts;
}

/**
 * Message retention: blank message text and files older than `days` in the current workspace,
 * a batch at a time. Returns the media keys to delete and how many messages changed.
 */
export async function expireOldMessages(
  tx: TenantTx,
  days: number,
  limit = 5000,
): Promise<{ mediaKeys: string[]; messages: number }> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const rows = await tx.$queryRaw<{ id: string; created_at: Date; media_key: string | null }[]>`
    SELECT id, created_at, media_key FROM messages
    WHERE created_at < ${cutoff}::timestamptz
      AND (body IS NOT NULL OR media_key IS NOT NULL
           OR (content IS NOT NULL AND NOT content ? 'expired'))
    ORDER BY created_at
    LIMIT ${limit}`;
  if (rows.length === 0) return { mediaKeys: [], messages: 0 };
  await tx.$executeRaw`
    UPDATE messages SET
      body = NULL,
      content = CASE WHEN content ? 'templateId'
                     THEN jsonb_build_object('templateId', content->'templateId', 'expired', true)
                     ELSE jsonb_build_object('expired', true) END,
      media_key = NULL, media_meta_id = NULL, media_filename = NULL
    WHERE (id, created_at) IN (
      SELECT * FROM unnest(${rows.map((r) => r.id)}::uuid[], ${rows.map((r) => r.created_at)}::timestamptz[]))`;
  return {
    mediaKeys: rows.flatMap((r) => (r.media_key ? [r.media_key] : [])),
    messages: rows.length,
  };
}

/**
 * Soft-delete a workspace (Phase 4.1's rules, shared with the deletion grace period): numbers are
 * disconnected and their credentials wiped, keys and pending invitations stop, history stays
 * until an operator's purge. Run in the workspace's own context; `deleted_at` is set last.
 */
export async function softDeleteWorkspaceTx(
  tx: TenantTx,
  orgId: string,
  reason: string,
): Promise<{ numbersDisconnected: number }> {
  const now = new Date();
  const wabas = await tx.wabaAccount.findMany({
    where: { status: 'active' },
    select: { id: true },
  });
  for (const waba of wabas) await disconnectWabaTx(tx, waba.id, reason);
  await tx.apiKey.updateMany({ where: { revokedAt: null }, data: { revokedAt: now } });
  await tx.invitation.updateMany({
    where: { acceptedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  await tx.organization.update({
    where: { id: orgId },
    data: { deletedAt: now, status: 'suspended' },
  });
  return { numbersDisconnected: wabas.length };
}
