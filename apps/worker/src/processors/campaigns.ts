import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  applyRecipientStatus,
  campaignCounts,
  chargeMessage,
  dailyRemaining,
  ensureWallet,
  holdCampaignFunds,
  type ContactListFilter,
  contactListWhere,
  findRate,
  type Prisma,
  releaseCampaignFunds,
  roomLeft,
  type TenantTx,
  withTenant,
  emitWebhookEvent,
  campaignCostMicros,
} from '@wacrm/db';
import {
  AppError,
  broadcastSkipReason,
  buildSendComponents,
  toPublicCampaignCounts,
  type CampaignCsvOptions,
  type CampaignJob,
  type ContactForTemplate,
  cleanVariableValue,
  ErrorCode,
  type FieldValue,
  headerMediaKind,
  isChargeable,
  type MediaHeaderFormat,
  messagePreview,
  type PauseCode,
  renderedText,
  renderTemplate,
  resolveVariable,
  type SkipReason,
  type TemplateDefinition,
  templateDefinitionSchema,
  templateVariables,
  type VariableSource,
} from '@wacrm/shared';
import { countryOfWaId, normalizePhone } from '@wacrm/shared/server';
import { parse } from 'csv-parse';
import type { WorkerDeps } from '../deps';
import { runDripBatch } from './drips';
import { sendOutboundMessage } from './outbound';

const PAGE = 1000;
/** Before this many attempts, a high failure rate could just be a few unlucky sends. */
const MIN_ATTEMPTS_FOR_RATE = 50;
const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;
/** A send this old was left behind by a crashed worker. */
const STALE_SENDING_MS = 5 * 60_000;
const LOW_QUALITY = new Set(['RED', 'LOW']);
/**
 * Sends running at once within a batch. Each takes several transactions from the pool the worker
 * shares with inbound messages, so a batch must leave room for them.
 */
const SEND_CONCURRENCY = 5;

export interface CampaignSettings {
  /** Messages per second for one number. Stays below the inbox's, which share the same counter. */
  mpsPerNumber: number;
  /** Failed out of attempted, from 0 to 1. Above this the campaign pauses. */
  maxFailureRate: number;
}

interface LoadedTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  definition: TemplateDefinition;
  headerMediaKey: string | null;
  headerMediaMime: string | null;
  headerMediaName: string | null;
}

function parseTemplate(row: {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  definition: unknown;
  headerMediaKey: string | null;
  headerMediaMime: string | null;
  headerMediaName: string | null;
}): LoadedTemplate | null {
  const parsed = templateDefinitionSchema.safeParse(row.definition);
  return parsed.success ? { ...row, definition: parsed.data } : null;
}

const toTemplateContact = (c: {
  name: string | null;
  waId: string;
  email: string | null;
  customFields: unknown;
}): ContactForTemplate => ({
  name: c.name,
  waId: c.waId,
  email: c.email,
  customFields: (c.customFields ?? {}) as Record<string, FieldValue>,
});

/** Resolve every variable. Null when one has no value, since Meta would refuse the send. */
function resolveVariables(
  def: TemplateDefinition,
  mapping: Record<string, VariableSource>,
  contact: ContactForTemplate,
  extra: Record<string, string> = {},
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const v of templateVariables(def)) {
    const button = def.buttons[v.buttonIndex ?? -1];
    const value = cleanVariableValue(
      extra[v.key] ??
        (resolveVariable(mapping[v.key], contact) ||
          (button?.type === 'COPY_CODE' ? button.example : '')),
    );
    if (!value) return null;
    out[v.key] = value;
  }
  return out;
}

/** Remembers prices within one prepare run: a rate rarely differs inside a country. */
function rateCache(tx: TenantTx, currency: string, category: string) {
  const seen = new Map<string, number | null>();
  return async (country: string | null): Promise<number | null> => {
    const key = country ?? '';
    if (!seen.has(key)) {
      const quote = await findRate(tx, { currency, category, country });
      seen.set(key, quote?.rateMicros ?? null);
    }
    return seen.get(key) ?? null;
  };
}

interface PendingRecipient {
  contactId: string;
  status: 'pending' | 'skipped';
  skipReason: SkipReason | null;
  variables: Record<string, string>;
  estimateMicros: bigint;
}

/**
 * Turn the audience into recipients, then hold the money for them. Safe to run again: recipients
 * are unique per contact, and the hold is keyed by campaign. Nothing sends until both are done,
 * so running out of money is found before the first message, not halfway through.
 */
