import { z } from 'zod';
import { OPT_IN_STATUSES, type OptInStatus, segmentFilterSchema } from './contacts';
import { canReceiveMarketing, isMarketingCategory } from './contacts';
import { variableSourceSchema, type VariableSource } from './templates';

// ------------------------------------------------------------------ time zones

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes the zone is ahead of UTC at this instant. */
function zoneOffsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant a wall-clock time means in a zone: "2026-03-08T09:00" in Asia/Kolkata. Two passes,
 * because the offset can differ either side of a clock change.
 */
export function zonedTimeToUtc(local: string, zone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!match) throw new Error('Expected a time like 2026-03-08T09:00');
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const first = wall - zoneOffsetMinutes(zone, new Date(wall)) * 60_000;
  return new Date(wall - zoneOffsetMinutes(zone, new Date(first)) * 60_000);
}

// ------------------------------------------------------------------ who receives what

export type SkipReason = 'no_consent' | 'opted_out' | 'missing_variable' | 'merged';

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  no_consent: 'No marketing consent',
  opted_out: 'Opted out',
  missing_variable: 'Missing a variable value',
  merged: 'Merged into another contact',
};

/**
 * Whether a broadcast may go to this contact. Stricter than a one-to-one send: someone who said
 * STOP gets no broadcast at all, even a utility one, and marketing needs recorded consent.
 */
export function broadcastSkipReason(status: OptInStatus, category: string): SkipReason | null {
  if (status === 'opted_out') return 'opted_out';
  if (isMarketingCategory(category) && !canReceiveMarketing(status)) return 'no_consent';
  return null;
}

// ------------------------------------------------------------------ lifecycle

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'preparing',
  'running',
  'paused',
  'completed',
  'cancelled',
  'failed',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const RECIPIENT_STATUSES = [
  'pending',
  'sending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export type PauseCode =
  | 'manual'
  | 'insufficient_funds'
  | 'low_quality'
  | 'high_failure_rate'
  | 'template_not_approved'
  | 'number_disconnected';

/** Ticks only move forward. A failure counts unless the message already got further. */
export const RECIPIENT_RANK: Record<string, number> = {
  pending: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  replied: 5,
};

// ------------------------------------------------------------------ input

const name = z.string().trim().min(1, 'Give it a name').max(120);
const mapping = z.record(z.string(), variableSourceSchema).default({});

export const segmentAudienceSchema = z.object({
  type: z.literal('segment'),
  /** A saved segment. Its filter is copied when the campaign launches. */
  segmentId: z.uuid().optional(),
  /** Or an ad-hoc filter, such as every opted-in contact. */
  filter: segmentFilterSchema.optional(),
});

export const createCampaignSchema = z.object({
  name,
  phoneId: z.uuid(),
  templateId: z.uuid(),
  audience: segmentAudienceSchema.default({ type: 'segment' }),
  variableMapping: mapping,
});
export type CreateCampaignInput = z.input<typeof createCampaignSchema>;
export type CreateCampaignParsed = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = z.object({
  name: name.optional(),
  phoneId: z.uuid().optional(),
  templateId: z.uuid().optional(),
  audience: segmentAudienceSchema.optional(),
  variableMapping: z.record(z.string(), variableSourceSchema).optional(),
});
export type UpdateCampaignInput = z.input<typeof updateCampaignSchema>;

/** The columns of an uploaded audience file. */
export const campaignCsvOptionsSchema = z.object({
  phoneColumn: z.string().min(1, 'Choose the phone column').max(200),
  nameColumn: z.string().max(200).optional(),
  defaultCountry: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  /** Variable key -> CSV column. Wins over the variable mapping for that key. */
  variableColumns: z.record(z.string(), z.string().max(200)).default({}),
});
export type CampaignCsvOptions = z.infer<typeof campaignCsvOptionsSchema>;

/** Now, or at a wall-clock time in a time zone. */
export const launchCampaignSchema = z.discriminatedUnion('when', [
  z.object({ when: z.literal('now') }),
  z.object({
    when: z.literal('scheduled'),
    localTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'Choose a date and time'),
    timezone: z.string().refine(isValidTimeZone, 'Choose a valid time zone'),
  }),
]);
export type LaunchCampaignInput = z.infer<typeof launchCampaignSchema>;

