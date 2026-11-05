import type { OptInStatus } from '@wacrm/shared';
import { Badge } from '@/components/ui/badge';
import { OPT_IN_LABELS } from '@/lib/contacts';

const VARIANT = { opted_in: 'default', opted_out: 'destructive', unknown: 'outline' } as const;

export function ConsentBadge({ status }: { status: OptInStatus }) {
  return <Badge variant={VARIANT[status]}>{OPT_IN_LABELS[status]}</Badge>;
}
