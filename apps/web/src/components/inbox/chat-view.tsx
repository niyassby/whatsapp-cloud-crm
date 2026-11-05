'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConversationDto } from '@wacrm/shared';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useRealtime } from '@/components/realtime-provider';
import { api } from '@/lib/api';
import { applyConversationUpdate, dayLabel, displayWaId, useMessages } from '@/lib/inbox';
import { Composer } from './composer';
import { MessageBubble } from './message-bubble';

export function ChatView({
  conversation,
  onBack,
}: {
  conversation: ConversationDto;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const messagesQuery = useMessages(conversation.id);
  const typing = useRealtime((s) => s.typing[conversation.id]);

  // Oldest first for display.
  const messages = useMemo(
    () => [...(messagesQuery.data?.pages.flatMap((p) => p.items) ?? [])].reverse(),
    [messagesQuery.data],
  );

  const markRead = useMutation({
    mutationFn: () =>
      api<ConversationDto>(`/inbox/conversations/${conversation.id}/read`, { method: 'POST' }),
    onSuccess: (updated) => applyConversationUpdate(queryClient, updated),
  });

  // Viewing the conversation clears its unread count, including for messages arriving now.
  const { mutate: read } = markRead;
  const unread = conversation.unreadCount;
  useEffect(() => {
    if (unread > 0 && document.visibilityState === 'visible') read();
  }, [unread, read]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const newest = messages.at(-1)?.id;
  const stickToBottom = useRef(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    // Follow new messages only if already at the bottom, so reading history is not interrupted.
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [newest]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  /** Keep the viewport on the same message while older ones load above it. */
  const loadOlder = async () => {
    const el = scrollRef.current;
    const before = el?.scrollHeight ?? 0;
    await messagesQuery.fetchNextPage();
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - before;
    });
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Conversation">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Back to conversations"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <h2 className="truncate font-semibold">
            {conversation.contact.name ?? conversation.contact.waId}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {displayWaId(conversation.contact.waId)}
            {conversation.status === 'closed' ? ' · Closed' : ''}
          </p>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto bg-muted/30 p-4"
        role="log"
        aria-live="polite"
        aria-label="Messages"
      >
        {messagesQuery.hasNextPage && (
          <Button
            variant="outline"
            size="sm"
            className="mb-2 self-center"
            disabled={messagesQuery.isFetchingNextPage}
            onClick={() => void loadOlder()}
          >
            {messagesQuery.isFetchingNextPage ? 'Loading…' : 'Load earlier messages'}
          </Button>
        )}
        {messagesQuery.isPending && <Skeleton className="h-24 w-full" />}
        {messages.map((message, i) => {
          const day = dayLabel(message.createdAt);
          const previous = messages[i - 1];
          const showDay = !previous || dayLabel(previous.createdAt) !== day;
          return (
            <div key={message.id} className="contents">
              {showDay && (
                <div className="my-2 self-center rounded-full bg-background px-3 py-0.5 text-xs text-muted-foreground shadow-xs">
                  {day}
                </div>
              )}
              <MessageBubble message={message} />
            </div>
          );
        })}
        {typing?.length ? (
          <p className="mt-1 text-xs italic text-muted-foreground">
            {typing.map((t) => t.name).join(', ')} {typing.length > 1 ? 'are' : 'is'} typing…
          </p>
        ) : null}
      </div>

      <Composer conversation={conversation} />
    </section>
  );
}
