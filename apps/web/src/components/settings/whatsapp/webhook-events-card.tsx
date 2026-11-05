'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { WebhookEventDto, WebhookEventStatus } from '@wacrm/shared';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { queryKeys, useWebhookEvents } from '@/lib/queries';

const VARIANT: Record<WebhookEventStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  received: 'secondary',
  routed: 'default',
  processed: 'default',
  ignored: 'outline',
  failed: 'destructive',
};

export function WebhookEventsCard() {
  const queryClient = useQueryClient();
  const events = useWebhookEvents();
  const items = events.data?.pages.flatMap((p) => p.items) ?? [];

  const replay = async (event: WebhookEventDto) => {
    try {
      await api(`/whatsapp/webhook-events/${event.id}/replay`, { method: 'POST' });
      toast.success('Event queued for replay');
      await queryClient.invalidateQueries({ queryKey: queryKeys.webhookEvents });
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle>Recent webhook events</CardTitle>
          <CardDescription>What Meta has sent for your numbers, newest first.</CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={events.isFetching}
          onClick={() => void events.refetch()}
        >
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {events.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Events appear here once a number is connected and receives a message.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {new Date(event.receivedAt).toLocaleString()}
                    </TableCell>
                    <TableCell>{event.field ?? 'unknown'}</TableCell>
                    <TableCell className="whitespace-normal">
                      <Badge variant={VARIANT[event.status]}>{event.status}</Badge>
                      {event.error && (
                        <p className="mt-1 text-xs text-muted-foreground">{event.error}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => void replay(event)}>
                        Replay
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {events.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="outline"
                  disabled={events.isFetchingNextPage}
                  onClick={() => void events.fetchNextPage()}
                >
                  {events.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
