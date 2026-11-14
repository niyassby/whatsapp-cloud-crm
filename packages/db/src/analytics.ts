/**
 * Phase 4.3 analytics. Two halves:
 *
 * - The rollup (`rollupAnalytics`) recomputes a window of the aggregate tables from `messages`
 *   and `conversations`. It is the only code here that reads messages. It deletes and rewrites
 *   whole local hours, so running it twice, or over a window it already covered, gives the same
 *   rows. The worker runs it every 5 minutes for recent hours and hourly for the last 3 days
 *   (read receipts and replies arrive late); `rebuildAnalytics` redoes any span day by day.
 * - Reports (`conversationsReport` and the rest) read only the aggregates, the response and
 *   resolution rows, conversions, campaigns and referrals, so they stay fast at any size.
 *
 * Hours are stored as the organization's local wall-clock hour. Every statement filters on the
 * local time and also on a padded UTC range, so the messages index and partitions are used and a
 * daylight saving change cannot split an hour.
 *
 * Reviewed raw SQL: every value is a bound parameter, and it runs under the tenant's RLS context;
 * `org_id = ${orgId}` is repeated for the indexes.
 */
import {
  type AdsAttributionReportDto,
  type AgentsReportDto,
  type CampaignsReportDto,
  type ConversationsReportDto,
  decimalToMicros,
  HISTOGRAM_MAX_BUCKET,
  HISTOGRAM_RATIO,
  histogramPercentile,
  type ReportDto,
  type ReportKind,
  type ReportPeriod,
  type ReportRange,
  ratio,
  type TemplatesReportDto,
} from '@wacrm/shared';
import { Prisma } from './generated/prisma/client';
import type { TenantTx } from './tenant';

const DAY_MS = 86_400_000;

/**
 * Recompute every aggregate for the local hours that overlap [since, until]. One transaction:
 * readers see the old or the new hours, never a half-written one.
 */