export async function prepareCampaign(
  deps: WorkerDeps,
  orgId: string,
  campaignId: string,
): Promise<'running' | 'paused' | 'completed' | 'skipped' | 'failed'> {
  const claimed = await withTenant(deps.db, { orgId }, async (tx) => {
    const res = await tx.campaign.updateMany({
      where: { id: campaignId, status: { in: ['scheduled', 'preparing'] } },
      data: { status: 'preparing', startedAt: new Date() },
    });
    if (res.count === 0) return null;
    return tx.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      include: { template: true, phone: { select: { id: true, status: true } } },
    });
  });
  if (!claimed) return 'skipped';

  const update = (data: Prisma.CampaignUpdateInput) =>
    withTenant(deps.db, { orgId }, (tx) => tx.campaign.update({ where: { id: campaignId }, data }));

  const template = parseTemplate(claimed.template);
  if (!template || claimed.template.status !== 'approved' || !claimed.template.supported) {
    await update({
      status: 'failed',
      pauseCode: 'template_not_approved',
      pauseReason: 'The template is no longer approved.',
      finishedAt: new Date(),
    });
    deps.publisher.emit(orgId, 'campaign:updated', { campaignId });
    return 'failed';
  }

  const mapping = claimed.variableMapping as Record<string, VariableSource>;
  const audience = claimed.audience as { type: 'segment' | 'csv' } & Record<string, unknown>;
  const wallet = await withTenant(deps.db, { orgId }, async (tx) => {
    await ensureWallet(tx, orgId, deps.defaultCurrency);
    return tx.wallet.findUniqueOrThrow({ where: { orgId }, select: { currency: true } });
  });

  const writeBatch = async (rows: PendingRecipient[]) => {
    if (rows.length === 0) return;
    await withTenant(deps.db, { orgId }, (tx) =>
      tx.campaignRecipient.createMany({
        data: rows.map((r) => ({
          orgId,
          campaignId,
          phoneId: claimed.phoneId,
          contactId: r.contactId,
          status: r.status,
          skipReason: r.skipReason,
          variables: r.variables,
          estimateMicros: r.estimateMicros,
        })),
        skipDuplicates: true,
      }),
    );
  };

  const toRecipient = async (
    prices: ReturnType<typeof rateCache>,
    c: {
      id: string;
      name: string | null;
      waId: string;
      email: string | null;
      customFields: unknown;
      optInStatus: 'unknown' | 'opted_in' | 'opted_out';
      mergedIntoId: string | null;
    },
    extra?: Record<string, string>,
  ): Promise<PendingRecipient> => {
    const skip = (skipReason: SkipReason): PendingRecipient => ({
      contactId: c.id,
      status: 'skipped',
      skipReason,
      variables: {},
      estimateMicros: 0n,
    });
    if (c.mergedIntoId) return skip('merged');
    const reason = broadcastSkipReason(c.optInStatus, template.category);
    if (reason) return skip(reason);
    const variables = resolveVariables(template.definition, mapping, toTemplateContact(c), extra);
    if (!variables) return skip('missing_variable');
    return {
      contactId: c.id,
      status: 'pending',
      skipReason: null,
      variables,
      estimateMicros: BigInt((await prices(countryOfWaId(c.waId))) ?? 0),
    };
  };

  if (audience.type === 'segment') {
    const where = contactListWhere((audience.filterSnapshot ?? {}) as ContactListFilter);
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const after = cursor as { createdAt: Date; id: string } | null;
      const page = await withTenant(deps.db, { orgId }, async (tx) => {
        const rows = await tx.contact.findMany({
          where: after
            ? {
                AND: [
                  where,
                  {
                    OR: [
                      { createdAt: { lt: after.createdAt } },
                      { createdAt: after.createdAt, id: { lt: after.id } },
                    ],
                  },
                ],
              }
            : where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: PAGE,
        });
        const prices = rateCache(tx, wallet.currency, template.category);
        const recipients: PendingRecipient[] = [];
        for (const c of rows) recipients.push(await toRecipient(prices, c));
        return { rows, recipients };
      });
      await writeBatch(page.recipients);
      const last = page.rows.at(-1);
      if (!last || page.rows.length < PAGE) break;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
  } else {
    const options = audience as unknown as CampaignCsvOptions & { key: string };
    const bytes = await deps.storage.get(options.key);
    const parser = Readable.from(bytes).pipe(
      parse({
        bom: true,
        columns: true,
        relax_column_count: true,
        skip_empty_lines: true,
        skip_records_with_error: true,
        trim: true,
      }),
    );
    let invalid = 0;
    parser.on('skip', () => {
      invalid++;
    });
    const seen = new Set<string>();
    let batch: { waId: string; name: string | null; extra: Record<string, string> }[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const rows = batch;
      batch = [];
      const recipients = await withTenant(deps.db, { orgId }, async (tx) => {
        // A number in the file becomes a contact, with no consent recorded, while the plan has
        // room. Beyond that, a row with no contact is counted as invalid.
        const room = await roomLeft(tx, orgId, 'contacts');
        const known = await tx.contact.findMany({
          where: { waId: { in: rows.map((r) => r.waId) } },
          select: { waId: true },
        });
        const knownIds = new Set(known.map((c) => c.waId));
        const fresh = rows.filter((r) => !knownIds.has(r.waId));
        const allowed = room === null ? fresh : fresh.slice(0, room);
        invalid += fresh.length - allowed.length;
        await tx.contact.createMany({
          data: allowed.map((r) => ({ orgId, waId: r.waId, name: r.name })),
          skipDuplicates: true,
        });
        const contacts = await tx.contact.findMany({
          where: { waId: { in: rows.map((r) => r.waId) } },
        });
        const byWaId = new Map(contacts.map((c) => [c.waId, c]));
        const prices = rateCache(tx, wallet.currency, template.category);
        const out: PendingRecipient[] = [];
        for (const r of rows) {
          const contact = byWaId.get(r.waId);
          if (contact) out.push(await toRecipient(prices, contact, r.extra));
        }
        return out;
      });
      await writeBatch(recipients);
    };
    for await (const record of parser as AsyncIterable<Record<string, string | undefined>>) {
      const waId = normalizePhone(record[options.phoneColumn] ?? '', options.defaultCountry);
      if (!waId) {
        invalid++;
        continue;
      }
      if (seen.has(waId)) continue;
      seen.add(waId);
      const extra: Record<string, string> = {};
      for (const [key, column] of Object.entries(options.variableColumns ?? {})) {
        const value = record[column];
        if (value) extra[key] = value;
      }
      batch.push({
        waId,
        name: (options.nameColumn ? record[options.nameColumn] : undefined) || null,
        extra,
      });
      if (batch.length >= PAGE) await flush();
    }
    await flush();
    await update({ invalidRows: invalid });
  }

  // Money first, then sending.
  const { estimate, pending } = await withTenant(deps.db, { orgId }, async (tx) => {
    const sum = await tx.campaignRecipient.aggregate({
      where: { campaignId, status: 'pending' },
      _sum: { estimateMicros: true },
      _count: { _all: true },
    });
    return { estimate: sum._sum.estimateMicros ?? 0n, pending: sum._count._all };
  });

  if (pending === 0) {
    await update({ status: 'completed', finishedAt: new Date(), estimateMicros: 0n });
    deps.publisher.emit(orgId, 'campaign:updated', { campaignId });
    return 'completed';
  }

  if ((await holdFunds(deps, orgId, campaignId)) === 'insufficient') return 'paused';

  // Conditional: someone may have cancelled it while the list was being built.
  const started = await withTenant(deps.db, { orgId }, async (tx) => {
    const res = await tx.campaign.updateMany({
      where: { id: campaignId, status: 'preparing' },
      data: { status: 'running', estimateMicros: estimate, pauseCode: null, pauseReason: null },
    });
    if (res.count === 0) {
      await releaseCampaignFunds(tx, orgId, campaignId);
      await tx.campaignRecipient.updateMany({
        where: { campaignId, status: 'pending' },
        data: { status: 'cancelled' },
      });
    }
    return res.count > 0;
  });
  if (!started) return 'skipped';
  deps.publisher.emit(orgId, 'campaign:updated', { campaignId });
  await deps.enqueueCampaignJob({ kind: 'dispatch', orgId, campaignId });
  return 'running';
}

