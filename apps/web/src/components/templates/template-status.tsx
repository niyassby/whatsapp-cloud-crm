import { REJECTION_EXPLANATIONS } from '@wacrm/shared';
import { Badge } from '@/components/ui/badge';
import { STATUS_LABELS } from '@/lib/templates';

const VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  draft: 'outline',
  pending: 'secondary',
  approved: 'default',
  rejected: 'destructive',
  disabled: 'destructive',
  paused: 'destructive',
};

export function TemplateStatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANT[status] ?? 'outline'}>{STATUS_LABELS[status] ?? status}</Badge>;
}

/** Plain language first, with Meta's own code kept for looking it up. */
export function rejectionText(reason: string | null): string {
  if (!reason) return 'Meta did not give a reason.';
  return REJECTION_EXPLANATIONS[reason] ?? `Meta gave the reason ${reason}.`;
}
