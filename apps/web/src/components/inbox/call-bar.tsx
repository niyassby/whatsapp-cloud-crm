'use client';

import { Phone, PhoneOff } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { answerCall, declineCall, hangUp, useCalls } from '@/lib/calls';
import { handleApiError } from '@/lib/forms';

const who = (c: { contactName: string | null; waId: string | null }) =>
  c.contactName ?? (c.waId ? `+${c.waId}` : 'A customer');

/** Ringing and active WhatsApp calls, on every page of the workspace. */
export function CallBar() {
  const ringing = useCalls((s) => s.ringing);
  const active = useCalls((s) => s.active);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Remote audio of the call. */}
      <audio id="call-audio" autoPlay className="hidden" />
      {ringing && (
        <div
          role="alert"
          data-testid="incoming-call"
          className="flex flex-wrap items-center gap-3 border-b bg-emerald-50 px-4 py-2 text-sm text-emerald-950 dark:bg-emerald-950 dark:text-emerald-50"
        >
          <Phone className="size-4 animate-pulse" aria-hidden />
          <span>
            <strong>{who(ringing.call)}</strong> is calling on WhatsApp
          </span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void run(answerCall)}>
              Answer
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(declineCall)}
            >
              Decline
            </Button>
          </span>
        </div>
      )}
      {active && (
        <div
          role="status"
          data-testid="active-call"
          className="flex items-center gap-3 border-b bg-sky-50 px-4 py-2 text-sm text-sky-950 dark:bg-sky-950 dark:text-sky-50"
        >
          <Phone className="size-4" aria-hidden />
          <span>
            {active.call.status === 'connected' ? 'On a call with' : 'Calling'}{' '}
            <strong>{who(active.call)}</strong>
          </span>
          <Button
            size="sm"
            variant="destructive"
            className="ml-auto"
            disabled={busy}
            onClick={() => void run(hangUp)}
          >
            <PhoneOff className="size-4" aria-hidden /> Hang up
          </Button>
        </div>
      )}
    </>
  );
}