/** Hold what the remaining recipients could cost. Pauses the campaign if there is not enough. */
async function holdFunds(
  deps: WorkerDeps,
  orgId: string,
  campaignId: string,
): Promise<'held' | 'insufficient'> {
  try {
    await withTenant(deps.db, { orgId }, (tx) => holdCampaignFunds(tx, { orgId, campaignId }), {
      timeout: 30_000,
    });
    return 'held';
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCode.INSUFFICIENT_BALANCE) {
      await pause(
        deps,
        orgId,
        campaignId,
        'insufficient_funds',
        'There is not enough in the wallet for this campaign. Top up, then resume it.',
      );
      return 'insufficient';
    }
    throw err;
  }
}

export async function pause(
  deps: WorkerDeps,
  orgId: string,
  campaignId: string,
  code: PauseCode,
  reason: string,
): Promise<void> {
  const res = await withTenant(deps.db, { orgId }, async (tx) => {
    const paused = await tx.campaign.updateMany({
      where: { id: campaignId, status: { in: ['running', 'preparing'] } },
      data: { status: 'paused', pauseCode: code, pauseReason: reason, waitingUntil: null },
    });
    if (paused.count > 0) {
      await emitWebhookEvent(tx, orgId, 'campaign.paused', { id: campaignId, code, reason });
    }
    return paused;
  });
  if (res.count > 0) deps.publisher.emit(orgId, 'campaign:updated', { campaignId });
}

