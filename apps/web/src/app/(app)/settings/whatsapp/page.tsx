'use client';

import { Permission } from '@wacrm/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { ConnectCard } from '@/components/settings/whatsapp/connect-card';
import { PhoneNumbersCard } from '@/components/settings/whatsapp/phone-numbers-card';
import { WebhookEventsCard } from '@/components/settings/whatsapp/webhook-events-card';
import { useCan, useWhatsAppConfig } from '@/lib/queries';

export default function WhatsAppSettingsPage() {
  const canManage = useCan(Permission.WHATSAPP_MANAGE);
  const config = useWhatsAppConfig(canManage);

  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">Only owners and admins can manage WhatsApp.</p>
    );
  }
  if (!config.data) return <Skeleton className="h-56 w-full" />;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <PhoneNumbersCard />
      <ConnectCard config={config.data} />
      <WebhookEventsCard />
    </div>
  );
}
