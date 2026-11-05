'use client';

import { MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { ChatView } from '@/components/inbox/chat-view';
import { ConversationList } from '@/components/inbox/conversation-list';
import { DetailsPanel } from '@/components/inbox/details-panel';
import { useConversation } from '@/lib/inbox';
import { cn } from '@/lib/utils';

export default function InboxPage() {
  const router = useRouter();
  const selectedId = useSearchParams().get('c');
  const conversation = useConversation(selectedId);

  const select = useCallback(
    (id: string | null) => router.replace(id ? `/inbox?c=${id}` : '/inbox', { scroll: false }),
    [router],
  );

  return (
    // Cancels the shell's padding: the inbox fills the whole content area.
    <div className="-m-6 flex h-[calc(100%+3rem)] min-h-0">
      <div
        className={cn(
          'w-full shrink-0 border-r md:flex md:w-80 md:flex-col',
          selectedId ? 'hidden' : 'flex flex-col',
        )}
      >
        <ConversationList selectedId={selectedId} onSelect={select} />
      </div>
      {selectedId && conversation.data ? (
        <>
          <ChatView key={selectedId} conversation={conversation.data} onBack={() => select(null)} />
          <div className="hidden w-72 shrink-0 overflow-y-auto border-l xl:block">
            <DetailsPanel conversation={conversation.data} />
          </div>
        </>
      ) : (
        <div className="hidden flex-1 flex-col items-center justify-center p-6 text-center md:flex">
          <MessagesSquare className="size-10 text-muted-foreground" aria-hidden />
          <h1 className="mt-4 text-lg font-semibold">
            {selectedId && conversation.isError ? 'Conversation not found' : 'Your shared inbox'}
          </h1>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Pick a conversation to reply. New WhatsApp messages appear here live.{' '}
            <Link href="/settings/whatsapp" className="underline">
              Manage numbers
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