interface ClaimedRecipient {
  id: string;
  contact_id: string;
  attempts: number;
  variables: Record<string, string>;
  message_id: string | null;
  message_created_at: Date | null;
}

/**
 * Claim the next recipients, and find what a crash left behind. SKIP LOCKED means two dispatchers
 * can never claim the same recipient. MATERIALIZED matters: in a plain `WHERE id IN (SELECT ...
 * LIMIT n)` Postgres may run the subquery repeatedly and claim far more than n, which would break
 * throttling. Reviewed raw SQL: bound parameters, under RLS.
 */
async function claimRecipients(
  tx: TenantTx,
  campaignId: string,
  limit: number,
): Promise<ClaimedRecipient[]> {
  const stale = new Date(Date.now() - STALE_SENDING_MS);
  return tx.$queryRaw<ClaimedRecipient[]>`
    WITH picked AS MATERIALIZED (
      SELECT id FROM campaign_recipients
       WHERE campaign_id = ${campaignId}::uuid
         AND (
           (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
           OR (status = 'sending' AND updated_at < ${stale})
         )
       ORDER BY id
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE campaign_recipients r
       SET status = 'sending', attempts = r.attempts + 1, next_attempt_at = NULL, updated_at = now()
      FROM picked
     WHERE r.id = picked.id
     RETURNING r.id, r.contact_id, r.attempts, r.variables, r.message_id, r.message_created_at`;
}

export type DispatchOutcome = 'again' | 'finished' | 'stopped' | { retryInMs: number };

/**
 * Send one batch, then say what should happen next. A campaign is a chain of short jobs rather
 * than one long one, so a pause or cancel takes effect by the next batch, and deploys are cheap.
 */
