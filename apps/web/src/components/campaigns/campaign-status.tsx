import type { CampaignStatus } from '@wacrm/shared';
import { Badge } from '@/components/ui/badge';
import { CAMPAIGN_STATUS_LABELS } from '@/lib/campaigns';

const VARIANTS: Record<CampaignStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  draft: 'outline',
  scheduled: 'secondary',
  preparing: 'secondary',
  running: 'default',
  paused: 'secondary',
  completed: 'outline',
  cancelled: 'outline',
  failed: 'destructive',
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return <Badge variant={VARIANTS[status]}>{CAMPAIGN_STATUS_LABELS[status]}</Badge>;
}
