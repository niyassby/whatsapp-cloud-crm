'use client';

import { Permission } from '@wacrm/shared';
import { PlugZap } from 'lucide-react';
import Link from 'next/link';
import { useConnections } from '@/lib/integrations';
import { useCan } from '@/lib/queries';

/** Shown to whoever manages integrations while a connection needs signing in again. */
export function ReconnectBanner() {
  const canManage = useCan(Permission.INTEGRATIONS_MANAGE);
  const connections = useConnections(canManage);
  const broken = (connections.data ?? []).filter((c) => c.status === 'needs_reconnect');
  if (!canManage || broken.length === 0) return null;
  const first = broken[0]!;
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <PlugZap className="size-4 shrink-0" aria-hidden />
      <span>
        {broken.length === 1
          ? `${first.name} needs to be reconnected, so its events and actions are paused.`
          : `${broken.length} integrations need to be reconnected.`}{' '}
        <Link
          href={broken.length === 1 ? `/integrations/${first.id}` : '/integrations'}
          className="font-medium underline underline-offset-2"
        >
          Reconnect
        </Link>
      </span>
    </div>
  );
}