export async function dispatchCampaignBatch(
  deps: WorkerDeps,
  settings: CampaignSettings,
  orgId: string,
  campaignId: string,
): Promise<DispatchOutcome> {
  const state = await withTenant(deps.db, { orgId }, async (tx) => {
    const campaign = await tx.campaign.findUnique({
      where: { id: campaignId },
      include: {
        template: true,
        phone: {
          select: {
            id: true,
            phoneNumberId: true,
            status: true,
            qualityRating: true,
            messagingTier: true,
          },
        },
      },
    });
    if (!campaign) return null;
    const counts = await campaignCounts(tx, campaignId);
    const remaining = await dailyRemaining(tx, campaign.phoneId, campaign.phone.messagingTier);
    return { campaign, counts, remaining };
  });
  if (!state || state.campaign.status !== 'running') return 'stopped';
  const { campaign, counts, remaining } = state;

  // Checks that protect the customer's number, before every batch.
  if (campaign.phone.status !== 'connected') {
    await pause(
      deps,
      orgId,
      campaignId,
      'number_disconnected',
      'The WhatsApp number is no longer connected.',
    );
    return 'stopped';
  }
  if (LOW_QUALITY.has((campaign.phone.qualityRating ?? '').toUpperCase())) {
    await pause(
      deps,
      orgId,
      campaignId,
      'low_quality',
      'WhatsApp rates this number’s quality as low. Sending more could get it restricted.',
    );
    return 'stopped';
  }
  const template = parseTemplate(campaign.template);
  if (!template || campaign.template.status !== 'approved') {
    await pause(
      deps,
      orgId,
      campaignId,
      'template_not_approved',
      'The template is no longer approved, for example because Meta paused it.',
    );
    return 'stopped';
  }
  const attempted = counts.sent + counts.failed;
  if (attempted >= MIN_ATTEMPTS_FOR_RATE && counts.failed / attempted > settings.maxFailureRate) {
    const percent = Math.round((counts.failed / attempted) * 100);
    await pause(
      deps,
      orgId,
      campaignId,
      'high_failure_rate',
      `${percent}% of sends failed, so this stopped to protect the number. Check the failures, then resume.`,
    );
    return 'stopped';
  }

  if (counts.pending === 0 && counts.sending === 0) {
    await finishCampaign(deps, orgId, campaignId);
    return 'finished';
  }

  if (remaining === 0) {
    const until = new Date(Date.now() + 15 * 60_000);
    await withTenant(deps.db, { orgId }, (tx) =>
      tx.campaign.update({ where: { id: campaignId }, data: { waitingUntil: until } }),
    );
    deps.publisher.emit(orgId, 'campaign:updated', { campaignId });
    return { retryInMs: 15 * 60_000 };
  }

  const size = Math.min(settings.mpsPerNumber, remaining ?? Number.MAX_SAFE_INTEGER);
  const allowed = await deps.acquireCampaignSlots(campaign.phone.phoneNumberId, size);
  if (allowed === 0) return { retryInMs: 250 };

  const recipients = await withTenant(deps.db, { orgId }, (tx) =>
    claimRecipients(tx, campaignId, allowed),
  );
  if (recipients.length === 0) {
    // Everything left is waiting to retry, or another dispatcher holds it.
    return { retryInMs: 2_000 };
  }
  if (campaign.waitingUntil) {
    await withTenant(deps.db, { orgId }, (tx) =>
      tx.campaign.update({ where: { id: campaignId }, data: { waitingUntil: null } }),
    );
  }

  let prepared: Awaited<ReturnType<typeof prepareMessages>>;
  try {
    prepared = await prepareMessages(deps, orgId, campaign, template, recipients);
  } catch (err) {
    // Rolled back, so nothing was charged or sent. Hand the claims back rather than leaving them
    // to go stale. A deadlock or timeout just tries again, and anything else fails the job.
    await withTenant(deps.db, { orgId }, (tx) =>
      tx.campaignRecipient.updateMany({
        where: { id: { in: recipients.map((r) => r.id) }, status: 'sending' },
        data: { status: 'pending', attempts: { decrement: 1 } },
      }),
    );
    const code = (err as { code?: unknown }).code;
    if (code === 'P2034' || code === 'P2028') return { retryInMs: 2_000 };
    throw err;
  }
  if (prepared.outOfFunds) {
    await pause(
      deps,
      orgId,
      campaignId,
      'insufficient_funds',
      'The funds held for this campaign ran out. Top up, then resume it.',
    );
  }
  await forEachLimited(prepared.messages, SEND_CONCURRENCY, (m) => sendOne(deps, orgId, m));
  // Touching the row tells the scheduler this campaign is alive.
  await withTenant(deps.db, { orgId }, (tx) =>
    tx.campaign.update({ where: { id: campaignId }, data: { updatedAt: new Date() } }),
  );
  deps.publisher.emit(orgId, 'campaign:updated', { campaignId });
  return prepared.outOfFunds ? 'stopped' : 'again';
}

interface PreparedMessage {
  recipientId: string;
  attempts: number;
  messageId: string;
  createdAt: Date;
}

/**
 * Create the messages and charges for a batch in one transaction: far fewer round trips than one
 * per message, which is what makes large campaigns practical, and the wallet row lock is held
 * for one short commit. A contact who opted out since the list was built is skipped here.
 */
