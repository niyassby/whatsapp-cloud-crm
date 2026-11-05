import { MessagesSquare } from 'lucide-react';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Inbox' };

export default function InboxPage() {
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center text-center">
      <MessagesSquare className="size-10 text-muted-foreground" aria-hidden />
      <h1 className="mt-4 text-xl font-semibold">Your shared inbox lives here</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Connect a WhatsApp number in Settings. Live conversations arrive with the next phase.
      </p>
    </div>
  );
}
