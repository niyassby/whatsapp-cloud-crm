'use client';

import type { MeResponse } from '@wacrm/shared';
import { Eye } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { leaveImpersonation } from '@/lib/api';
import { endImpersonation } from '@/lib/reseller';

const minutesLeft = (expiresAt: string) =>
  Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60_000));

/**
 * Always on screen while someone is inside a workspace they do not belong to, so it cannot be
 * mistaken for their own. Closes the view by itself when the time is up.
 */
export function ImpersonationBanner({
  impersonation,
}: {
  impersonation: NonNullable<MeResponse['impersonation']>;
}) {
  const [left, setLeft] = useState(() => minutesLeft(impersonation.expiresAt));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const tick = () => {
      const now = minutesLeft(impersonation.expiresAt);
      setLeft(now);
      if (now === 0) leaveImpersonation();
    };
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [impersonation.expiresAt]);

  return (
    <div
      role="status"
      data-testid="impersonation-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <Eye className="size-4 shrink-0" aria-hidden />
      <span>
        You are viewing <strong>{impersonation.orgName}</strong> as an outside admin. What you do
        here is recorded for its owners. {left} minute{left === 1 ? '' : 's'} left.
      </span>
      <Button
        size="sm"
        variant="outline"
        className="ml-auto border-amber-400 bg-transparent hover:bg-amber-200 dark:border-amber-700 dark:hover:bg-amber-900"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void endImpersonation();
        }}
      >
        Exit workspace
      </Button>
    </div>
  );
}