async function prepareMessages(
  deps: WorkerDeps,
  orgId: string,
  campaign: {
    id: string;
    phoneId: string;
    reservationId: string | null;
  },
  template: LoadedTemplate,
  recipients: ClaimedRecipient[],
): Promise<{ messages: PreparedMessage[]; outOfFunds: boolean }> {
  const mediaHeader =
    template.definition.header && template.definition.header.format !== 'TEXT'
      ? (template.definition.header.format as MediaHeaderFormat)
      : null;

  return withTenant(
    deps.db,
    { orgId },
    async (tx) => {
      const contacts = await tx.contact.findMany({
        where: { id: { in: recipients.map((r) => r.contact_id) } },
        select: { id: true, waId: true, optInStatus: true },
      });
      const byId = new Map(contacts.map((c) => [c.id, c]));
      const conversations = await tx.conversation.findMany({
        where: {
          phoneId: campaign.phoneId,
          contactId: { in: recipients.map((r) => r.contact_id) },
        },
        select: { id: true, contactId: true, windowExpiresAt: true },
      });
      const convByContact = new Map(conversations.map((c) => [c.contactId, c]));
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { orgId },
        select: { currency: true },
      });

      const messages: PreparedMessage[] = [];
      let outOfFunds = false;
      const now = new Date();

      for (const r of recipients) {
        if (outOfFunds) {
          await tx.campaignRecipient.update({
            where: { id: r.id },
            data: { status: 'pending', attempts: { decrement: 1 } },
          });
          continue;
        }
        const contact = byId.get(r.contact_id);
        const skip = contact
          ? broadcastSkipReason(contact.optInStatus, template.category)
          : ('merged' as const);
        if (!contact || skip) {
          await tx.campaignRecipient.update({
            where: { id: r.id },
            data: { status: 'skipped', skipReason: skip },
          });
          continue;
        }

        // A retry reuses the message and its charge.
        if (r.message_id && r.message_created_at) {
          messages.push({
            recipientId: r.id,
            attempts: r.attempts,
            messageId: r.message_id,
            createdAt: r.message_created_at,
          });
          continue;
        }

        const messageId = randomUUID();
        const createdAt = new Date();
        const existing = convByContact.get(contact.id);
        const windowOpen = Boolean(existing?.windowExpiresAt && existing.windowExpiresAt > now);
        try {
          await chargeMessage(tx, {
            orgId,
            messageId,
            category: template.category,
            country: countryOfWaId(contact.waId),
            windowOpen,
            reservationId: isChargeable(template.category, windowOpen)
              ? (campaign.reservationId ?? undefined)
              : undefined,
            defaults: { currency: wallet.currency, thresholdMicros: null },
          });
        } catch (err) {
          if (
            err instanceof AppError &&
            (err.code === ErrorCode.INSUFFICIENT_BALANCE || err.code === ErrorCode.CONFLICT)
          ) {
            outOfFunds = true;
            await tx.campaignRecipient.update({
              where: { id: r.id },
              data: { status: 'pending', attempts: { decrement: 1 } },
            });
            continue;
          }
          if (err instanceof AppError && err.code === ErrorCode.RATE_NOT_CONFIGURED) {
            await tx.campaignRecipient.update({
              where: { id: r.id },
              data: {
                status: 'failed',
                errorCode: err.code,
                errorMessage: 'No price is set for this contact’s country.',
              },
            });
            continue;
          }
          throw err;
        }

        const body = renderedText(renderTemplate(template.definition, r.variables));
        const preview = messagePreview('template', body);
        let conversationId = existing?.id;
        if (conversationId) {
          await tx.conversation.update({
            where: { id: conversationId },
            data: { lastMessageAt: createdAt, lastMessagePreview: preview },
          });
        } else {
          // Closed until they reply, so a broadcast does not flood the team's open inbox.
          const created = await tx.conversation.upsert({
            where: {
              orgId_phoneId_contactId: { orgId, phoneId: campaign.phoneId, contactId: contact.id },
            },
            create: {
              orgId,
              phoneId: campaign.phoneId,
              contactId: contact.id,
              status: 'closed',
              lastMessageAt: createdAt,
              lastMessagePreview: preview,
            },
            update: { lastMessageAt: createdAt, lastMessagePreview: preview },
            select: { id: true },
          });
          conversationId = created.id;
        }
        await tx.messageRef.createMany({
          data: {
            orgId,
            kind: 'client',
            ref: `campaign:${r.id}`,
            messageId,
            messageCreatedAt: createdAt,
          },
          skipDuplicates: true,
        });
        await tx.message.create({
          data: {
            id: messageId,
            createdAt,
            orgId,
            conversationId,
            direction: 'outbound',
            type: 'template',
            status: 'queued',
            body,
            content: {
              templateId: template.id,
              templateName: template.name,
              language: template.language,
              components: buildSendComponents(template.definition, r.variables),
              category: template.category,
              campaignId: campaign.id,
              ...(mediaHeader ? { headerKind: headerMediaKind(mediaHeader) } : {}),
            } as unknown as Prisma.InputJsonValue,
            ...(mediaHeader && template.headerMediaKey
              ? {
                  mediaKey: template.headerMediaKey,
                  mediaMime: template.headerMediaMime,
                  mediaFilename: template.headerMediaName,
                  mediaStatus: 'stored' as const,
                }
              : {}),
          },
        });
        await tx.campaignRecipient.update({
          where: { id: r.id },
          data: { messageId, messageCreatedAt: createdAt },
        });
        messages.push({ recipientId: r.id, attempts: r.attempts, messageId, createdAt });
      }
      return { messages, outOfFunds };
    },
    { timeout: 60_000 },
  );
}