export async function rollupAnalytics(
  tx: TenantTx,
  orgId: string,
  since: Date,
  until: Date,
): Promise<void> {
  // The window's local hours [fl, tl) in the org's own time zone, and a padded UTC range
  // [lo, hi) around them. Worked out once and passed to every statement as bound values: bounds
  // read from a join are not constants to the planner, which then scans every partition.
  const [w] = await tx.$queryRaw<{ tz: string; fl: string; tl: string; lo: Date; hi: Date }[]>`
    SELECT tz,
           to_char(fl, 'YYYY-MM-DD HH24:MI:SS') AS fl,
           to_char(tl, 'YYYY-MM-DD HH24:MI:SS') AS tl,
           (fl AT TIME ZONE tz) - interval '3 hours' AS lo,
           (tl AT TIME ZONE tz) + interval '3 hours' AS hi
    FROM (
      SELECT o.timezone AS tz,
             date_trunc('hour', ${since}::timestamptz AT TIME ZONE o.timezone) AS fl,
             date_trunc('hour', ${until}::timestamptz AT TIME ZONE o.timezone) + interval '1 hour' AS tl
      FROM organizations o WHERE o.id = ${orgId}::uuid
    ) b`;
  // Not visible under this context (another workspace): nothing to do.
  if (!w) return;
  const { tz, fl, tl, lo, hi } = w;

  // ---- messages per hour and channel
  await tx.$executeRaw`
    DELETE FROM analytics_hourly
    WHERE org_id = ${orgId}::uuid AND hour >= ${fl}::timestamp AND hour < ${tl}::timestamp`;

  await tx.$executeRaw`
    INSERT INTO analytics_hourly
      (org_id, hour, channel_id, inbound, outbound_human, outbound_automated, notes,
       sent, delivered, read, failed)
    SELECT ${orgId}::uuid, date_trunc('hour', m.created_at AT TIME ZONE ${tz}), c.channel_id,
           count(*) FILTER (WHERE m.direction = 'inbound'),
           count(*) FILTER (WHERE m.direction = 'outbound' AND m.sender_user_id IS NOT NULL),
           count(*) FILTER (WHERE m.direction = 'outbound' AND m.sender_user_id IS NULL),
           count(*) FILTER (WHERE m.direction = 'internal'),
           count(*) FILTER (WHERE m.direction = 'outbound' AND m.status IN ('sent', 'delivered', 'read')),
           count(*) FILTER (WHERE m.direction = 'outbound' AND m.status IN ('delivered', 'read')),
           count(*) FILTER (WHERE m.direction = 'outbound' AND m.status = 'read'),
           count(*) FILTER (WHERE m.direction = 'outbound' AND m.status = 'failed')
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.org_id = ${orgId}::uuid
      AND m.created_at >= ${lo}::timestamptz AND m.created_at < ${hi}::timestamptz
      AND (m.created_at AT TIME ZONE ${tz}) >= ${fl}::timestamp
      AND (m.created_at AT TIME ZONE ${tz}) < ${tl}::timestamp
    GROUP BY 2, 3`;

  await tx.$executeRaw`
    INSERT INTO analytics_hourly (org_id, hour, channel_id, new_conversations)
    SELECT ${orgId}::uuid, date_trunc('hour', c.created_at AT TIME ZONE ${tz}), c.channel_id, count(*)
    FROM conversations c
    WHERE c.org_id = ${orgId}::uuid
      AND c.created_at >= ${lo}::timestamptz AND c.created_at < ${hi}::timestamptz
      AND (c.created_at AT TIME ZONE ${tz}) >= ${fl}::timestamp
      AND (c.created_at AT TIME ZONE ${tz}) < ${tl}::timestamp
    GROUP BY 2, 3
    ON CONFLICT (org_id, hour, channel_id)
      DO UPDATE SET new_conversations = EXCLUDED.new_conversations`;

  // ---- what each person sent
  await tx.$executeRaw`
    DELETE FROM analytics_agent_hourly
    WHERE org_id = ${orgId}::uuid AND hour >= ${fl}::timestamp AND hour < ${tl}::timestamp`;

  await tx.$executeRaw`
    INSERT INTO analytics_agent_hourly (org_id, hour, user_id, messages, notes)
    SELECT ${orgId}::uuid, date_trunc('hour', m.created_at AT TIME ZONE ${tz}), m.sender_user_id,
           count(*) FILTER (WHERE m.direction = 'outbound'),
           count(*) FILTER (WHERE m.direction = 'internal')
    FROM messages m
    WHERE m.org_id = ${orgId}::uuid AND m.sender_user_id IS NOT NULL
      AND m.created_at >= ${lo}::timestamptz AND m.created_at < ${hi}::timestamptz
      AND (m.created_at AT TIME ZONE ${tz}) >= ${fl}::timestamp
      AND (m.created_at AT TIME ZONE ${tz}) < ${tl}::timestamp
    GROUP BY 2, 3`;

  // ---- templates, by the hour they were sent; a reply within 24 hours counts
  await tx.$executeRaw`
    DELETE FROM analytics_template_hourly
    WHERE org_id = ${orgId}::uuid AND hour >= ${fl}::timestamp AND hour < ${tl}::timestamp`;

  await tx.$executeRaw`
    INSERT INTO analytics_template_hourly
      (org_id, hour, template_id, attempted, delivered, read, failed, replied)
    SELECT ${orgId}::uuid, date_trunc('hour', m.created_at AT TIME ZONE ${tz}),
           (m.content->>'templateId')::uuid,
           count(*),
           count(*) FILTER (WHERE m.status IN ('delivered', 'read')),
           count(*) FILTER (WHERE m.status = 'read'),
           count(*) FILTER (WHERE m.status = 'failed'),
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM messages r
             WHERE r.conversation_id = m.conversation_id AND r.direction = 'inbound'
               AND r.created_at > m.created_at AND r.created_at <= m.created_at + interval '24 hours'
               -- A fixed upper bound as well, so only the partitions in range are searched.
               AND r.created_at < ${hi}::timestamptz + interval '24 hours'
           ))
    FROM messages m
    WHERE m.org_id = ${orgId}::uuid AND m.direction = 'outbound' AND m.type = 'template'
      AND m.content->>'templateId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND m.created_at >= ${lo}::timestamptz AND m.created_at < ${hi}::timestamptz
      AND (m.created_at AT TIME ZONE ${tz}) >= ${fl}::timestamp
      AND (m.created_at AT TIME ZONE ${tz}) < ${tl}::timestamp
    GROUP BY 2, 3`;

  // ---- responses: a person's first reply after a customer started waiting. The customer
  // waits from their first message after the last reply by a person (automated messages do not
  // answer anyone), looking back at most 7 days.
  await tx.$executeRaw`
    DELETE FROM analytics_responses
    WHERE org_id = ${orgId}::uuid
      AND responded_at >= ${lo}::timestamptz AND responded_at < ${hi}::timestamptz
      AND (responded_at AT TIME ZONE ${tz}) >= ${fl}::timestamp
      AND (responded_at AT TIME ZONE ${tz}) < ${tl}::timestamp`;

  await tx.$executeRaw`
    INSERT INTO analytics_responses
      (org_id, message_id, conversation_id, channel_id, user_id, customer_at, responded_at, seconds)
    SELECT ${orgId}::uuid, m.id, m.conversation_id, c.channel_id, m.sender_user_id,
           w.customer_at, m.created_at,
           GREATEST(0, floor(EXTRACT(EPOCH FROM (m.created_at - w.customer_at))))::int
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    CROSS JOIN LATERAL (
      SELECT max(p.created_at) AS at FROM messages p
      WHERE p.conversation_id = m.conversation_id AND p.direction = 'outbound'
        AND p.sender_user_id IS NOT NULL
        AND p.created_at < m.created_at AND p.created_at > m.created_at - interval '7 days'
        AND p.created_at >= ${lo}::timestamptz - interval '7 days'
        AND p.created_at < ${hi}::timestamptz
    ) prev
    CROSS JOIN LATERAL (
      SELECT min(i.created_at) AS customer_at FROM messages i
      WHERE i.conversation_id = m.conversation_id AND i.direction = 'inbound'
        AND i.created_at < m.created_at
        AND i.created_at > COALESCE(prev.at, m.created_at - interval '7 days')
        AND i.created_at >= ${lo}::timestamptz - interval '7 days'
        AND i.created_at < ${hi}::timestamptz
    ) w
    WHERE m.org_id = ${orgId}::uuid AND m.direction = 'outbound' AND m.sender_user_id IS NOT NULL
      AND w.customer_at IS NOT NULL
      AND m.created_at >= ${lo}::timestamptz AND m.created_at < ${hi}::timestamptz
      AND (m.created_at AT TIME ZONE ${tz}) >= ${fl}::timestamp
      AND (m.created_at AT TIME ZONE ${tz}) < ${tl}::timestamp`;

  // ---- histograms of response and resolution times, for percentiles over long ranges
  await tx.$executeRaw`
    DELETE FROM analytics_response_hist
    WHERE org_id = ${orgId}::uuid AND hour >= ${fl}::timestamp AND hour < ${tl}::timestamp`;
  await tx.$executeRaw`
    INSERT INTO analytics_response_hist (org_id, hour, channel_id, user_id, bucket, n)
    SELECT ${orgId}::uuid, date_trunc('hour', responded_at AT TIME ZONE ${tz}), channel_id, user_id,
           ${HISTOGRAM_BUCKET_SQL}, count(*)
    FROM analytics_responses
    WHERE org_id = ${orgId}::uuid
      AND responded_at >= ${lo}::timestamptz AND responded_at < ${hi}::timestamptz
      AND (responded_at AT TIME ZONE ${tz}) >= ${fl}::timestamp
      AND (responded_at AT TIME ZONE ${tz}) < ${tl}::timestamp
    GROUP BY 2, 3, 4, 5`;

  await tx.$executeRaw`
    DELETE FROM analytics_resolution_hist
    WHERE org_id = ${orgId}::uuid AND hour >= ${fl}::timestamp AND hour < ${tl}::timestamp`;
  await tx.$executeRaw`
    INSERT INTO analytics_resolution_hist (org_id, hour, channel_id, assignee_id, bucket, n)
    SELECT ${orgId}::uuid, date_trunc('hour', closed_at AT TIME ZONE ${tz}), channel_id,
           COALESCE(assignee_id, ${NIL_UUID}::uuid), ${HISTOGRAM_BUCKET_SQL}, count(*)
    FROM conversation_resolutions
    WHERE org_id = ${orgId}::uuid
      AND closed_at >= ${lo}::timestamptz AND closed_at < ${hi}::timestamptz
      AND (closed_at AT TIME ZONE ${tz}) >= ${fl}::timestamp
      AND (closed_at AT TIME ZONE ${tz}) < ${tl}::timestamp
    GROUP BY 2, 3, 4, 5`;
}

