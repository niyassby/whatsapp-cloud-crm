import {
  type CampaignCounts,
  type CampaignDto,
  type DripDto,
  type PauseCode,
  RECIPIENT_RANK,
  type RecipientStatus,
  toCampaignCounts,
  type VariableSource,
} from '@wacrm/shared';
import type { Prisma } from './generated/prisma/client';
import type { TenantTx } from './tenant';
import { releaseReservation, reserveFunds } from './wallet';

/** Everything `campaignToDto` needs. */
export const campaignInclude = {
  phone: { select: { displayPhoneNumber: true } },
  template: { select: { name: true, category: true } },
} as const;

type CampaignRow = Prisma.CampaignGetPayload<{ include: typeof campaignInclude }>;

/** The audience's stored file key stays on the server. */
export function campaignToDto(c: CampaignRow): CampaignDto {
  const audience = c.audience as { type: 'segment' | 'csv'; segmentId?: string; filename?: string };
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    phoneId: c.phoneId,
    phoneDisplay: c.phone.displayPhoneNumber,
    templateId: c.templateId,
    templateName: c.template.name,
    templateCategory: c.template.category,
    audience: {
      type: audience.type,
      ...(audience.segmentId ? { segmentId: audience.segmentId } : {}),
      ...(audience.filename ? { filename: audience.filename } : {}),
    },
    variableMapping: c.variableMapping as Record<string, VariableSource>,
    scheduledAt: c.scheduledAt?.toISOString() ?? null,
    timezone: c.timezone,
    startedAt: c.startedAt?.toISOString() ?? null,
    finishedAt: c.finishedAt?.toISOString() ?? null,
    pauseCode: c.pauseCode as PauseCode | null,
    pauseReason: c.pauseReason,
    waitingUntil: c.waitingUntil?.toISOString() ?? null,
    estimateMicros: Number(c.estimateMicros),
    invalidRows: c.invalidRows,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function campaignCounts(tx: TenantTx, campaignId: string): Promise<CampaignCounts> {
  const groups = await tx.campaignRecipient.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { _all: true },
  });
  return toCampaignCounts(groups.map((g) => ({ status: g.status, count: g._count._all })));
}

/**
 * What this campaign really cost: its charges minus its refunds, read from the ledger. Reviewed
 * raw SQL: a bound parameter, under the tenant's RLS context.
 */