async function forEachLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runner = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
}

async function sendOne(deps: WorkerDeps, orgId: string, m: PreparedMessage): Promise<void> {
  const job = { orgId, messageId: m.messageId, createdAt: m.createdAt.toISOString() };
  const finalAttempt = m.attempts >= MAX_SEND_ATTEMPTS;
  try {
    const outcome = await sendOutboundMessage(deps, job, { finalAttempt });
    await withTenant(deps.db, { orgId }, async (tx) => {
      const message = await tx.message.findUniqueOrThrow({
        where: { id_createdAt: { id: m.messageId, createdAt: m.createdAt } },
        select: { status: true, errorCode: true, errorMessage: true },
      });
      if (outcome === 'failed') {
        await applyRecipientStatus(tx, m.messageId, 'failed', {
          code: message.errorCode ?? 'UNKNOWN',
          message: message.errorMessage ?? 'Sending failed',
        });
      } else {
        // A fast webhook may be ahead of this, and applyRecipientStatus only moves forward.
        await applyRecipientStatus(tx, m.messageId, 'sent');
      }
    });
  } catch (err) {
    // Retryable or not, one send must not sink the batch: the others are still in flight. This is
    // safe to try again, because a message already claimed fails rather than being sent twice.
    // If even this write fails, the stale claim is picked up after STALE_SENDING_MS.
    await withTenant(deps.db, { orgId }, (tx) =>
      tx.campaignRecipient.update({
        where: { id: m.recipientId },
        data: {
          status: 'pending',
          nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS * m.attempts),
          errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        },
      }),
    ).catch(() => undefined);
  }
}

async function finishCampaign(deps: WorkerDeps, orgId: string, campaignId: string): Promise<void> {
  await withTenant(deps.db, { orgId }, async (tx) => {
    await releaseCampaignFunds(tx, orgId, campaignId);
    const finished = await tx.campaign.updateMany({
      where: { id: campaignId, status: 'running' },
      data: { status: 'completed', finishedAt: new Date(), waitingUntil: null },
    });
    if (finished.count > 0) {
      await emitWebhookEvent(tx, orgId, 'campaign.completed', {
        id: campaignId,
        counts: toPublicCampaignCounts(await campaignCounts(tx, campaignId)),
        costMicros: await campaignCostMicros(tx, campaignId),
      });
    }
  });
  deps.publisher.emit(orgId, 'campaign:updated', { campaignId });
  deps.publisher.emit(orgId, 'wallet:updated', {});
}

/** One job from the campaigns queue, and what to queue after it. */
export async function runCampaignJob(
  deps: WorkerDeps,
  settings: CampaignSettings,
  job: CampaignJob,
): Promise<void> {
  if (job.kind === 'prepare') {
    await prepareCampaign(deps, job.orgId, job.campaignId);
    return;
  }
  if (job.kind === 'drip') {
    const { more } = await runDripBatch(deps, job.orgId, job.sequenceId);
    if (more) await deps.enqueueCampaignJob(job);
    return;
  }
  const outcome = await dispatchCampaignBatch(deps, settings, job.orgId, job.campaignId);
  if (outcome === 'again') await deps.enqueueCampaignJob(job);
  else if (typeof outcome === 'object') await deps.enqueueCampaignJob(job, outcome.retryInMs);
}

/** Campaigns to start or recover, across every org. Returns only ids. */
export function campaignTickTargets(deps: Pick<WorkerDeps, 'db'>) {
  return deps.db.$queryRaw<{ org_id: string; campaign_id: string; kind: string }[]>`
    SELECT org_id, campaign_id, kind FROM campaign_tick_targets(${new Date()}::timestamptz)`;
}