export const listCampaignsSchema = z.object({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListCampaignsQuery = z.infer<typeof listCampaignsSchema>;

export const listRecipientsSchema = z.object({
  status: z.enum(RECIPIENT_STATUSES).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListRecipientsQuery = z.infer<typeof listRecipientsSchema>;

// ------------------------------------------------------------------ DTOs

/**
 * "Reached at least": a read message was also delivered and sent, so these read as a funnel.
 * `sending` includes those waiting to retry.
 */
export interface CampaignCounts {
  total: number;
  pending: number;
  sending: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export const emptyCounts = (): CampaignCounts => ({
  total: 0,
  pending: 0,
  sending: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  replied: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
});

/** From recipients grouped by their current status. */
export function toCampaignCounts(rows: { status: string; count: number }[]): CampaignCounts {
  const c = emptyCounts();
  const by = (s: string) => rows.find((r) => r.status === s)?.count ?? 0;
  c.pending = by('pending');
  c.sending = by('sending');
  c.replied = by('replied');
  c.read = by('read') + c.replied;
  c.delivered = by('delivered') + c.read;
  c.sent = by('sent') + c.delivered;
  c.failed = by('failed');
  c.skipped = by('skipped');
  c.cancelled = by('cancelled');
  c.total = rows.reduce((sum, r) => sum + r.count, 0);
  return c;
}

export interface CampaignDto {
  id: string;
  name: string;
  status: CampaignStatus;
  phoneId: string;
  phoneDisplay: string | null;
  templateId: string;
  templateName: string;
  templateCategory: string;
  audience: { type: 'segment' | 'csv'; segmentId?: string; filename?: string };
  variableMapping: Record<string, VariableSource>;
  scheduledAt: string | null;
  timezone: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  pauseCode: PauseCode | null;
  pauseReason: string | null;
  waitingUntil: string | null;
  estimateMicros: number;
  invalidRows: number;
  createdAt: string;
}

export interface CampaignReportDto {
  campaign: CampaignDto;
  counts: CampaignCounts;
  /** Net of refunds, from the ledger, so it always matches the wallet. */
  costMicros: number;
  currency: string;
  /** Failed out of those that were attempted. */
  failureRate: number;
}

export interface CampaignEstimateDto {
  total: number;
  sendable: number;
  skipped: Record<string, number>;
  estimateMicros: number;
  currency: string;
  /** Sendable contacts with no price set, which would not be sent. */
  unpriced: number;
  /** What the number can still send today, or null for no limit. */
  dailyRemaining: number | null;
  availableMicros: number;
}

export interface CampaignRecipientDto {
  id: string;
  contactId: string;
  contactName: string | null;
  waId: string;
  status: RecipientStatus;
  skipReason: string | null;
  errorMessage: string | null;
  sentAt: string | null;
  repliedAt: string | null;
}

// ------------------------------------------------------------------ drips

const delayMinutes = z.coerce
  .number()
  .int()
  .min(0, 'Use 0 or more')
  .max(60 * 24 * 365);

export const dripStepSchema = z.object({
  delayMinutes,
  templateId: z.uuid(),
  variableMapping: mapping,
});

export const saveDripSchema = z.object({
  name,
  phoneId: z.uuid(),
  exitOnReply: z.boolean().default(true),
  exitTagId: z.uuid().nullable().default(null),
  steps: z.array(dripStepSchema).min(1, 'Add at least one step').max(20),
});
export type SaveDripInput = z.input<typeof saveDripSchema>;
export type SaveDripParsed = z.infer<typeof saveDripSchema>;

export const setDripStatusSchema = z.object({ status: z.enum(['active', 'paused']) });

export const enrollDripSchema = z
  .object({
    segmentId: z.uuid().optional(),
    contactIds: z.array(z.uuid()).max(1000).optional(),
  })
  .refine((v) => v.segmentId || v.contactIds?.length, 'Choose who to enroll');
export type EnrollDripInput = z.infer<typeof enrollDripSchema>;

export interface DripStepDto {
  id: string;
  position: number;
  delayMinutes: number;
  templateId: string;
  templateName: string;
  variableMapping: Record<string, VariableSource>;
}

export interface DripDto {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused';
  phoneId: string;
  exitOnReply: boolean;
  exitTagId: string | null;
  steps: DripStepDto[];
  enrollments: { active: number; completed: number; exited: number };
  createdAt: string;
}

// ------------------------------------------------------------------ dashboard

export const analyticsRangeSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});
export type AnalyticsRangeQuery = z.infer<typeof analyticsRangeSchema>;

export interface VolumePoint {
  /** The day, in the workspace's time zone: 2026-11-06. */
  day: string;
  inbound: number;
  outbound: number;
}

export interface DashboardDto {
  days: number;
  timezone: string;
  volume: VolumePoint[];
  totals: { inbound: number; outbound: number };
  outbound: {
    attempted: number;
    delivered: number;
    read: number;
    failed: number;
    /** Null when nothing was sent. */
    deliveryRate: number | null;
    readRate: number | null;
    failureRate: number | null;
  };
  /** Time from a customer's message to the team's next reply. Null with no replies. */
  responseTime: { medianSeconds: number | null; replied: number };
  activeConversations: number;
}

export { OPT_IN_STATUSES };