export async function campaignCostMicros(tx: TenantTx, campaignId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT SUM(l.amount_micros)::bigint AS total
    FROM campaign_recipients r
    JOIN wallet_ledger l
      ON l.org_id = r.org_id
     AND l.reference_type = 'message'
     AND l.reference_id = r.message_id::text
    WHERE r.campaign_id = ${campaignId}::uuid AND r.message_id IS NOT NULL`;
  return 0 - Number(row?.total ?? 0n);
}

/**
 * A status from Meta, moving the recipient forward only. Answers the campaign it belongs to, so a
 * report open on someone's screen can update. Null for a message no campaign sent.
 */
export async function applyRecipientStatus(
  tx: TenantTx,
  messageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed',
  error?: { code: string; message: string },
): Promise<string | null> {
  const recipient = await tx.campaignRecipient.findFirst({
    where: { messageId },
    select: { campaignId: true },
  });
  if (!recipient) return null;
  if (status === 'failed') {
    await tx.campaignRecipient.updateMany({
      where: { messageId, status: { in: ['pending', 'sending', 'sent', 'delivered'] } },
      data: {
        status: 'failed',
        errorCode: error?.code ?? null,
        errorMessage: error?.message ?? null,
      },
    });
    return recipient.campaignId;
  }
  const lower = (Object.keys(RECIPIENT_RANK) as RecipientStatus[]).filter(
    (s) => RECIPIENT_RANK[s]! < RECIPIENT_RANK[status]!,
  );
  await tx.campaignRecipient.updateMany({
    where: { messageId, status: { in: lower } },
    data: { status },
  });
  // Whichever status arrives first marks when it went out: it counts toward the daily limit.
  await tx.campaignRecipient.updateMany({
    where: { messageId, sentAt: null },
    data: { sentAt: new Date() },
  });
  return recipient.campaignId;
}

/** Holds are released after this, in case a campaign is abandoned while paused. */
const RESERVATION_DAYS = 30;

/**
 * Hold what this campaign's unsent recipients could cost, replacing any hold it already has, in one
 * transaction. So a retry or a resume can never leave two holds behind. Throws
 * INSUFFICIENT_BALANCE when there is not enough, which rolls the swap back too.
 */
export async function holdCampaignFunds(
  tx: TenantTx,
  input: { orgId: string; campaignId: string; now?: Date },
): Promise<{ heldMicros: number }> {
  const { orgId, campaignId } = input;
  const now = input.now ?? new Date();
  await releaseCampaignFunds(tx, orgId, campaignId);
  const sum = await tx.campaignRecipient.aggregate({
    where: { campaignId, status: { in: ['pending', 'sending'] }, messageId: null },
    _sum: { estimateMicros: true },
  });
  const amount = Number(sum._sum.estimateMicros ?? 0n);
  if (amount === 0) {
    await tx.campaign.update({ where: { id: campaignId }, data: { reservationId: null } });
    return { heldMicros: 0 };
  }
  const hold = await reserveFunds(tx, {
    orgId,
    amountMicros: amount,
    referenceType: 'campaign',
    referenceId: campaignId,
    idempotencyKey: `campaign:${campaignId}:${now.getTime()}`,
    expiresAt: new Date(now.getTime() + RESERVATION_DAYS * 86_400_000),
    now,
  });
  await tx.campaign.update({ where: { id: campaignId }, data: { reservationId: hold.id } });
  return { heldMicros: amount };
}

/** Give back everything this campaign still holds. */
export async function releaseCampaignFunds(
  tx: TenantTx,
  orgId: string,
  campaignId: string,
): Promise<void> {
  const holds = await tx.walletReservation.findMany({
    where: { referenceType: 'campaign', referenceId: campaignId, status: 'active' },
    select: { id: true },
  });
  for (const h of holds) await releaseReservation(tx, { orgId, reservationId: h.id });
}

/** The limit for a number whose tier Meta has not told us: where a new number starts. */
const UNKNOWN_TIER_LIMIT = 250;

/** How many more customers this number may reach today, by its tier. Null means no limit. */
export async function dailyRemaining(
  tx: TenantTx,
  phoneId: string,
  tier: string | null,
): Promise<number | null> {
  const limit = tier ? await tx.messagingTierLimit.findUnique({ where: { tier } }) : null;
  const daily = limit ? limit.dailyRecipients : UNKNOWN_TIER_LIMIT;
  if (daily === null) return null;
  const used = await tx.campaignRecipient.count({
    where: { phoneId, sentAt: { gte: new Date(Date.now() - 86_400_000) } },
  });
  return Math.max(0, daily - used);
}

/** How long after a broadcast a reply still counts as a reply to it. */
const REPLY_WINDOW_MS = 72 * 3600_000;

/**
 * A customer wrote in. Marks their latest broadcast as replied, and ends any drip that stops on a
 * reply. Runs in the inbound message's transaction, after its dedupe, so a replay does nothing.
 */
export async function applyContactReply(
  tx: TenantTx,
  contactId: string,
  at: Date,
): Promise<{ exitedDrips: number; campaignId: string | null }> {
  const latest = await tx.campaignRecipient.findFirst({
    where: {
      contactId,
      status: { in: ['sent', 'delivered', 'read'] },
      // Meta's timestamps are whole seconds, so a quick reply can look older than the send.
      sentAt: { gte: new Date(at.getTime() - REPLY_WINDOW_MS), lte: new Date(at.getTime() + 1000) },
    },
    orderBy: { sentAt: 'desc' },
    select: { id: true, campaignId: true },
  });
  if (latest) {
    await tx.campaignRecipient.update({
      where: { id: latest.id },
      data: { status: 'replied', repliedAt: at },
    });
  }
  const exited = await tx.dripEnrollment.updateMany({
    where: {
      contactId,
      status: 'active',
      enrolledAt: { lte: at },
      sequence: { exitOnReply: true },
    },
    data: { status: 'exited', exitReason: 'replied', nextRunAt: null },
  });
  return { exitedDrips: exited.count, campaignId: latest?.campaignId ?? null };
}

/** Someone who opted out leaves every drip at once, rather than at their next step. */
export async function exitDripsOnOptOut(tx: TenantTx, contactId: string): Promise<void> {
  await tx.dripEnrollment.updateMany({
    where: { contactId, status: 'active' },
    data: { status: 'exited', exitReason: 'opted_out', nextRunAt: null },
  });
}

export const dripInclude = {
  steps: {
    orderBy: { position: 'asc' },
    include: { template: { select: { name: true } } },
  },
} as const;

type DripRow = Prisma.DripSequenceGetPayload<{ include: typeof dripInclude }>;

export function dripToDto(
  d: DripRow,
  enrollments: { status: string; _count: { _all: number } }[],
): DripDto {
  const count = (s: string) => enrollments.find((e) => e.status === s)?._count._all ?? 0;
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    phoneId: d.phoneId,
    exitOnReply: d.exitOnReply,
    exitTagId: d.exitTagId,
    steps: d.steps.map((s) => ({
      id: s.id,
      position: s.position,
      delayMinutes: s.delayMinutes,
      templateId: s.templateId,
      templateName: s.template.name,
      variableMapping: s.variableMapping as Record<string, VariableSource>,
    })),
    enrollments: {
      active: count('active'),
      completed: count('completed'),
      exited: count('exited'),
    },
    createdAt: d.createdAt.toISOString(),
  };
}
