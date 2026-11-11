'use client';

import type { ConnectorDto } from '@wacrm/shared';
import { CONNECTOR_CATEGORIES } from '@wacrm/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ConnectDialog } from '@/components/integrations/connect-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CATEGORY_LABELS,
  STATUS_LABELS,
  STATUS_VARIANT,
  useConnections,
  useConnectors,
} from '@/lib/integrations';

function OAuthResult() {
  const params = useSearchParams();
  const error = params.get('error');
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertTitle>Not connected</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

export default function IntegrationsPage() {
  const connectors = useConnectors();
  const connections = useConnections();
  const [connecting, setConnecting] = useState<ConnectorDto | null>(null);
  const byKey = new Map((connectors.data ?? []).map((c) => [c.key, c]));
  const live = (connections.data ?? []).filter((c) => c.status !== 'disconnected');
  const broken = live.filter((c) => c.status === 'needs_reconnect');

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Connect your store, payments and other tools. Their events can start flows, and flows can
          act in them.
        </p>
      </div>
      <Suspense>
        <OAuthResult />
      </Suspense>
      {broken.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>Reconnect needed</AlertTitle>
          <AlertDescription>
            {broken.map((c) => (
              <Link key={c.id} href={`/integrations/${c.id}`} className="block underline">
                {c.name}: {c.lastError ?? 'sign in again'}
              </Link>
            ))}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Your connections</CardTitle>
          <CardDescription>Apps this workspace is connected to.</CardDescription>
        </CardHeader>
        <CardContent>
          {connections.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : live.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing connected yet.</p>
          ) : (
            <ul className="flex flex-col divide-y" aria-label="Connections">
              {live.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/integrations/${c.id}`} className="font-medium hover:underline">
                    {c.name}
                  </Link>
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    {byKey.get(c.connectorKey)?.name ?? c.connectorKey}
                    <Badge variant={STATUS_VARIANT[c.status]}>{STATUS_LABELS[c.status]}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {connectors.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : (connectors.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No integrations are available on this server yet.
        </p>
      ) : (
        CONNECTOR_CATEGORIES.map((category) => {
          const list = (connectors.data ?? []).filter((c) => c.category === category);
          if (list.length === 0) return null;
          return (
            <section key={category} className="flex flex-col gap-3">
              <h2 className="text-lg font-medium">{CATEGORY_LABELS[category]}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((c) => (
                  <Card key={c.key} data-testid={`connector-${c.key}`}>
                    <CardHeader>
                      <CardTitle className="text-base">{c.name}</CardTitle>
                      <CardDescription>{c.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      <p className="text-xs text-muted-foreground">
                        {c.triggers.length} trigger{c.triggers.length === 1 ? '' : 's'} ·{' '}
                        {c.actions.length} action{c.actions.length === 1 ? '' : 's'}
                      </p>
                      {c.available ? (
                        <Button
                          size="sm"
                          aria-label={`Connect ${c.name}`}
                          onClick={() => setConnecting(c)}
                        >
                          Connect
                        </Button>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Not set up on this server yet.
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          );
        })
      )}
      <ConnectDialog connector={connecting} onClose={() => setConnecting(null)} />
    </div>
  );
}