/**
 * Redo a span one day at a time, each in its own transaction, so a year of history never holds
 * one huge transaction. `run` opens the tenant transaction.
 */
export async function rebuildAnalytics(
  run: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>,
  orgId: string,
  since: Date,
  until = new Date(),
): Promise<number> {
  let days = 0;
  for (let start = since.getTime(); start < until.getTime(); start += DAY_MS) {
    const end = Math.min(start + DAY_MS - 1, until.getTime());
    await run((tx) => rollupAnalytics(tx, orgId, new Date(start), new Date(end)));
    days++;
  }
  return days;
}

// ------------------------------------------------------------------ conversions

export const CONVERSION_SOURCES = ['store_order', 'payment', 'whatsapp_order'] as const;
export type ConversionSource = (typeof CONVERSION_SOURCES)[number];

/** A broadcast is credited with a sale within 72 hours, the same window as replies. */
const CAMPAIGN_WINDOW_MS = 72 * 3_600_000;
/** An ad is credited with a sale within 7 days of the click. */
const AD_WINDOW_MS = 7 * DAY_MS;

/**
 * Record money a contact spent, once per outside reference, crediting the latest broadcast and
 * ad that reached them. Returns false for a repeat, or an amount that is not a number.
 */
export async function recordConversion(
  tx: TenantTx,
  input: {
    orgId: string;
    contactId: string;
    source: ConversionSource;
    reference: string;
    amount: string;
    currency: string;
    occurredAt?: Date;
  },
): Promise<boolean> {
  const amountMicros = decimalToMicros(input.amount.replace(/[,\s]/g, ''));
  if (amountMicros === null || amountMicros <= 0 || !input.reference) return false;
  const at = input.occurredAt ?? new Date();
  const [campaign, ad] = await Promise.all([
    tx.campaignRecipient.findFirst({
      where: {
        contactId: input.contactId,
        sentAt: { gte: new Date(at.getTime() - CAMPAIGN_WINDOW_MS), lte: at },
      },
      orderBy: { sentAt: 'desc' },
      select: { campaignId: true },
    }),
    tx.adReferral.findFirst({
      where: {
        contactId: input.contactId,
        createdAt: { gte: new Date(at.getTime() - AD_WINDOW_MS), lte: at },
        sourceId: { not: null },
        NOT: { sourceType: 'qr' },
      },
      orderBy: { createdAt: 'desc' },
      select: { sourceId: true },
    }),
  ]);
  const created = await tx.conversion.createMany({
    data: {
      orgId: input.orgId,
      contactId: input.contactId,
      source: input.source,
      reference: input.reference.slice(0, 300),
      amountMicros: BigInt(amountMicros),
      currency: input.currency.toUpperCase().slice(0, 3),
      occurredAt: at,
      campaignId: campaign?.campaignId ?? null,
      adSourceId: ad?.sourceId ?? null,
    },
    skipDuplicates: true,
  });
  return created.count > 0;
}

