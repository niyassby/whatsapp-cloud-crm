'use client';

import { Permission } from '@wacrm/shared';
import { Clock } from 'lucide-react';
import Link from 'next/link';
import { daysUntil, useBillingSummary } from '@/lib/billing';
import { useCan } from '@/lib/queries';

const SOON_DAYS = 7;

/** For whoever can act on it: a trial ending soon, an ended plan, or a payment that failed. */
export function TrialBanner() {
  const canRead = useCan(Permission.BILLING_READ);
  const { data } = useBillingSummary(canRead);
  if (!canRead || !data) return null;

  let text: string | null = null;
  if (data.status === 'expired') {
    text = 'Your plan has ended, so limits have dropped to the Free plan.';
  } else if (data.status === 'past_due') {
    text = 'Your last payment failed. Update your payment method to keep your plan.';
  } else if (data.status === 'trialing' && data.trialEndsAt) {
    const days = daysUntil(data.trialEndsAt);
    if (days <= SOON_DAYS) {
      text = `Your trial ends in ${days} day${days === 1 ? '' : 's'}.`;
    }
  }
  if (!text) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <Clock className="size-4 shrink-0" aria-hidden />
      <span>
        {text}{' '}
        <Link href="/settings/billing" className="font-medium underline underline-offset-2">
          View billing
        </Link>
      </span>
    </div>
  );
}
