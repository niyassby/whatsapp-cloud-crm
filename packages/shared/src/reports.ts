/**
 * Reports (Phase 4.3): what can be asked for, the shapes that come back, schedules, and the table
 * form that CSV, PDF and email are all made from. Reports read the aggregate tables the worker
 * keeps (packages/db/src/analytics.ts), never the messages table.
 */
import { z } from 'zod';
import { csvCell } from './contacts';
import { formatMoney } from './wallet';

export const REPORT_KINDS = ['conversations', 'agents', 'campaigns', 'templates', 'ads'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_LABELS: Record<ReportKind, string> = {
  conversations: 'Conversations',
  agents: 'Team performance',
  campaigns: 'Campaigns and conversions',
  templates: 'Templates',
  ads: 'Ad attribution',
};

export const REPORT_FORMATS = ['csv', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** The longest range one report covers. */
export const MAX_REPORT_DAYS = 366;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-01');

/** Both ends are days in the workspace's time zone, and both are included. */
export const reportRangeSchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((r) => r.from <= r.to, { message: 'The start must be before the end', path: ['to'] })
  .refine((r) => daysBetween(r.from, r.to) < MAX_REPORT_DAYS, {
    message: `At most ${MAX_REPORT_DAYS} days at a time`,
    path: ['from'],
  });
export type ReportRange = z.infer<typeof reportRangeSchema>;

export const reportExportSchema = z.object({ format: z.enum(REPORT_FORMATS) });

/** Days from one date to another: 0 for the same day. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ time zones

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall-clock time of an instant in a time zone. */
export function localParts(at: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

/** Today's date in a time zone, as YYYY-MM-DD. */
export function localDate(at: Date, timezone: string): string {
  const p = localParts(at, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * The instant a local wall-clock time happens in a time zone. A time skipped by a daylight
 * saving change lands just after the change.
 */
export function zonedToUtc(day: string, hour: number, timezone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wanted = Date.UTC(y, m - 1, d, hour);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), timezone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = wanted - shown;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/** The last `days` days in a time zone, ending today. */
export function lastDays(days: number, timezone: string, now = new Date()): ReportRange {
  const to = localDate(now, timezone);
  return { from: addDays(to, -(days - 1)), to };
}

// ------------------------------------------------------------------ schedules

export const REPORT_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

export const reportScheduleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  report: z.enum(REPORT_KINDS),
  frequency: z.enum(REPORT_FREQUENCIES),
  format: z.enum(REPORT_FORMATS),
  recipientIds: z.array(z.uuid()).min(1, 'Choose at least one person').max(20),
  hour: z.number().int().min(0).max(23).default(8),
  active: z.boolean().default(true),
});
export type ReportScheduleInput = z.infer<typeof reportScheduleSchema>;
export const updateReportScheduleSchema = reportScheduleSchema.partial();

/**
 * The next time a schedule runs after `after`: every day, every Monday, or on the 1st, at its
 * local hour.
 */
export function nextScheduleRun(
  frequency: ReportFrequency,
  hour: number,
  timezone: string,
  after: Date,
): Date {
  let day = localDate(after, timezone);
  for (let i = 0; i < 400; i++) {
    const at = zonedToUtc(day, hour, timezone);
    const p = localParts(at, timezone);
    const fits =
      frequency === 'daily' ||
      (frequency === 'weekly' && p.weekday === 1) ||
      (frequency === 'monthly' && p.day === 1);
    if (fits && at.getTime() > after.getTime()) return at;
    day = addDays(day, 1);
  }
  throw new Error('No next run found');
}

/** What a scheduled email covers: the whole period before the day it runs. */
export function schedulePeriod(
  frequency: ReportFrequency,
  runAt: Date,
  timezone: string,
): ReportRange {
  const today = localDate(runAt, timezone);
  const to = addDays(today, -1);
  if (frequency === 'daily') return { from: to, to };
  if (frequency === 'weekly') return { from: addDays(today, -7), to };
  const [y, m] = to.split('-').map(Number) as [number, number];
  return { from: `${y}-${String(m).padStart(2, '0')}-01`, to };
}

export interface ReportScheduleDto {
  id: string;
  name: string;
  report: ReportKind;
  frequency: ReportFrequency;
  format: ReportFormat;
  recipientIds: string[];
  hour: number;
  active: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
}

// ------------------------------------------------------------------ report shapes

export interface ReportPeriod {
  from: string;
  to: string;
  timezone: string;
}

export interface ConversationsReportDto {
  kind: 'conversations';
  period: ReportPeriod;
  totals: {
    inbound: number;
    outboundHuman: number;
    outboundAutomated: number;
    notes: number;
    newConversations: number;
    /** Replies by a person to a customer who was waiting. */
    responses: number;
    medianResponseSeconds: number | null;
    p90ResponseSeconds: number | null;
    resolved: number;
    medianResolutionSeconds: number | null;
    openNow: number;
  };
  daily: {
    day: string;
    inbound: number;
    outbound: number;
    newConversations: number;
    responses: number;
    medianResponseSeconds: number | null;
    resolved: number;
  }[];
  /** Hours of the day 0 to 23, local time. */
  byHour: { hour: number; inbound: number; outbound: number }[];
  byChannel: {
    channelId: string;
    name: string;
    kind: string;
    inbound: number;
    outbound: number;
    medianResponseSeconds: number | null;
  }[];
}

export interface AgentsReportDto {
  kind: 'agents';
  period: ReportPeriod;
  rows: {
    userId: string;
    name: string;
    email: string;
    messages: number;
    notes: number;
    responses: number;
    medianResponseSeconds: number | null;
    resolved: number;
    medianResolutionSeconds: number | null;
    /** Open conversations assigned now. */
    openAssigned: number;
  }[];
}

export interface CampaignsReportDto {
  kind: 'campaigns';
  period: ReportPeriod;
  /** The wallet currency. Costs and revenue are in it; revenue in other currencies is left out. */
  currency: string;
  rows: {
    campaignId: string;
    name: string;
    status: string;
    startedAt: string | null;
    templateName: string;
    recipients: number;
    skipped: number;
    sent: number;
    delivered: number;
    read: number;
    replied: number;
    failed: number;
    costMicros: number;
    conversions: number;
    revenueMicros: number;
    /** (revenue - cost) / cost. Null without a cost. */
    roi: number | null;
  }[];
  totals: { costMicros: number; conversions: number; revenueMicros: number; roi: number | null };
}

export interface TemplatesReportDto {
  kind: 'templates';
  period: ReportPeriod;
  rows: {
    templateId: string;
    name: string;
    language: string;
    category: string;
    attempted: number;
    delivered: number;
    read: number;
    failed: number;
    replied: number;
    deliveryRate: number | null;
    readRate: number | null;
    replyRate: number | null;
  }[];
}

export interface AdsAttributionReportDto {
  kind: 'ads';
  period: ReportPeriod;
  currency: string;
  rows: {
    sourceId: string | null;
    headline: string | null;
    sourceUrl: string | null;
    referrals: number;
    conversations: number;
    newContacts: number;
    replied: number;
    conversions: number;
    revenueMicros: number;
    firstAt: string;
    lastAt: string;
  }[];
}

export type ReportDto =
  | ConversationsReportDto
  | AgentsReportDto
  | CampaignsReportDto
  | TemplatesReportDto
  | AdsAttributionReportDto;

export const ratio = (part: number, whole: number): number | null => (whole ? part / whole : null);

// ------------------------------------------------------------------ tables, CSV

export type CellFormat = 'text' | 'int' | 'pct' | 'duration' | 'money' | 'ratio';

export interface ReportTable {
  title: string;
  columns: { key: string; label: string; format: CellFormat }[];
  rows: Record<string, string | number | null>[];
}

/** "1h 5m", "3m 20s", "45s". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatCell(
  value: string | number | null,
  format: CellFormat,
  currency: string,
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  switch (format) {
    case 'pct':
      return `${(value * 100).toFixed(1)}%`;
    case 'ratio':
      return value.toFixed(2);
    case 'duration':
      return formatDuration(value);
    case 'money':
      return formatMoney(value, currency);
    case 'int':
      return value.toLocaleString('en-US');
    default:
      return String(value);
  }
}

/** The tables a report is made of, for CSV, PDF and email. */
export function reportTables(report: ReportDto): ReportTable[] {
  switch (report.kind) {
    case 'conversations': {
      const t = report.totals;
      return [
        {
          title: 'Summary',
          columns: [
            { key: 'metric', label: 'Metric', format: 'text' },
            { key: 'value', label: 'Value', format: 'text' },
          ],
          rows: [
            ['Messages from customers', t.inbound.toLocaleString('en-US')],
            ['Replies by the team', t.outboundHuman.toLocaleString('en-US')],
            ['Automated messages', t.outboundAutomated.toLocaleString('en-US')],
            ['Internal notes', t.notes.toLocaleString('en-US')],
            ['New conversations', t.newConversations.toLocaleString('en-US')],
            ['Customers answered', t.responses.toLocaleString('en-US')],
            ['Median first response', formatDuration(t.medianResponseSeconds) || '-'],
            ['90% answered within', formatDuration(t.p90ResponseSeconds) || '-'],
            ['Conversations resolved', t.resolved.toLocaleString('en-US')],
            ['Median resolution time', formatDuration(t.medianResolutionSeconds) || '-'],
            ['Open now', t.openNow.toLocaleString('en-US')],
          ].map(([metric, value]) => ({ metric: metric!, value: value! })),
        },
        {
          title: 'By day',
          columns: [
            { key: 'day', label: 'Day', format: 'text' },
            { key: 'inbound', label: 'From customers', format: 'int' },
            { key: 'outbound', label: 'Sent', format: 'int' },
            { key: 'newConversations', label: 'New conversations', format: 'int' },
            { key: 'responses', label: 'Answered', format: 'int' },
            { key: 'medianResponseSeconds', label: 'Median first response', format: 'duration' },
            { key: 'resolved', label: 'Resolved', format: 'int' },
          ],
          rows: report.daily,
        },
        {
          title: 'By hour of the day',
          columns: [
            { key: 'hour', label: 'Hour', format: 'text' },
            { key: 'inbound', label: 'From customers', format: 'int' },
            { key: 'outbound', label: 'Sent', format: 'int' },
          ],
          rows: report.byHour.map((h) => ({ ...h, hour: `${String(h.hour).padStart(2, '0')}:00` })),
        },
        {
          title: 'By channel',
          columns: [
            { key: 'name', label: 'Channel', format: 'text' },
            { key: 'kind', label: 'Kind', format: 'text' },
            { key: 'inbound', label: 'From customers', format: 'int' },
            { key: 'outbound', label: 'Sent', format: 'int' },
            { key: 'medianResponseSeconds', label: 'Median first response', format: 'duration' },
          ],
          rows: report.byChannel,
        },
      ];
    }
    case 'agents':
      return [
        {
          title: 'Team performance',
          columns: [
            { key: 'name', label: 'Name', format: 'text' },
            { key: 'email', label: 'Email', format: 'text' },
            { key: 'messages', label: 'Messages sent', format: 'int' },
            { key: 'notes', label: 'Notes', format: 'int' },
            { key: 'responses', label: 'Customers answered', format: 'int' },
            { key: 'medianResponseSeconds', label: 'Median first response', format: 'duration' },
            { key: 'resolved', label: 'Resolved', format: 'int' },
            { key: 'medianResolutionSeconds', label: 'Median resolution', format: 'duration' },
            { key: 'openAssigned', label: 'Open now', format: 'int' },
          ],
          rows: report.rows,
        },
      ];
    case 'campaigns':
      return [
        {
          title: 'Campaigns',
          columns: [
            { key: 'name', label: 'Campaign', format: 'text' },
            { key: 'status', label: 'Status', format: 'text' },
            { key: 'startedAt', label: 'Started', format: 'text' },
            { key: 'templateName', label: 'Template', format: 'text' },
            { key: 'recipients', label: 'Recipients', format: 'int' },
            { key: 'sent', label: 'Sent', format: 'int' },
            { key: 'delivered', label: 'Delivered', format: 'int' },
            { key: 'read', label: 'Read', format: 'int' },
            { key: 'replied', label: 'Replied', format: 'int' },
            { key: 'failed', label: 'Failed', format: 'int' },
            { key: 'costMicros', label: 'Cost', format: 'money' },
            { key: 'conversions', label: 'Conversions', format: 'int' },
            { key: 'revenueMicros', label: 'Revenue', format: 'money' },
            { key: 'roi', label: 'ROI', format: 'ratio' },
          ],
          rows: report.rows.map((r) => ({ ...r, startedAt: r.startedAt?.slice(0, 10) ?? null })),
        },
      ];
    case 'templates':
      return [
        {
          title: 'Templates',
          columns: [
            { key: 'name', label: 'Template', format: 'text' },
            { key: 'language', label: 'Language', format: 'text' },
            { key: 'category', label: 'Category', format: 'text' },
            { key: 'attempted', label: 'Sent', format: 'int' },
            { key: 'delivered', label: 'Delivered', format: 'int' },
            { key: 'read', label: 'Read', format: 'int' },
            { key: 'failed', label: 'Failed', format: 'int' },
            { key: 'replied', label: 'Replied', format: 'int' },
            { key: 'deliveryRate', label: 'Delivery rate', format: 'pct' },
            { key: 'readRate', label: 'Read rate', format: 'pct' },
            { key: 'replyRate', label: 'Reply rate', format: 'pct' },
          ],
          rows: report.rows,
        },
      ];
    case 'ads':
      return [
        {
          title: 'Ads',
          columns: [
            { key: 'headline', label: 'Ad', format: 'text' },
            { key: 'sourceId', label: 'Ad id', format: 'text' },
            { key: 'referrals', label: 'Messages', format: 'int' },
            { key: 'conversations', label: 'Conversations', format: 'int' },
            { key: 'newContacts', label: 'New contacts', format: 'int' },
            { key: 'replied', label: 'Answered', format: 'int' },
            { key: 'conversions', label: 'Conversions', format: 'int' },
            { key: 'revenueMicros', label: 'Revenue', format: 'money' },
          ],
          rows: report.rows,
        },
      ];
  }
}

export const reportCurrency = (report: ReportDto): string =>
  'currency' in report ? report.currency : '';

export function reportTitle(report: ReportDto): string {
  const { from, to } = report.period;
  return `${REPORT_LABELS[report.kind]}, ${from === to ? from : `${from} to ${to}`}`;
}

/**
 * One CSV file. A report with several tables puts each under its own title line, separated by
 * a blank line. Numbers stay raw (seconds, micro-units) so spreadsheets can work with them;
 * cells go through `csvCell`, so text cannot become a formula.
 */
export function reportToCsv(report: ReportDto): string {
  const tables = reportTables(report);
  const lines: string[] = [];
  for (const table of tables) {
    if (tables.length > 1) lines.push(csvCell(table.title));
    lines.push(
      table.columns
        .map((c) =>
          csvCell(
            c.format === 'money'
              ? `${c.label} (${reportCurrency(report)})`
              : c.format === 'duration'
                ? `${c.label} (seconds)`
                : c.label,
          ),
        )
        .join(','),
    );
    for (const row of table.rows) {
      lines.push(
        table.columns
          .map((c) => {
            const v = row[c.key] ?? null;
            if (c.format === 'money' && typeof v === 'number') return csvCell(v / 1_000_000);
            if (c.format === 'duration' && typeof v === 'number') return csvCell(Math.round(v));
            return csvCell(v);
          })
          .join(','),
      );
    }
    lines.push('');
  }
  return lines.join('\r\n');
}

export function reportFileName(report: ReportDto, format: ReportFormat): string {
  return `${report.kind}-${report.period.from}-to-${report.period.to}.${format}`;
}

// ------------------------------------------------------------------ duration histograms

/**
 * Response and resolution times are also kept as histograms with log buckets 10% wide, so a
 * percentile over months of data reads a few thousand rows instead of sorting millions. Bucket
 * 0 is [0, 1) second; bucket b >= 1 is [1.1^(b-1), 1.1^b). The SQL in packages/db uses the
 * same formula (`HISTOGRAM_BUCKET_SQL`).
 */
export const HISTOGRAM_RATIO = 1.1;
export const HISTOGRAM_MAX_BUCKET = 200;

export function histogramBucket(seconds: number): number {
  if (!(seconds >= 1)) return 0;
  return Math.min(
    Math.floor(Math.log(seconds) / Math.log(HISTOGRAM_RATIO)) + 1,
    HISTOGRAM_MAX_BUCKET,
  );
}

const bucketBounds = (b: number): [number, number] =>
  b === 0 ? [0, 1] : [HISTOGRAM_RATIO ** (b - 1), HISTOGRAM_RATIO ** b];

/**
 * A percentile (0 to 1) from bucket counts, interpolated inside the bucket. Within about 5% of
 * the exact value. Null with no data.
 */
export function histogramPercentile(counts: Map<number, number>, q: number): number | null {
  const buckets = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]);
  const total = buckets.reduce((s, [, n]) => s + n, 0);
  if (total === 0) return null;
  // The same rank as percentile_cont: q * (total - 1), counted from 0.
  const rank = q * (total - 1);
  let seen = 0;
  for (const [bucket, n] of buckets) {
    if (rank < seen + n) {
      const [lo, hi] = bucketBounds(bucket);
      const within = (rank - seen + 0.5) / n;
      return bucket === 0 ? lo + (hi - lo) * within : lo * (hi / lo) ** within;
    }
    seen += n;
  }
  return bucketBounds(buckets.at(-1)![0])[1];
}