// ------------------------------------------------------------------ reports

/** The same bucket as `histogramBucket` in @wacrm/shared, on a `seconds` column. */
const HISTOGRAM_BUCKET_SQL = Prisma.sql`(CASE WHEN seconds < 1 THEN 0
  ELSE LEAST(floor(ln(seconds) / ln(${HISTOGRAM_RATIO}::float8))::int + 1, ${HISTOGRAM_MAX_BUCKET}::int) END)`;

/** Unassigned resolutions in the histogram, whose key cannot be null. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Up to this many responses or resolutions in a range, percentiles are exact, from the rows.
 * Above it they come from the hourly histograms (within about 5%), so a report never sorts
 * millions of rows.
 */
export const EXACT_PERCENTILE_LIMIT = 20_000;

type DurationGroup = 'total' | 'day' | 'channel' | 'user';
export interface DurationStats {
  n: number;
  median: number | null;
  p90: number | null;
}

const DURATION_SOURCES = {
  responses: {
    hist: Prisma.raw('analytics_response_hist'),
    rows: Prisma.raw('analytics_responses'),
    at: Prisma.raw('responded_at'),
    person: Prisma.raw('user_id'),
  },
  resolutions: {
    hist: Prisma.raw('analytics_resolution_hist'),
    rows: Prisma.raw('conversation_resolutions'),
    at: Prisma.raw('closed_at'),
    person: Prisma.raw('assignee_id'),
  },
} as const;

/**
 * Count, median and 90th percentile of response or resolution times in a period, grouped by
 * day, channel or person ('' for the total). Reviewed SQL: the table and column names are fixed
 * fragments above, every value is a bound parameter.
 */
async function durationStats(
  tx: TenantTx,
  orgId: string,
  period: ReportPeriod,
  source: keyof typeof DURATION_SOURCES,
  group: DurationGroup,
): Promise<Map<string, DurationStats>> {
  const src = DURATION_SOURCES[source];
  const fl = localStart(period);
  const tl = localEnd(period);
  const tz = period.timezone;
  const histKey =
    group === 'day'
      ? Prisma.sql`to_char(hour, 'YYYY-MM-DD')`
      : group === 'channel'
        ? Prisma.sql`channel_id::text`
        : group === 'user'
          ? Prisma.sql`${src.person}::text`
          : Prisma.sql`''`;
  const hist = await tx.$queryRaw<{ k: string; bucket: number; n: bigint }[]>`
    SELECT ${histKey} AS k, bucket, sum(n)::bigint AS n
    FROM ${src.hist}
    WHERE org_id = ${orgId}::uuid AND hour >= ${fl}::timestamp AND hour < ${tl}::timestamp
    GROUP BY 1, 2`;
  const total = hist.reduce((s, r) => s + num(r.n), 0);
  const out = new Map<string, DurationStats>();

  if (total <= EXACT_PERCENTILE_LIMIT) {
    const rowKey =
      group === 'day'
        ? Prisma.sql`to_char(${src.at} AT TIME ZONE ${tz}, 'YYYY-MM-DD')`
        : group === 'channel'
          ? Prisma.sql`channel_id::text`
          : group === 'user'
            ? Prisma.sql`COALESCE(${src.person}::text, ${NIL_UUID})`
            : Prisma.sql`''`;
    const rows = await tx.$queryRaw<
      { k: string; n: bigint; median: number | null; p90: number | null }[]
    >`
      SELECT ${rowKey} AS k, count(*)::bigint AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::float8 AS median,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY seconds)::float8 AS p90
      FROM ${src.rows}
      WHERE org_id = ${orgId}::uuid
        AND ${src.at} >= (${fl}::timestamp AT TIME ZONE ${tz})
        AND ${src.at} < (${tl}::timestamp AT TIME ZONE ${tz})
      GROUP BY 1`;
    for (const r of rows) {
      out.set(r.k, { n: num(r.n), median: numOrNull(r.median), p90: numOrNull(r.p90) });
    }
    return out;
  }

  const byKey = new Map<string, Map<number, number>>();
  for (const r of hist) {
    const counts = byKey.get(r.k) ?? new Map<number, number>();
    counts.set(Number(r.bucket), (counts.get(Number(r.bucket)) ?? 0) + num(r.n));
    byKey.set(r.k, counts);
  }
  for (const [k, counts] of byKey) {
    out.set(k, {
      n: [...counts.values()].reduce((a, b) => a + b, 0),
      median: histogramPercentile(counts, 0.5),
      p90: histogramPercentile(counts, 0.9),
    });
  }
  return out;
}

