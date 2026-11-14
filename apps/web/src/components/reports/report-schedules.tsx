'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  hasPermission,
  Permission,
  REPORT_FREQUENCIES,
  REPORT_KINDS,
  REPORT_LABELS,
  type ReportFormat,
  type ReportFrequency,
  type ReportKind,
  type ReportScheduleDto,
  type ReportScheduleInput,
} from '@wacrm/shared';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useMembers } from '@/lib/queries';

const FREQUENCY_LABELS: Record<ReportFrequency, string> = {
  daily: 'Every day (yesterday)',
  weekly: 'Every Monday (last 7 days)',
  monthly: 'On the 1st (last month)',
};

const selectClass =
  'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Reports emailed to owners and admins on a schedule. */
export function ReportSchedules() {
  const queryClient = useQueryClient();
  const members = useMembers();
  const schedules = useQuery({
    queryKey: ['report-schedules'],
    queryFn: () => api<ReportScheduleDto[]>('/reports/schedules'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['report-schedules'] });

  const [name, setName] = useState('');
  const [report, setReport] = useState<ReportKind>('conversations');
  const [frequency, setFrequency] = useState<ReportFrequency>('weekly');
  const [format, setFormat] = useState<ReportFormat>('pdf');
  const [hour, setHour] = useState(8);
  const [recipients, setRecipients] = useState<string[]>([]);

  // Only people who may read reports can receive them; the API checks this too.
  const eligible = (members.data ?? []).filter(
    (m) => m.status === 'active' && hasPermission(m.role, Permission.ANALYTICS_READ),
  );
  const nameOf = (id: string) => members.data?.find((m) => m.userId === id)?.name ?? 'Someone';

  const create = useMutation({
    mutationFn: (input: ReportScheduleInput) =>
      api<ReportScheduleDto>('/reports/schedules', { method: 'POST', body: input }),
    onSuccess: () => {
      toast.success('Schedule saved');
      setName('');
      setRecipients([]);
      void refresh();
    },
    onError: (err) => toast.error(err.message),
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; active: boolean }) =>
      api<ReportScheduleDto>(`/reports/schedules/${id}`, { method: 'PATCH', body }),
    onSuccess: () => void refresh(),
    onError: (err) => toast.error(err.message),
  });
  const run = useMutation({
    mutationFn: (id: string) =>
      api<ReportScheduleDto>(`/reports/schedules/${id}/run`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('It will be sent within a minute');
      void refresh();
    },
    onError: (err) => toast.error(err.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/reports/schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => void refresh(),
    onError: (err) => toast.error(err.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Scheduled emails</CardTitle>
        <CardDescription>
          A report sent to owners and admins of this workspace, with the file attached. Times are in
          the workspace&apos;s time zone.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {schedules.data?.length ? (
          <ul className="flex flex-col divide-y rounded-lg border">
            {schedules.data.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-2 p-3 text-sm"
                data-testid={`schedule-${s.name}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {s.name} {!s.active ? <Badge variant="secondary">Off</Badge> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {REPORT_LABELS[s.report]}, {FREQUENCY_LABELS[s.frequency].toLowerCase()} at{' '}
                    {String(s.hour).padStart(2, '0')}:00, {s.format.toUpperCase()} to{' '}
                    {s.recipientIds.map(nameOf).join(', ')}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Next {new Date(s.nextRunAt).toLocaleString()}
                    {s.lastRunAt ? `, last ${new Date(s.lastRunAt).toLocaleString()}` : ''}
                  </div>
                  {s.lastError ? (
                    <div className="text-xs text-destructive">{s.lastError}</div>
                  ) : null}
                </div>
                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={s.active}
                    onChange={(e) => update.mutate({ id: s.id, active: e.target.checked })}
                  />
                  On
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!s.active || run.isPending}
                  onClick={() => run.mutate(s.id)}
                >
                  Send now
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => remove.mutate(s.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No scheduled reports yet.</p>
        )}

        <form
          className="grid gap-3 rounded-lg border p-3 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({
              name,
              report,
              frequency,
              format,
              hour,
              recipientIds: recipients,
              active: true,
            });
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="schedule-name">Schedule name</Label>
            <Input
              id="schedule-name"
              value={name}
              required
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="schedule-report">Report</Label>
            <select
              id="schedule-report"
              className={selectClass}
              value={report}
              onChange={(e) => setReport(e.target.value as ReportKind)}
            >
              {REPORT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {REPORT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="schedule-frequency">How often</Label>
            <select
              id="schedule-frequency"
              className={selectClass}
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as ReportFrequency)}
            >
              {REPORT_FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABELS[f]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="schedule-hour">Time</Label>
            <select
              id="schedule-hour"
              className={selectClass}
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="schedule-format">File</Label>
            <select
              id="schedule-format"
              className={selectClass}
              value={format}
              onChange={(e) => setFormat(e.target.value as ReportFormat)}
            >
              <option value="pdf">PDF</option>
              <option value="csv">CSV</option>
            </select>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">Send to</legend>
            {eligible.map((m) => (
              <label key={m.userId} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={recipients.includes(m.userId)}
                  onChange={(e) =>
                    setRecipients((r) =>
                      e.target.checked ? [...r, m.userId] : r.filter((id) => id !== m.userId),
                    )
                  }
                />
                {m.name} <span className="text-muted-foreground">{m.email}</span>
              </label>
            ))}
          </fieldset>
          <div className="md:col-span-3">
            <Button
              type="submit"
              disabled={!name.trim() || recipients.length === 0 || create.isPending}
            >
              Add schedule
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
