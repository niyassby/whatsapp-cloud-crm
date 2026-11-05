'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { PhoneNumberDto } from '@wacrm/shared';
import { RefreshCw, Unplug } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { queryKeys, usePhoneNumbers } from '@/lib/queries';
import { RegisterDialog } from './register-dialog';

const STATUS: Record<
  PhoneNumberDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  connected: { label: 'Connected', variant: 'default' },
  pending: { label: 'Pending', variant: 'secondary' },
  registration_failed: { label: 'Needs registration', variant: 'destructive' },
  disconnected: { label: 'Disconnected', variant: 'outline' },
};

const QUALITY: Record<string, string> = {
  GREEN: 'text-emerald-600 dark:text-emerald-400',
  YELLOW: 'text-amber-600 dark:text-amber-400',
  RED: 'text-red-600 dark:text-red-400',
};

/** "TIER_2K" -> "2K / day". Unknown or missing values are shown as they come. */
function tierLabel(tier: string | null): string {
  if (!tier) return 'Unknown';
  const match = /^TIER_(.+)$/.exec(tier);
  return match?.[1] ? `${match[1]} / day` : tier;
}

export function PhoneNumbersCard() {
  const queryClient = useQueryClient();
  const numbers = usePhoneNumbers();
  const [busyId, setBusyId] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.phoneNumbers });

  const run = async (phone: PhoneNumberDto, action: () => Promise<unknown>, done: string) => {
    setBusyId(phone.id);
    try {
      await action();
      toast.success(done);
      await refresh();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = (phone: PhoneNumberDto) => {
    const name = phone.displayPhoneNumber ?? phone.phoneNumberId;
    const ok = window.confirm(
      `Disconnect ${name}? New messages to this number will stop arriving here. Existing conversations are kept.`,
    );
    if (!ok) return;
    void run(
      phone,
      () => api(`/whatsapp/phone-numbers/${phone.id}`, { method: 'DELETE' }),
      `${name} was disconnected`,
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>WhatsApp numbers</CardTitle>
        <CardDescription>Numbers connected to this workspace.</CardDescription>
      </CardHeader>
      <CardContent>
        {numbers.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : !numbers.data?.length ? (
          <p className="text-sm text-muted-foreground">No numbers connected yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Quality</TableHead>
                <TableHead>Daily limit</TableHead>
                <TableHead className="w-32">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {numbers.data.map((phone) => {
                const live = phone.status !== 'disconnected';
                return (
                  <TableRow key={phone.id}>
                    <TableCell>
                      <div className="font-medium">
                        {phone.displayPhoneNumber ?? phone.phoneNumberId}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {phone.verifiedName ?? phone.wabaName ?? `WABA ${phone.wabaId}`}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <Badge variant={STATUS[phone.status].variant}>
                        {STATUS[phone.status].label}
                      </Badge>
                      {phone.statusReason && (
                        <p className="mt-1 max-w-56 text-xs text-muted-foreground">
                          {phone.statusReason}
                        </p>
                      )}
                    </TableCell>
                    <TableCell
                      className={phone.qualityRating ? QUALITY[phone.qualityRating] : undefined}
                    >
                      {phone.qualityRating ?? 'Unknown'}
                    </TableCell>
                    <TableCell>{tierLabel(phone.messagingTier)}</TableCell>
                    <TableCell>
                      {live && (
                        <div className="flex items-center justify-end gap-1">
                          {phone.status === 'registration_failed' && (
                            <RegisterDialog phone={phone} onDone={refresh} />
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Refresh ${phone.phoneNumberId} from Meta`}
                            disabled={busyId === phone.id}
                            onClick={() =>
                              void run(
                                phone,
                                () =>
                                  api(`/whatsapp/phone-numbers/${phone.id}/sync`, {
                                    method: 'POST',
                                  }),
                                'Details refreshed from Meta',
                              )
                            }
                          >
                            <RefreshCw className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Disconnect ${phone.phoneNumberId}`}
                            disabled={busyId === phone.id}
                            onClick={() => disconnect(phone)}
                          >
                            <Unplug className="size-4" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