const num = (v: bigint | number | null | undefined) => Number(v ?? 0);
const numOrNull = (v: number | null | undefined) =>
  v === null || v === undefined ? null : Number(v);

async function periodOf(tx: TenantTx, orgId: string, range: ReportRange): Promise<ReportPeriod> {
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { timezone: true },
  });
  return { from: range.from, to: range.to, timezone: org.timezone };
}

async function walletCurrency(tx: TenantTx, orgId: string): Promise<string> {
  const wallet = await tx.wallet.findUnique({ where: { orgId }, select: { currency: true } });
  return wallet?.currency ?? 'INR';
}

/** Local day bounds of a range: [from 00:00, the day after `to` 00:00). */
const localStart = (p: ReportPeriod) => `${p.from} 00:00:00`;
const localEnd = (p: ReportPeriod) => {
  const next = new Date(Date.parse(`${p.to}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  return `${next} 00:00:00`;
};

/** Every day of the range, so a quiet day shows as zero. */
function eachDay(p: ReportPeriod): string[] {
  const days: string[] = [];
  for (
    let t = Date.parse(`${p.from}T00:00:00Z`);
    t <= Date.parse(`${p.to}T00:00:00Z`);
    t += DAY_MS
  ) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

export async function conversationsReport(
  tx: TenantTx,
  orgId: string,
  range: ReportRange,
): Promise<ConversationsReportDto> {
  const period = await periodOf(tx, orgId, range);
  const fl = localStart(period);
  const tl = localEnd(period);

  const [
    hourly,
    byHour,
    byChannel,
    responses,
    responseDaily,
    responseChannel,
    resolutions,
    resolutionDaily,
    open,
  ] = await Promise.all([
    tx.$queryRaw<
      {
        day: string;
        inbound: bigint;
        human: bigint;
        automated: bigint;
        notes: bigint;
        new_conversations: bigint;
      }[]
    >`
        SELECT to_char(hour, 'YYYY-MM-DD') AS day, sum(inbound)::bigint AS inbound,
               sum(outbound_human)::bigint AS human, sum(outbound_automated)::bigint AS automated,
               sum(notes)::bigint AS notes, sum(new_conversations)::bigint AS new_conversations
        FROM analytics_hourly
        WHERE org_id = ${orgId}::uuid AND hour >= ${fl}::timestamp AND hour < ${tl}::timestamp
        GROUP BY 1`,
    tx.$queryRaw<{ h: number; inbound: bigint; outbound: bigint }[]>`
        SELECT EXTRACT(HOUR FROM hour)::int AS h, sum(inbound)::bigint AS inbound,
               sum(outbound_human + outbound_automated)::bigint AS outbound
        FROM analytics_hourly
        WHERE org_id = ${orgId}::uuid AND hour >= ${fl}::timestamp AND hour < ${tl}::timestamp
        GROUP BY 1`,
    tx.$queryRaw<
      { channel_id: string; name: string; kind: string; inbound: bigint; outbound: bigint }[]
    >`
        SELECT a.channel_id, ch.name, ch.kind::text AS kind, sum(a.inbound)::bigint AS inbound,
               sum(a.outbound_human + a.outbound_automated)::bigint AS outbound
        FROM analytics_hourly a JOIN channels ch ON ch.id = a.channel_id
        WHERE a.org_id = ${orgId}::uuid AND a.hour >= ${fl}::timestamp AND a.hour < ${tl}::timestamp
        GROUP BY 1, 2, 3
        ORDER BY 4 DESC`,
    durationStats(tx, orgId, period, 'responses', 'total'),
    durationStats(tx, orgId, period, 'responses', 'day'),
    durationStats(tx, orgId, period, 'responses', 'channel'),
    durationStats(tx, orgId, period, 'resolutions', 'total'),
    durationStats(tx, orgId, period, 'resolutions', 'day'),
    tx.conversation.count({ where: { orgId, status: 'open' } }),
  ]);

  const hourlyByDay = new Map(hourly.map((r) => [r.day, r]));
  const respByDay = responseDaily;
  const resolvedByDay = resolutionDaily;
  const resolvedTotal = resolutions.get('');
  const sum = (key: 'inbound' | 'human' | 'automated' | 'notes' | 'new_conversations') =>
    hourly.reduce((s, r) => s + num(r[key]), 0);
  const hours = new Map(byHour.map((r) => [r.h, r]));
  const channelMedian = new Map([...responseChannel].map(([k, v]) => [k, v.median]));
  const resp = responses.get('');

  return {
    kind: 'conversations',
    period,
    totals: {
      inbound: sum('inbound'),
      outboundHuman: sum('human'),
      outboundAutomated: sum('automated'),
      notes: sum('notes'),
      newConversations: sum('new_conversations'),
      responses: resp?.n ?? 0,
      medianResponseSeconds: resp?.median ?? null,
      p90ResponseSeconds: resp?.p90 ?? null,
      resolved: resolvedTotal?.n ?? 0,
      medianResolutionSeconds: resolvedTotal?.median ?? null,
      openNow: open,
    },
    daily: eachDay(period).map((day) => {
      const h = hourlyByDay.get(day);
      const r = respByDay.get(day);
      return {
        day,
        inbound: num(h?.inbound),
        outbound: num(h?.human) + num(h?.automated),
        newConversations: num(h?.new_conversations),
        responses: r?.n ?? 0,
        medianResponseSeconds: r?.median ?? null,
        resolved: resolvedByDay.get(day)?.n ?? 0,
      };
    }),
    byHour: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      inbound: num(hours.get(hour)?.inbound),
      outbound: num(hours.get(hour)?.outbound),
    })),
    byChannel: byChannel.map((c) => ({
      channelId: c.channel_id,
      name: c.name,
      kind: c.kind,
      inbound: num(c.inbound),
      outbound: num(c.outbound),
      medianResponseSeconds: numOrNull(channelMedian.get(c.channel_id)),
    })),
  };
}

export async function agentsReport(
  tx: TenantTx,
  orgId: string,
  range: ReportRange,
): Promise<AgentsReportDto> {
  const period = await periodOf(tx, orgId, range);
  const fl = localStart(period);
  const tl = localEnd(period);

  const [members, sent, responses, resolutions, open] = await Promise.all([
    tx.membership.findMany({
      where: { orgId },
      select: { userId: true, status: true, user: { select: { name: true, email: true } } },
    }),
    tx.$queryRaw<{ user_id: string; messages: bigint; notes: bigint }[]>`
      SELECT user_id, sum(messages)::bigint AS messages, sum(notes)::bigint AS notes
      FROM analytics_agent_hourly
      WHERE org_id = ${orgId}::uuid AND hour >= ${fl}::timestamp AND hour < ${tl}::timestamp
      GROUP BY 1`,
    durationStats(tx, orgId, period, 'responses', 'user'),
    durationStats(tx, orgId, period, 'resolutions', 'user'),
    tx.conversation.groupBy({
      by: ['assigneeId'],
      where: { orgId, status: 'open', assigneeId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const sentBy = new Map(sent.map((r) => [r.user_id, r]));
  const respBy = responses;
  const resBy = resolutions;
  const openBy = new Map(open.map((r) => [r.assigneeId, r._count._all]));

  const rows = members
    .map((m) => ({
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      messages: num(sentBy.get(m.userId)?.messages),
      notes: num(sentBy.get(m.userId)?.notes),
      responses: respBy.get(m.userId)?.n ?? 0,
      medianResponseSeconds: respBy.get(m.userId)?.median ?? null,
      resolved: resBy.get(m.userId)?.n ?? 0,
      medianResolutionSeconds: resBy.get(m.userId)?.median ?? null,
      openAssigned: openBy.get(m.userId) ?? 0,
      active: m.status === 'active',
    }))
    // People who left stay in the report for the period they worked.
    .filter((r) => r.active || r.messages + r.notes + r.responses + r.resolved > 0)
    .sort((a, b) => b.responses - a.responses || b.messages - a.messages)
    .map(({ active: _active, ...r }) => r);

  return { kind: 'agents', period, rows };
}

export async function campaignsReport(
  tx: TenantTx,
  orgId: string,
  range: ReportRange,
): Promise<CampaignsReportDto> {
  const period = await periodOf(tx, orgId, range);
  const currency = await walletCurrency(tx, orgId);
  const tz = period.timezone;
  const fl = localStart(period);
  const tl = localEnd(period);

  const campaigns = await tx.$queryRaw<
    { id: string; name: string; status: string; started_at: Date | null; template: string }[]
  >`
    SELECT c.id, c.name, c.status::text AS status, c.started_at, t.name AS template
    FROM campaigns c JOIN message_templates t ON t.id = c.template_id
    WHERE c.org_id = ${orgId}::uuid AND c.started_at IS NOT NULL
      AND c.started_at >= (${fl}::timestamp AT TIME ZONE ${tz})
      AND c.started_at < (${tl}::timestamp AT TIME ZONE ${tz})
    ORDER BY c.started_at DESC
    LIMIT 200`;
  const ids = campaigns.map((c) => c.id);
  if (ids.length === 0) {
    return {
      kind: 'campaigns',
      period,
      currency,
      rows: [],
      totals: { costMicros: 0, conversions: 0, revenueMicros: 0, roi: null },
    };
  }

  const [counts, costs, conversions] = await Promise.all([
    tx.$queryRaw<{ campaign_id: string; status: string; n: bigint }[]>`
      SELECT campaign_id, status::text AS status, count(*)::bigint AS n
      FROM campaign_recipients
      WHERE campaign_id = ANY(${ids}::uuid[])
      GROUP BY 1, 2`,
    tx.$queryRaw<{ campaign_id: string; total: bigint | null }[]>`
      SELECT r.campaign_id, SUM(l.amount_micros)::bigint AS total
      FROM campaign_recipients r
      JOIN wallet_ledger l
        ON l.org_id = r.org_id AND l.reference_type = 'message'
       AND l.reference_id = r.message_id::text
      WHERE r.campaign_id = ANY(${ids}::uuid[]) AND r.message_id IS NOT NULL
      GROUP BY 1`,
    tx.$queryRaw<{ campaign_id: string; n: bigint; revenue: bigint | null }[]>`
      SELECT campaign_id, count(*)::bigint AS n, SUM(amount_micros)::bigint AS revenue
      FROM conversions
      WHERE org_id = ${orgId}::uuid AND campaign_id = ANY(${ids}::uuid[]) AND currency = ${currency}
      GROUP BY 1`,
  ]);

  const statusCount = (id: string, ...statuses: string[]) =>
    counts
      .filter((c) => c.campaign_id === id && statuses.includes(c.status))
      .reduce((s, c) => s + num(c.n), 0);
  const costBy = new Map(costs.map((c) => [c.campaign_id, -num(c.total)]));
  const convBy = new Map(conversions.map((c) => [c.campaign_id, c]));
  const roi = (revenue: number, cost: number) => (cost > 0 ? (revenue - cost) / cost : null);

  const rows = campaigns.map((c) => {
    const costMicros = costBy.get(c.id) ?? 0;
    const revenueMicros = num(convBy.get(c.id)?.revenue);
    return {
      campaignId: c.id,
      name: c.name,
      status: c.status,
      startedAt: c.started_at?.toISOString() ?? null,
      templateName: c.template,
      recipients: counts.filter((x) => x.campaign_id === c.id).reduce((s, x) => s + num(x.n), 0),
      skipped: statusCount(c.id, 'skipped', 'cancelled'),
      sent: statusCount(c.id, 'sent', 'delivered', 'read', 'replied'),
      delivered: statusCount(c.id, 'delivered', 'read', 'replied'),
      read: statusCount(c.id, 'read', 'replied'),
      replied: statusCount(c.id, 'replied'),
      failed: statusCount(c.id, 'failed'),
      costMicros,
      conversions: num(convBy.get(c.id)?.n),
      revenueMicros,
      roi: roi(revenueMicros, costMicros),
    };
  });
  const costMicros = rows.reduce((s, r) => s + r.costMicros, 0);
  const revenueMicros = rows.reduce((s, r) => s + r.revenueMicros, 0);
  return {
    kind: 'campaigns',
    period,
    currency,
    rows,
    totals: {
      costMicros,
      revenueMicros,
      conversions: rows.reduce((s, r) => s + r.conversions, 0),
      roi: roi(revenueMicros, costMicros),
    },
  };
}

export async function templatesReport(
  tx: TenantTx,
  orgId: string,
  range: ReportRange,
): Promise<TemplatesReportDto> {
  const period = await periodOf(tx, orgId, range);
  const rows = await tx.$queryRaw<
    {
      template_id: string;
      name: string | null;
      language: string | null;
      category: string | null;
      attempted: bigint;
      delivered: bigint;
      read: bigint;
      failed: bigint;
      replied: bigint;
    }[]
  >`
    SELECT a.template_id, t.name, t.language, t.category,
           sum(a.attempted)::bigint AS attempted, sum(a.delivered)::bigint AS delivered,
           sum(a.read)::bigint AS read, sum(a.failed)::bigint AS failed,
           sum(a.replied)::bigint AS replied
    FROM analytics_template_hourly a
    LEFT JOIN message_templates t ON t.id = a.template_id
    WHERE a.org_id = ${orgId}::uuid
      AND a.hour >= ${localStart(period)}::timestamp AND a.hour < ${localEnd(period)}::timestamp
    GROUP BY 1, 2, 3, 4
    ORDER BY 5 DESC
    LIMIT 500`;
  return {
    kind: 'templates',
    period,
    rows: rows.map((r) => {
      const attempted = num(r.attempted);
      return {
        templateId: r.template_id,
        name: r.name ?? 'Deleted template',
        language: r.language ?? '',
        category: r.category ?? '',
        attempted,
        delivered: num(r.delivered),
        read: num(r.read),
        failed: num(r.failed),
        replied: num(r.replied),
        deliveryRate: ratio(num(r.delivered), attempted),
        readRate: ratio(num(r.read), attempted),
        replyRate: ratio(num(r.replied), attempted),
      };
    }),
  };
}

export async function adsReport(
  tx: TenantTx,
  orgId: string,
  range: ReportRange,
): Promise<AdsAttributionReportDto> {
  const period = await periodOf(tx, orgId, range);
  const currency = await walletCurrency(tx, orgId);
  const tz = period.timezone;
  const fl = localStart(period);
  const tl = localEnd(period);
  const [rows, conversions] = await Promise.all([
    tx.$queryRaw<
      {
        source_id: string | null;
        headline: string | null;
        source_url: string | null;
        referrals: bigint;
        conversations: bigint;
        new_contacts: bigint;
        replied: bigint;
        first_at: Date;
        last_at: Date;
      }[]
    >`
      SELECT r.source_id,
             (array_agg(r.headline ORDER BY r.created_at DESC))[1] AS headline,
             (array_agg(r.source_url ORDER BY r.created_at DESC))[1] AS source_url,
             count(*)::bigint AS referrals,
             count(DISTINCT r.conversation_id)::bigint AS conversations,
             count(*) FILTER (WHERE r.new_contact)::bigint AS new_contacts,
             count(DISTINCT r.conversation_id) FILTER (WHERE EXISTS (
               SELECT 1 FROM analytics_responses a
               WHERE a.conversation_id = r.conversation_id
                 AND a.responded_at >= r.message_created_at
             ))::bigint AS replied,
             min(r.created_at) AS first_at,
             max(r.created_at) AS last_at
      FROM ad_referrals r
      WHERE r.org_id = ${orgId}::uuid AND COALESCE(r.source_type, '') <> 'qr'
        AND r.created_at >= (${fl}::timestamp AT TIME ZONE ${tz})
        AND r.created_at < (${tl}::timestamp AT TIME ZONE ${tz})
      GROUP BY r.source_id
      ORDER BY count(*) DESC
      LIMIT 200`,
    tx.$queryRaw<{ ad_source_id: string; n: bigint; revenue: bigint | null }[]>`
      SELECT ad_source_id, count(*)::bigint AS n, SUM(amount_micros)::bigint AS revenue
      FROM conversions
      WHERE org_id = ${orgId}::uuid AND ad_source_id IS NOT NULL AND currency = ${currency}
        AND occurred_at >= (${fl}::timestamp AT TIME ZONE ${tz})
        AND occurred_at < (${tl}::timestamp AT TIME ZONE ${tz})
      GROUP BY 1`,
  ]);
  const convBy = new Map(conversions.map((c) => [c.ad_source_id, c]));
  return {
    kind: 'ads',
    period,
    currency,
    rows: rows.map((r) => ({
      sourceId: r.source_id,
      headline: r.headline,
      sourceUrl: r.source_url,
      referrals: num(r.referrals),
      conversations: num(r.conversations),
      newContacts: num(r.new_contacts),
      replied: num(r.replied),
      conversions: num(r.source_id ? convBy.get(r.source_id)?.n : 0),
      revenueMicros: num(r.source_id ? convBy.get(r.source_id)?.revenue : 0),
      firstAt: r.first_at.toISOString(),
      lastAt: r.last_at.toISOString(),
    })),
  };
}

export function buildReport(
  tx: TenantTx,
  orgId: string,
  kind: ReportKind,
  range: ReportRange,
): Promise<ReportDto> {
  switch (kind) {
    case 'conversations':
      return conversationsReport(tx, orgId, range);
    case 'agents':
      return agentsReport(tx, orgId, range);
    case 'campaigns':
      return campaignsReport(tx, orgId, range);
    case 'templates':
      return templatesReport(tx, orgId, range);
    case 'ads':
      return adsReport(tx, orgId, range);
  }
}
