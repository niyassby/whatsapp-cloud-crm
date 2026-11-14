'use client';

import { useQuery } from '@tanstack/react-query';
import {
  addDays,
  type AdsAttributionReportDto,
  type AgentsReportDto,
  type CampaignsReportDto,
  type ConversationsReportDto,
  formatCell,
  formatDuration,
  localDate,
  Permission,
  REPORT_KINDS,
  REPORT_LABELS,
  type ReportDto,
  type ReportFormat,
  type ReportKind,
  reportCurrency,
  reportFileName,
  reportTables,
  type TemplatesReportDto,
} from '@wacrm/shared';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { VolumeChart } from '@/components/dashboard/volume-chart';
import { HourChart } from '@/components/reports/hour-chart';
import { ReportSchedules } from '@/components/reports/report-schedules';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, ApiError, apiDownload } from '@/lib/api';
import { useCan, useOrg } from '@/lib/queries';

const PRESETS = [7, 30, 90];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-3" data-testid={`stat-${label}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" data-testid="stat-value">
        {value}
      </div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** Any report as tables, from the same definition the CSV and PDF use. */
function ReportTablesView({ report, skip = 0 }: { report: ReportDto; skip?: number }) {
  const currency = reportCurrency(report);
  return (
    <>
      {reportTables(report)
        .slice(skip)
        .map((table) => (
          <Card key={table.title}>
            <CardHeader>
              <CardTitle className="text-base">{table.title}</CardTitle>
            </CardHeader>
            <CardContent>
              {table.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing in this period.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table data-testid={`report-table-${table.title}`}>
                    <TableHeader>
                      <TableRow>
                        {table.columns.map((c) => (
                          <TableHead
                            key={c.key}
                            className={c.format === 'text' ? undefined : 'text-right'}
                          >
                            {c.label}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {table.rows.map((row, i) => (
                        <TableRow key={i}>
                          {table.columns.map((c) => (
                            <TableCell
                              key={c.key}
                              className={
                                c.format === 'text' ? undefined : 'text-right tabular-nums'
                              }
                            >
                              {formatCell(row[c.key] ?? null, c.format, currency) || '–'}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
    </>
  );
}

function ConversationsView({ report }: { report: ConversationsReportDto }) {
  const t = report.totals;
  return (
    <>
      <div
        className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6"
        data-testid="report-totals"
      >
        <Stat label="From customers" value={t.inbound.toLocaleString()} />
        <Stat
          label="Sent"
          value={(t.outboundHuman + t.outboundAutomated).toLocaleString()}
          hint={`${t.outboundHuman.toLocaleString()} by the team`}
        />
        <Stat label="New conversations" value={t.newConversations.toLocaleString()} />
        <Stat
          label="Median first response"
          value={formatDuration(t.medianResponseSeconds) || '–'}
          hint={
            t.p90ResponseSeconds !== null
              ? `90% within ${formatDuration(t.p90ResponseSeconds)}`
              : undefined
          }
        />
        <Stat
          label="Resolved"
          value={t.resolved.toLocaleString()}
          hint={
            t.medianResolutionSeconds !== null
              ? `median ${formatDuration(t.medianResolutionSeconds)}`
              : undefined
          }
        />
        <Stat label="Open now" value={t.openNow.toLocaleString()} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Messages by day</CardTitle>
        </CardHeader>
        <CardContent>
          <VolumeChart points={report.daily} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Messages from customers by hour of the day</CardTitle>
          <CardDescription>
            In {report.period.timezone}. Use it to plan who is on shift.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HourChart hours={report.byHour} />
        </CardContent>
      </Card>
      {/* Summary is shown as tiles, day and hour as charts; the tables keep every figure. */}
      <ReportTablesView report={report} skip={1} />
    </>
  );
}

function CampaignTotals({ report }: { report: CampaignsReportDto }) {
  const t = report.totals;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="report-totals">
      <Stat label="Campaigns" value={report.rows.length.toLocaleString()} />
      <Stat label="Cost" value={formatCell(t.costMicros, 'money', report.currency)} />
      <Stat
        label="Revenue"
        value={formatCell(t.revenueMicros, 'money', report.currency)}
        hint={`${t.conversions.toLocaleString()} conversions`}
      />
      <Stat label="ROI" value={t.roi === null ? '–' : `${t.roi.toFixed(2)}×`} />
    </div>
  );
}

/**
 * Reports from the aggregates the worker keeps: conversations, the team, campaigns with what
 * they earned, templates and ads. Any of them exports as CSV or PDF, or goes out by email.
 */
export default function ReportsPage() {
  const canRead = useCan(Permission.ANALYTICS_READ);
  const org = useOrg(canRead);
  const tz = org.data?.timezone ?? 'UTC';
  const today = localDate(new Date(), tz);
  const [kind, setKind] = useState<ReportKind>('conversations');
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const from = range?.from ?? addDays(today, -29);
  const to = range?.to ?? today;
  const [exporting, setExporting] = useState<ReportFormat | null>(null);

  const report = useQuery({
    queryKey: ['report', kind, from, to],
    enabled: canRead && org.isSuccess,
    retry: false,
    queryFn: () => api<ReportDto>(`/reports/${kind}?from=${from}&to=${to}`),
  });

  if (!canRead) {
    return <p className="text-sm text-muted-foreground">Only owners and admins can see reports.</p>;
  }
  const notOnPlan =
    report.error instanceof ApiError && report.error.code === 'PLAN_FEATURE_UNAVAILABLE';

  const download = async (format: ReportFormat) => {
    if (!report.data) return;
    setExporting(format);
    try {
      await apiDownload(
        `/reports/${kind}/export?from=${from}&to=${to}&format=${format}`,
        reportFileName(report.data, format),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not export');
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Days in {tz}. Figures update every few minutes.
          </p>
        </div>
        {/* Filters in one row above the report. */}
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <span className="flex gap-1" role="group" aria-label="Period">
            {PRESETS.map((d) => {
              const active = from === addDays(today, -(d - 1)) && to === today;
              return (
                <Button
                  key={d}
                  size="sm"
                  variant={active ? 'secondary' : 'ghost'}
                  aria-pressed={active}
                  onClick={() => setRange({ from: addDays(today, -(d - 1)), to: today })}
                >
                  {d} days
                </Button>
              );
            })}
          </span>
          <div className="flex flex-col gap-1">
            <Label htmlFor="report-from" className="text-xs">
              From
            </Label>
            <Input
              id="report-from"
              type="date"
              className="h-8 w-36"
              value={from}
              max={to}
              onChange={(e) => e.target.value && setRange({ from: e.target.value, to })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="report-to" className="text-xs">
              To
            </Label>
            <Input
              id="report-to"
              type="date"
              className="h-8 w-36"
              value={to}
              min={from}
              max={today}
              onChange={(e) => e.target.value && setRange({ from, to: e.target.value })}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!report.data || exporting !== null}
            onClick={() => void download('csv')}
          >
            <Download className="size-4" /> CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!report.data || exporting !== null}
            onClick={() => void download('pdf')}
          >
            <Download className="size-4" /> PDF
          </Button>
        </div>
      </div>

      <div role="tablist" aria-label="Report type" className="flex flex-wrap gap-1 border-b">
        {REPORT_KINDS.map((k) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={
              kind === k
                ? '-mb-px border-b-2 border-primary px-3 py-2 text-sm font-medium'
                : 'px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
            }
          >
            {REPORT_LABELS[k]}
          </button>
        ))}
      </div>

      {notOnPlan ? (
        <p className="text-sm text-muted-foreground">
          Reports are not on your plan. Upgrade in Settings &gt; Billing.
        </p>
      ) : report.error ? (
        <p className="text-sm text-destructive">{report.error.message}</p>
      ) : !report.data || report.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : report.data.kind === 'conversations' ? (
        <ConversationsView report={report.data} />
      ) : report.data.kind === 'campaigns' ? (
        <>
          <CampaignTotals report={report.data} />
          <ReportTablesView report={report.data} />
        </>
      ) : (
        <ReportTablesView
          report={report.data as AgentsReportDto | TemplatesReportDto | AdsAttributionReportDto}
        />
      )}

      {!notOnPlan ? <ReportSchedules /> : null}
    </div>
  );
}
