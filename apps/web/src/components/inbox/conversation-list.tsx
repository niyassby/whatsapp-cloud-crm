'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import type { ConversationDto } from '@wacrm/shared';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useRealtime } from '@/components/realtime-provider';
import {
  type ConversationFilter,
  type ConversationStatusFilter,
  isWindowOpen,
  shortTime,
  useConversations,
} from '@/lib/inbox';
import { cn } from '@/lib/utils';

const FILTERS: { value: ConversationFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Mine' },
  { value: 'unassigned', label: 'Unassigned' },
];
const ROW_HEIGHT = 76;

export function ConversationList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const [status, setStatus] = useState<ConversationStatusFilter>('open');
  const query = useConversations(filter, status);
  const connected = useRealtime((s) => s.connected);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const lastIndex = virtualRows.at(-1)?.index;

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (
      lastIndex !== undefined &&
      lastIndex >= items.length - 5 &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      void fetchNextPage();
    }
  }, [lastIndex, items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <>
      <div className="grid gap-2 border-b p-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Inbox</h1>
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title={connected ? 'Receiving updates live' : 'Reconnecting'}
          >
            <span
              className={cn('size-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-amber-500')}
              aria-hidden
            />
            {connected ? 'Live' : 'Reconnecting'}
          </span>
        </div>
        <div className="flex gap-1" role="group" aria-label="Filter conversations">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={filter === f.value ? 'secondary' : 'ghost'}
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <div className="flex gap-1" role="group" aria-label="Filter by status">
          {(['open', 'closed'] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              className="h-7 capitalize"
              variant={status === s ? 'outline' : 'ghost'}
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending ? (
          <div className="grid gap-2 p-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {status === 'closed' ? 'No closed conversations.' : 'No conversations here yet.'}
          </p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualRows.map((row) => {
              const conversation = items[row.index]!;
              return (
                <div
                  key={conversation.id}
                  className="absolute left-0 top-0 w-full"
                  style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                >
                  <Row
                    conversation={conversation}
                    selected={conversation.id === selectedId}
                    onSelect={onSelect}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function Row({
  conversation: c,
  selected,
  onSelect,
}: {
  conversation: ConversationDto;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const typing = useRealtime((s) => s.typing[c.id]?.[0]?.name);
  return (
    <button
      type="button"
      onClick={() => onSelect(c.id)}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex h-full w-full flex-col justify-center gap-0.5 border-b px-3 text-left hover:bg-muted/60',
        selected && 'bg-muted',
      )}
    >
      <span className="flex items-center gap-2">
        <span className={cn('truncate', c.unreadCount > 0 ? 'font-semibold' : 'font-medium')}>
          {c.contact.name ?? c.contact.waId}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {shortTime(c.lastMessageAt)}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <span className="truncate text-sm text-muted-foreground">
          {typing ? `${typing} is typing…` : (c.lastMessagePreview ?? '')}
        </span>
        {c.unreadCount > 0 && (
          <Badge className="ml-auto h-5 min-w-5 shrink-0 justify-center rounded-full px-1.5">
            <span className="sr-only">Unread messages: </span>
            {c.unreadCount}
          </Badge>
        )}
      </span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{c.assignee?.name ?? 'Unassigned'}</span>
        {c.slaBreached && c.awaitingReplySince && (
          <span className="shrink-0 font-medium text-destructive">Overdue</span>
        )}
        {!isWindowOpen(c) && <span className="ml-auto shrink-0">Window closed</span>}
      </span>
    </button>
  );
}
