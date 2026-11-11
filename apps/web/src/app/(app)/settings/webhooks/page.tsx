'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  type CreatedWebhookEndpointDto,
  Permission,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_EVENTS,
  type WebhookDeliveryDto,
  type WebhookDeliveryStatus,
  type WebhookEndpointDto,
  type WebhookEventType,
} from '@wacrm/shared';
import { type FormEvent, useState } from 'react';
import { FormField } from '@/components/form-field';
import { ShownOnce } from '@/components/settings/shown-once';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { api } from '@/lib/api';
import { developerKeys, useWebhookDeliveries, useWebhookEndpoints } from '@/lib/developer';
import { handleApiError } from '@/lib/forms';
import { useCan } from '@/lib/queries';

const ALL = '__all__';

const STATUS_LABELS: Record<WebhookDeliveryStatus, string> = {
  pending: 'Waiting',
  delivered: 'Delivered',
  failed: 'Failed',
};

function NewEndpoint({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (secret: string) => void;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await api<CreatedWebhookEndpointDto>('/webhook-endpoints', {
        method: 'POST',
        body: { url: url.trim(), events },
      });
      await queryClient.invalidateQueries({ queryKey: developerKeys.endpoints });
      onCreated(created.secret);
      onClose();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New webhook endpoint</DialogTitle>
            <DialogDescription>
              We send a signed POST to this address when something you choose happens.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Endpoint URL"
            name="endpoint-url"
            value={url}
            placeholder="https://example.com/webhooks/whatsapp"
            onChange={(e) => setUrl(e.target.value)}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Events</legend>
            {WEBHOOK_EVENTS.map((event) => (
              <label key={event} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={events.includes(event)}
                  onChange={(e) =>
                    setEvents((all) =>
                      e.target.checked ? [...all, event] : all.filter((v) => v !== event),
                    )
                  }
                />
                {WEBHOOK_EVENT_LABELS[event]}
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button type="submit" disabled={busy || !url.trim() || events.length === 0}>
              Create endpoint
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Deliveries({ endpointId }: { endpointId: string }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<WebhookDeliveryStatus | undefined>();
  const deliveries = useWebhookDeliveries(endpointId, status);
  const rows = deliveries.data?.pages.flatMap((p) => p.items) ?? [];

  const replay = async (d: WebhookDeliveryDto) => {
    try {
      await api(`/webhook-endpoints/${endpointId}/deliveries/${d.id}/replay`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: developerKeys.deliveriesOf(endpointId) });
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Delivery log</p>
        <div className="w-36">
          <Select
            value={status ?? ALL}
            onValueChange={(v) => setStatus(v === ALL ? undefined : (v as WebhookDeliveryStatus))}
          >
            <SelectTrigger aria-label="Filter deliveries by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              {WEBHOOK_DELIVERY_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {deliveries.isPending ? 'Loading…' : 'Nothing sent yet.'}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tries</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>When</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => (
              <TableRow key={d.id} data-testid={`delivery-${d.eventType}`}>
                <TableCell className="font-mono text-xs">
                  {d.eventType}
                  {d.replayOfId && (
                    <Badge variant="outline" className="ml-2">
                      Replay
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{STATUS_LABELS[d.status]}</TableCell>
                <TableCell className="tabular-nums">{d.attempts}</TableCell>
                <TableCell className="max-w-64 truncate text-muted-foreground">
                  {d.error ?? (d.responseStatus ? `Answered ${d.responseStatus}` : '')}
                  {d.status === 'pending' && d.nextAttemptAt && d.attempts > 0
                    ? `, trying again ${new Date(d.nextAttemptAt).toLocaleTimeString()}`
                    : ''}
                </TableCell>
                <TableCell>{new Date(d.createdAt).toLocaleString()}</TableCell>
                <TableCell className="text-right">
                  {d.status !== 'pending' && (
                    <Button variant="ghost" size="sm" onClick={() => void replay(d)}>
                      Replay
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {deliveries.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={deliveries.isFetchingNextPage}
          onClick={() => void deliveries.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}

function Endpoint({
  endpoint,
  onSecret,
}: {
  endpoint: WebhookEndpointDto;
  onSecret: (secret: string) => void;
}) {
  const queryClient = useQueryClient();
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = `/webhook-endpoints/${endpoint.id}`;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: developerKeys.endpoints });
      await queryClient.invalidateQueries({ queryKey: developerKeys.deliveriesOf(endpoint.id) });
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="webhook-endpoint">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="flex items-center gap-2 text-sm break-all">
            {endpoint.url}
            {!endpoint.active && <Badge variant="outline">Off</Badge>}
            {endpoint.apiKeyId && (
              <Badge
                variant="secondary"
                title="Added by Zapier, Make or another app with an API key"
              >
                Via API key
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {endpoint.events.join(', ')}
            {endpoint.apiKeyId && ' · revoking its API key removes it'}
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'Hide log' : 'Delivery log'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(`${base}/test`, { method: 'POST' });
                setShowLog(true);
              })
            }
          >
            Send test
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(base, { method: 'PATCH', body: { active: !endpoint.active } });
              })
            }
          >
            {endpoint.active ? 'Turn off' : 'Turn on'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm('Replace the signing secret? The old one stops working at once.')
              ) {
                return;
              }
              void run(async () => {
                const res = await api<CreatedWebhookEndpointDto>(`${base}/rotate-secret`, {
                  method: 'POST',
                });
                onSecret(res.secret);
              });
            }}
          >
            New secret
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Delete this endpoint and its delivery log?')) return;
              void run(async () => {
                await api(base, { method: 'DELETE' });
              });
            }}
          >
            Delete
          </Button>
        </div>
      </CardHeader>
      {showLog && (
        <CardContent>
          <Deliveries endpointId={endpoint.id} />
        </CardContent>
      )}
    </Card>
  );
}

export default function WebhooksPage() {
  const canManage = useCan(Permission.API_KEYS_MANAGE);
  const endpoints = useWebhookEndpoints();
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<string | null>(null);

  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">Only owners and admins can manage webhooks.</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {shown && (
        <ShownOnce title="Your signing secret" value={shown} onDone={() => setShown(null)} />
      )}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Webhooks</h2>
          <p className="text-sm text-muted-foreground">
            Failed deliveries are retried for about two days. Check the X-Wacrm-Signature header on
            what you receive.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>New endpoint</Button>
      </div>
      {endpoints.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : !endpoints.data?.length ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No endpoints yet.
        </p>
      ) : (
        endpoints.data.map((e) => <Endpoint key={e.id} endpoint={e} onSecret={setShown} />)
      )}
      {creating && (
        <NewEndpoint open onClose={() => setCreating(false)} onCreated={(s) => setShown(s)} />
      )}
    </div>
  );
}
