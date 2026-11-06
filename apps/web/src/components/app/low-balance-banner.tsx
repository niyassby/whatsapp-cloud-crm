'use client';

import { formatMoney, Permission } from '@wacrm/shared';
import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useCan } from '@/lib/queries';
import { useWallet } from '@/lib/wallet';

/** Shown to whoever can see the wallet, until the balance recovers. */
export function LowBalanceBanner() {
  const canRead = useCan(Permission.WALLET_READ);
  const wallet = useWallet(canRead);
  if (!canRead || !wallet.data?.lowBalance) return null;
  const empty = wallet.data.availableMicros <= 0;
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      <span>
        {empty
          ? 'Your wallet is empty, so paid sends are stopped. Replies to customers still work.'
          : `Your wallet is low: ${formatMoney(wallet.data.balanceMicros, wallet.data.currency)}.`}{' '}
        <Link href="/wallet" className="font-medium underline underline-offset-2">
          View wallet
        </Link>
      </span>
    </div>
  );
}
