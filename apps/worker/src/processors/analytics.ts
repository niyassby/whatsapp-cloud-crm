/**
 * Phase 4.3 jobs: keep the report aggregates current, rebuild them when asked, and email
 * scheduled reports. Reports never read messages; only the rollup here does.
 */
import { buildReport, effectivePlan, rebuildAnalytics, type TenantTx, withTenant } from '@wacrm/db';
import {
  hasPermission,
  nextScheduleRun,
  Permission,
  type ReportDto,
  type ReportFormat,
  type ReportFrequency,
  type ReportKind,
  reportFileName,
  reportTables,
  reportTitle,
  reportToCsv,
  schedulePeriod,
  formatCell,
  reportCurrency,
  type Role,
} from '@wacrm/shared';
import { renderReportPdf } from '@wacrm/shared/server';
import type { WorkerDeps } from '../deps';

/** Recent hours every 5 minutes; the last 3 days hourly, for receipts and replies that come late. */
export const ROLLUP_RECENT_MS = 3 * 3_600_000;
export const ROLLUP_DEEP_MS = 3 * 86_400_000;

export async function rollupTargets(deps: WorkerDeps, since: Date): Promise<string[]> {
  const rows = await deps.db.$queryRaw<{ org_id: string }[]>`
    SELECT org_id FROM analytics_rollup_targets(${since}::timestamptz)`;
  return rows.map((r) => r.org_id);
}

/** Every workspace with messages in the window. One failing workspace does not stop the rest. */
export async function runRollup(
  deps: WorkerDeps,
  windowMs: number,
  now = new Date(),
): Promise<{ orgs: number; failed: { orgId: string; error: string }[] }> {
  const since = new Date(now.getTime() - windowMs);
  const orgs = await rollupTargets(deps, since);
  const failed: { orgId: string; error: string }[] = [];
  for (const orgId of orgs) {
    try {
      await rebuildAnalytics(
        (fn) => withTenant(deps.db, { orgId }, fn, { timeout: 120_000 }),
        orgId,
        since,
        now,
      );
    } catch (err) {
      failed.push({ orgId, error: String(err) });
    }
  }
  return { orgs: orgs.length, failed };
}

/** A workspace's history, for a time zone change or after a fix to the rollup. */
export async function rebuildOrg(deps: WorkerDeps, orgId: string, days: number): Promise<number> {
  const until = new Date();
  return rebuildAnalytics(
    (fn) => withTenant(deps.db, { orgId }, fn, { timeout: 120_000 }),
    orgId,
    new Date(until.getTime() - days * 86_400_000),
    until,
  );
}

// ------------------------------------------------------------------ scheduled reports

export interface ReportMail {
  to: string[];
  subject: string;
  text: string;
  attachment: { filename: string; content: Buffer; contentType: string };
}

export async function dueReportSchedules(
  deps: WorkerDeps,
  now = new Date(),
): Promise<{ id: string; org_id: string }[]> {
  return deps.db.$queryRaw<{ id: string; org_id: string }[]>`
    SELECT id, org_id FROM report_schedules_due(${now}::timestamptz, 100)`;
}

/** People who may read reports, among the ones a schedule names. Others are skipped. */
async function recipients(tx: TenantTx, orgId: string, ids: string[]) {
  const members = await tx.membership.findMany({
    where: { orgId, userId: { in: ids }, status: 'active' },
    select: { role: true, user: { select: { email: true, status: true } } },
  });
  return members
    .filter(
      (m) => m.user.status === 'active' && hasPermission(m.role as Role, Permission.ANALYTICS_READ),
    )
    .map((m) => m.user.email);
}

function summaryLines(report: ReportDto): string[] {
  const [first] = reportTables(report);
  if (!first) return [];
  const currency = reportCurrency(report);
  if (report.kind === 'conversations') {
    return first.rows.map((r) => `${String(r.metric)}: ${String(r.value)}`);
  }
  const lines = first.rows.slice(0, 10).map((row) =>
    first.columns
      .slice(0, 5)
      .map((c) => `${c.label}: ${formatCell(row[c.key] ?? null, c.format, currency) || '-'}`)
      .join(', '),
  );
  if (first.rows.length > 10) lines.push(`… and ${first.rows.length - 10} more in the attachment.`);
  return lines.length ? lines : ['Nothing in this period.'];
}

/**
 * Send one due schedule. The run is claimed first: the row is locked, checked, and moved to its
 * next time in one transaction, so two workers or a retry cannot send the same period twice. A
 * failed send is recorded on the schedule and not retried; the next period goes as usual.
 */
export async function runReportSchedule(
  deps: WorkerDeps,
  orgId: string,
  scheduleId: string,
  now = new Date(),
): Promise<'sent' | 'skipped' | 'failed'> {
  const claimed = await withTenant(
    deps.db,
    { orgId },
    async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM report_schedules
        WHERE id = ${scheduleId}::uuid AND active AND next_run_at <= ${now}::timestamptz
        FOR UPDATE SKIP LOCKED`;
      if (!row) return null;
      const schedule = await tx.reportSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { name: true, timezone: true, status: true, deletedAt: true },
      });
      const frequency = schedule.frequency as ReportFrequency;
      await tx.reportSchedule.update({
        where: { id: scheduleId },
        data: {
          nextRunAt: nextScheduleRun(frequency, schedule.hour, org.timezone, now),
          lastRunAt: now,
          lastError: null,
        },
      });
      if (org.deletedAt || org.status !== 'active') return { skip: 'The workspace is not active' };
      const plan = await effectivePlan(tx, orgId, now);
      if (plan && !(plan.plan.features as string[]).includes('reports')) {
        return { skip: 'Reports are not on the current plan' };
      }
      const to = await recipients(tx, orgId, schedule.recipientIds);
      if (to.length === 0) return { skip: 'None of the recipients can read reports any more' };
      const period = schedulePeriod(frequency, schedule.nextRunAt, org.timezone);
      const report = await buildReport(tx, orgId, schedule.report as ReportKind, period);
      return {
        report,
        to,
        workspace: org.name,
        format: schedule.format as ReportFormat,
        name: schedule.name,
      };
    },
    { timeout: 60_000 },
  );
  if (!claimed) return 'skipped';
  if ('skip' in claimed) {
    await recordError(deps, orgId, scheduleId, claimed.skip ?? 'Skipped');
    return 'skipped';
  }

  try {
    const { report, format } = claimed;
    const content =
      format === 'pdf'
        ? await renderReportPdf(report, claimed.workspace)
        : Buffer.from(reportToCsv(report), 'utf8');
    if (!deps.sendMail) throw new Error('No mail server is configured');
    await deps.sendMail({
      to: claimed.to,
      subject: `${reportTitle(report)} · ${claimed.workspace}`,
      text: [
        `${claimed.name}: ${reportTitle(report)} for ${claimed.workspace}.`,
        `Times are in ${report.period.timezone}.`,
        '',
        ...summaryLines(report),
        '',
        `The full report is attached. See more in ${deps.webUrl ?? ''}/reports`,
        'You get this because a workspace admin added you to this scheduled report.',
      ].join('\n'),
      attachment: {
        filename: reportFileName(report, format),
        content,
        contentType: format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8',
      },
    });
    return 'sent';
  } catch (err) {
    await recordError(deps, orgId, scheduleId, `Could not send: ${String(err).slice(0, 300)}`);
    return 'failed';
  }
}

async function recordError(deps: WorkerDeps, orgId: string, id: string, error: string) {
  await withTenant(deps.db, { orgId }, (tx) =>
    tx.reportSchedule.update({ where: { id }, data: { lastError: error } }),
  );
}
