'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { IntegrationConnectionDto, IntegrationEventDto } from '@wacrm/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { toast } from 'sonner';
import { ConnectorFields } from '@/components/integrations/connect-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { handleApiError } from '@/lib/forms';
import {
  integrationKeys,
  STATUS_LABELS,
  STATUS_VARIANT,
  useConnection,
  useConnectors,
  useIntegrationEvents,
} from '@/lib/integrations';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function Connected() {
  const params = useSearchParams();
  if (!params.get('connected')) return null;
  return (
    <Alert>
      <AlertTitle>Connected</AlertTitle>
      <AlertDescription>The connection is being checked now.</AlertDescription>
    </Alert>
  );
}

function EventRow({ event }: { event: IntegrationEventDto }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const retry = async () => {
    try {
      await api(`/integrations/events/${event.id}/replay`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: integrationKeys.events(event.connectionId) });
      toast.success('Trying again');
    } catch (err) {
      handleApiError(err);
    }
  };
  return (
    <>
      <TableRow>
        <TableCell className="text-xs tabular-nums">{when(event.createdAt)}</TableCell>
        <TableCell>{event.direction === 'inbound' ? 'In' : 'Out'}</TableCell>
        <TableCell>
          <code className="text-xs">{event.type ?? '—'}</code>
        </TableCell>
        <TableCell>
          <Badge variant={event.status === 'failed' ? 'destructive' : 'outline'}>
            {event.status}
          </Badge>
          {event.error && <span className="ml-2 text-xs text-destructive">{event.error}</span>}
        </TableCell>
        <TableCell className="text-right">
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Details'}
          </Button>
          {event.direction === 'inbound' &&
            (event.status === 'failed' || event.status === 'ignored') && (
              <Button size="sm" variant="outline" onClick={() => void retry()}>
                Try again
              </Button>
            )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={5}>
            <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
              {JSON.stringify({ payload: event.payload, result: event.result }, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function Events({ id }: { id: string }) {
  const events = useIntegrationEvents(id);
  const items = events.data?.pages.flatMap((p) => p.items) ?? [];
  if (events.isPending) return <Skeleton className="h-24 w-full" />;
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No events yet.</p>;
  return (
    <>
      <Table aria-label="Events">
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Way</TableHead>
            <TableHead>Event or action</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </TableBody>
      </Table>
      {events.hasNextPage && (
        <Button variant="ghost" onClick={() => void events.fetchNextPage()}>
          Show older events
        </Button>
      )}
    </>
  );
}

function Reconnect({
  conn,
  open,
  onClose,
}: {
  conn: IntegrationConnectionDto;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const connectors = useConnectors();
  const connector = connectors.data?.find((c) => c.key === conn.connectorKey);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const updated = await api<IntegrationConnectionDto>(`/integrations/connections/${conn.id}`, {
        method: 'PATCH',
        body: { credentials },
      });
      queryClient.setQueryData(integrationKeys.connection(conn.id), updated);
      void queryClient.invalidateQueries({ queryKey: integrationKeys.connections });
      onClose();
    } catch (err) {
      handleApiError(err);
    }
  };
  if (!connector) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Reconnect {conn.name}</DialogTitle>
            <DialogDescription>
              Enter new credentials. The webhook address and secret stay the same.
            </DialogDescription>
          </DialogHeader>
          <ConnectorFields
            fields={connector.credentials}
            values={credentials}
            onChange={setCredentials}
            prefix="reconnect"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Reconnect</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ConnectionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const connection = useConnection(id);
  const connectors = useConnectors();
  const [reconnecting, setReconnecting] = useState(false);

  if (connection.isPending) return <Skeleton className="h-64 w-full" />;
  if (!connection.data) return <p className="text-sm text-muted-foreground">Not found.</p>;
  const c = connection.data;
  const connector = connectors.data?.find((x) => x.key === c.connectorKey);

  const refresh = (updated: IntegrationConnectionDto) => {
    queryClient.setQueryData(integrationKeys.connection(id), updated);
    void queryClient.invalidateQueries({ queryKey: integrationKeys.connections });
  };
  const test = async () => {
    try {
      await api(`/integrations/connections/${id}/test`, { method: 'POST' });
      toast.success('Checking the connection');
    } catch (err) {
      handleApiError(err);
    }
  };
  const reconnect = async () => {
    if (connector?.authType !== 'oauth2') {
      setReconnecting(true);
      return;
    }
    try {
      const { url } = await api<{ url: string }>('/integrations/oauth/start', {
        method: 'POST',
        body: {
          connectorKey: c.connectorKey,
          name: c.name,
          settings: c.settings,
          connectionId: c.id,
        },
      });
      window.location.assign(url);
    } catch (err) {
      handleApiError(err);
    }
  };
  const disconnect = async () => {
    if (!window.confirm(`Disconnect ${c.name}? Its credentials are deleted and webhooks stop.`))
      return;
    try {
      refresh(
        await api<IntegrationConnectionDto>(`/integrations/connections/${id}/disconnect`, {
          method: 'POST',
        }),
      );
      router.push('/integrations');
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <Link
        href="/integrations"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Integrations
      </Link>
      <Suspense>
        <Connected />
      </Suspense>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{c.name}</h1>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            {connector?.name ?? c.connectorKey}
            <Badge variant={STATUS_VARIANT[c.status]}>{STATUS_LABELS[c.status]}</Badge>
          </p>
        </div>
        {c.status !== 'disconnected' && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void test()}>
              Test connection
            </Button>
            {connector?.authType !== 'webhook_secret' && connector?.authType !== 'none' && (
              <Button
                variant={c.status === 'needs_reconnect' ? 'default' : 'outline'}
                onClick={() => void reconnect()}
              >
                Reconnect
              </Button>
            )}
            <Button variant="ghost" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </div>
        )}
      </div>

      {c.lastError && (
        <Alert variant="destructive">
          <AlertTitle>
            {c.status === 'needs_reconnect' ? 'Reconnect needed' : 'Last problem'}
          </AlertTitle>
          <AlertDescription>{c.lastError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <span>Last checked: {when(c.lastHealthAt)}</span>
          {connector?.syncs && <span>Last synced: {when(c.lastSyncAt)}</span>}
          {c.tokenExpiresAt && <span>Sign-in renews before: {when(c.tokenExpiresAt)}</span>}
          {Object.entries(c.settings).map(([k, v]) => (
            <span key={k}>
              {connector?.settings.find((f) => f.key === k)?.label ?? k}: {v}
            </span>
          ))}
        </CardContent>
      </Card>

      {c.webhookUrl && (
        <Card>
          <CardHeader>
            <CardTitle>Webhook</CardTitle>
            <CardDescription>
              Where {connector?.name ?? 'the app'} sends events. The signing secret was shown when
              you connected.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <code className="block rounded bg-muted p-2 text-xs break-all">{c.webhookUrl}</code>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Events</CardTitle>
          <CardDescription>What came in and what flows asked it to do.</CardDescription>
        </CardHeader>
        <CardContent>
          <Events id={id} />
        </CardContent>
      </Card>
      <Reconnect conn={c} open={reconnecting} onClose={() => setReconnecting(false)} />
    </div>
  );
}
