'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  type CampaignDto,
  type CampaignReportDto,
  formatMoney,
  RECIPIENT_STATUSES,
  type RecipientStatus,
  SKIP_REASON_LABELS,
  type SkipReason,
} from '@wacrm/shared';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CampaignStatusBadge } from '@/components/campaigns/campaign-status';
import { FormField } from '@/components/form-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, apiDownload } from '@/lib/api';
import {
  campaignKeys,
  PAUSE_ACTIONS,
  RECIPIENT_STATUS_LABELS,
  useCampaignEstimate,
  useCampaignRecipients,
  useCampaignReport,
} from '@/lib/campaigns';
import { handleApiError } from '@/lib/forms';

const ALL = '__all__';

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums" data-testid={`stat-${label.toLowerCase()}`}>
          {value}
        </CardTitle>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
    </Card>
  );
}

function Review({ campaign }: { campaign: CampaignDto }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isFile = campaign.audience.type === 'csv';
  const estimate = useCampaignEstimate(campaign.id, true);
  const [when, setWhen] = useState<'now' | 'scheduled'>('now');
  const [localTime, setLocalTime] = useState('');
  const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [timezone, setTimezone] = useState(browserZone);
  const zones = useMemo(() => {
    const all = Intl.supportedValuesOf('timeZone');
    return all.includes(browserZone) ? all : [browserZone, ...all];
  }, [browserZone]);
  const [busy, setBusy] = useState(false);
  const e = estimate.data;
  const short = e ? e.estimateMicros > e.availableMicros : false;

  const launch = async () => {
    setBusy(true);
    try {
      await api(`/campaigns/${campaign.id}/launch`, {
        method: 'POST',
        body: when === 'now' ? { when } : { when, localTime, timezone },
      });
      await queryClient.invalidateQueries({ queryKey: campaignKeys.all });
      toast.success(when === 'now' ? 'Campaign started' : 'Campaign scheduled');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api(`/campaigns/${campaign.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: campaignKeys.lists });
      router.push('/campaigns');
    } catch (err) {
      handleApiError(err);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Who it reaches</CardTitle>
          {isFile && (
            <CardDescription>
              From {campaign.audience.filename ?? 'your file'}. The file is read when the campaign
              starts, so people and cost are counted then. It pauses before sending if the wallet
              cannot cover it.
            </CardDescription>
          )}
        </CardHeader>
        {!isFile && (
          <CardContent className="flex flex-col gap-3">
            {!e ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <p className="text-sm text-muted-foreground">Will receive</p>
                    <p
                      className="text-2xl font-semibold tabular-nums"
                      data-testid="estimate-sendable"
                    >
                      {e.sendable.toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Estimated cost</p>
                    <p className="text-2xl font-semibold tabular-nums">
                      {formatMoney(e.estimateMicros, e.currency)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Available in wallet</p>
                    <p className="text-2xl font-semibold tabular-nums">
                      {formatMoney(e.availableMicros, e.currency)}
                    </p>
                  </div>
                </div>
                {Object.entries(e.skipped).map(([reason, count]) => (
                  <p key={reason} className="text-sm text-muted-foreground">
                    {count.toLocaleString()} skipped: {SKIP_REASON_LABELS[reason as SkipReason]}
                  </p>
                ))}
                {e.unpriced > 0 && (
                  <Alert variant="destructive">
                    <AlertTitle>{e.unpriced.toLocaleString()} have no price set</AlertTitle>
                    <AlertDescription>
                      Sends to their countries fail until a rate exists.
                    </AlertDescription>
                  </Alert>
                )}
                {short && (
                  <Alert variant="destructive">
                    <AlertTitle>Not enough in the wallet</AlertTitle>
                    <AlertDescription>
                      The campaign would pause before sending anything.{' '}
                      <Link href="/wallet" className="underline">
                        Open wallet
                      </Link>
                    </AlertDescription>
                  </Alert>
                )}
                {e.dailyRemaining !== null && e.dailyRemaining < e.sendable && (
                  <Alert>
                    <AlertTitle>This takes more than a day</AlertTitle>
                    <AlertDescription>
                      This number can reach {e.dailyRemaining.toLocaleString()} more people today.
                      The campaign sends that many, then carries on as the limit frees up.
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>When</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="campaign-when">Start</Label>
            <Select value={when} onValueChange={(v) => setWhen(v as 'now' | 'scheduled')}>
              <SelectTrigger id="campaign-when" className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="now">Now</SelectItem>
                <SelectItem value="scheduled">At a date and time</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {when === 'scheduled' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Date and time"
                name="local-time"
                type="datetime-local"
                value={localTime}
                onChange={(ev) => setLocalTime(ev.target.value)}
              />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="campaign-zone">Time zone</Label>
                <Select value={timezone} onValueChange={setTimezone}>
                  <SelectTrigger id="campaign-zone" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {zones.map((z) => (
                      <SelectItem key={z} value={z}>
                        {z}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-between gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void remove()}>
          Delete draft
        </Button>
        <Button
          disabled={busy || (when === 'scheduled' && !localTime)}
          onClick={() => void launch()}
        >
          {when === 'now' ? 'Start campaign' : 'Schedule campaign'}
        </Button>
      </div>
    </div>
  );
}

function Controls({ report }: { report: CampaignReportDto }) {
  const queryClient = useQueryClient();
  const { campaign } = report;
  const [busy, setBusy] = useState(false);

  const act = async (action: 'pause' | 'resume' | 'cancel') => {
    setBusy(true);
    try {
      await api(`/campaigns/${campaign.id}/${action}`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: campaignKeys.all });
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      {campaign.status === 'running' && (
        <Button variant="outline" disabled={busy} onClick={() => void act('pause')}>
          Pause
        </Button>
      )}
      {campaign.status === 'paused' && (
        <Button disabled={busy} onClick={() => void act('resume')}>
          Resume
        </Button>
      )}
      {['scheduled', 'preparing', 'running', 'paused'].includes(campaign.status) && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (window.confirm('Cancel this campaign? Messages not yet sent will not go out.')) {
              void act('cancel');
            }
          }}
        >
          Cancel campaign
        </Button>
      )}
      <Button
        variant="outline"
        onClick={() =>
          void apiDownload(`/campaigns/${campaign.id}/report.csv`, 'campaign-report.csv').catch(
            handleApiError,
          )
        }
      >
        Download report
      </Button>
    </div>
  );
}

function Progress({ report }: { report: CampaignReportDto }) {
  const { counts } = report;
  const done = counts.sent + counts.failed + counts.skipped + counts.cancelled;
  const percent = counts.total ? Math.round((done / counts.total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-sm text-muted-foreground">
        <span>
          {done.toLocaleString()} of {counts.total.toLocaleString()} handled
        </span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Campaign progress"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function Recipients({ id, live }: { id: string; live: boolean }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RecipientStatus | undefined>();
  const recipients = useCampaignRecipients(id, status);
  const rows = recipients.data?.pages.flatMap((p) => p.items) ?? [];

  // The list changes constantly during a send, so it refreshes slowly rather than on every batch.
  useEffect(() => {
    const refresh = () =>
      void queryClient.invalidateQueries({ queryKey: campaignKeys.recipients(id, status) });
    // Also once whenever sending starts or stops, so the finished list is never left stale.
    refresh();
    if (!live) return;
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [live, id, status, queryClient]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Recipients</CardTitle>
        <div className="w-44">
          <Select
            value={status ?? ALL}
            onValueChange={(v) => setStatus(v === ALL ? undefined : (v as RecipientStatus))}
          >
            <SelectTrigger aria-label="Filter recipients by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              {RECIPIENT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {RECIPIENT_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {recipients.isPending ? 'Loading…' : 'Nobody here yet.'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Contact</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/contacts/${r.contactId}`} className="hover:underline">
                      {r.contactName ?? `+${r.waId}`}
                    </Link>
                  </TableCell>
                  <TableCell>{RECIPIENT_STATUS_LABELS[r.status]}</TableCell>
                  <TableCell className="max-w-72 truncate text-muted-foreground">
                    {r.skipReason
                      ? SKIP_REASON_LABELS[r.skipReason as SkipReason]
                      : (r.errorMessage ?? '')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {recipients.hasNextPage && (
          <Button
            variant="outline"
            className="self-center"
            disabled={recipients.isFetchingNextPage}
            onClick={() => void recipients.fetchNextPage()}
          >
            Load more
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const query = useCampaignReport(id);
  const report = query.data;

  if (query.isError) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        This campaign could not be found.{' '}
        <Link href="/campaigns" className="underline">
          Back to campaigns
        </Link>
      </p>
    );
  }
  if (!report) return <Skeleton className="m-6 h-64" />;

  const { campaign, counts } = report;
  const pauseAction = campaign.pauseCode ? PAUSE_ACTIONS[campaign.pauseCode] : undefined;
  const sending = campaign.status === 'running' || campaign.status === 'preparing';
  const percent = (part: number) =>
    counts.sent ? `${Math.round((part / counts.sent) * 100)}% of sent` : undefined;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link href="/campaigns" className="text-sm text-muted-foreground hover:underline">
              Campaigns
            </Link>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">{campaign.name}</h1>
              <span data-testid="campaign-status">
                <CampaignStatusBadge status={campaign.status} />
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {campaign.templateName} from {campaign.phoneDisplay ?? 'your number'}
              {campaign.scheduledAt &&
                `, scheduled for ${new Date(campaign.scheduledAt).toLocaleString(undefined, {
                  timeZone: campaign.timezone ?? undefined,
                })} (${campaign.timezone})`}
            </p>
          </div>
          {campaign.status !== 'draft' && <Controls report={report} />}
        </div>

        {campaign.status === 'draft' ? (
          <Review campaign={campaign} />
        ) : (
          <>
            {campaign.pauseReason && (
              <Alert variant={campaign.status === 'failed' ? 'destructive' : 'default'}>
                <AlertTitle>{campaign.status === 'failed' ? 'Failed' : 'Paused'}</AlertTitle>
                <AlertDescription>
                  {campaign.pauseReason}{' '}
                  {pauseAction && (
                    <Link href={pauseAction.href} className="underline">
                      {pauseAction.label}
                    </Link>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {campaign.waitingUntil && (
              <Alert>
                <AlertTitle>Waiting for the daily limit</AlertTitle>
                <AlertDescription>
                  This number has reached its limit for now. Sending continues automatically.
                </AlertDescription>
              </Alert>
            )}
            <Progress report={report} />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Sent" value={counts.sent.toLocaleString()} />
              <Stat
                label="Delivered"
                value={counts.delivered.toLocaleString()}
                hint={percent(counts.delivered)}
              />
              <Stat label="Read" value={counts.read.toLocaleString()} hint={percent(counts.read)} />
              <Stat
                label="Replied"
                value={counts.replied.toLocaleString()}
                hint={percent(counts.replied)}
              />
              <Stat label="Failed" value={counts.failed.toLocaleString()} />
              <Stat
                label="Skipped"
                value={counts.skipped.toLocaleString()}
                hint={campaign.invalidRows ? `${campaign.invalidRows} invalid rows` : undefined}
              />
              <Stat label="Waiting" value={(counts.pending + counts.sending).toLocaleString()} />
              <Stat label="Cost" value={formatMoney(report.costMicros, report.currency)} />
            </div>
            <Recipients id={id} live={sending} />
          </>
        )}
      </div>
    </div>
  );
}
