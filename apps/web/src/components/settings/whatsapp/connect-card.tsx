'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ManualConnectInput,
  manualConnectSchema,
  type PhoneNumberDto,
  type WhatsAppConfigDto,
} from '@wacrm/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { launchEmbeddedSignup, SignupCancelledError } from '@/lib/facebook';
import { handleApiError } from '@/lib/forms';
import { queryKeys } from '@/lib/queries';

function announce(phone: PhoneNumberDto) {
  const name = phone.displayPhoneNumber ?? phone.phoneNumberId;
  if (phone.status === 'registration_failed') {
    toast.warning(`${name} is connected, but registration failed. See the list below.`);
  } else {
    toast.success(`${name} is connected`);
  }
}

export function ConnectCard({ config }: { config: WhatsAppConfigDto }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.phoneNumbers });

  const startSignup = async () => {
    if (!config.appId || !config.configId) return;
    setBusy(true);
    try {
      const result = await launchEmbeddedSignup({
        appId: config.appId,
        configId: config.configId,
        graphApiVersion: config.graphApiVersion,
      });
      announce(
        await api<PhoneNumberDto>('/whatsapp/embedded-signup', { method: 'POST', body: result }),
      );
      await refresh();
    } catch (err) {
      if (err instanceof SignupCancelledError) return;
      if (err instanceof Error && err.name !== 'ApiError') toast.error(err.message);
      else handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a number</CardTitle>
        <CardDescription>
          {config.embeddedSignupEnabled
            ? 'Log in with Facebook to choose or create your WhatsApp Business Account and number.'
            : 'Facebook signup is not set up on this server yet. It needs META_APP_ID, META_APP_SECRET and META_EMBEDDED_SIGNUP_CONFIG_ID.'}
        </CardDescription>
      </CardHeader>
      <CardFooter className="flex flex-wrap gap-2">
        {config.embeddedSignupEnabled && (
          <Button disabled={busy} onClick={() => void startSignup()}>
            {busy ? 'Connecting…' : 'Connect with Facebook'}
          </Button>
        )}
        {config.manualConnectEnabled && <ManualConnectDialog onConnected={refresh} />}
      </CardFooter>
    </Card>
  );
}

function ManualConnectDialog({ onConnected }: { onConnected: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const form = useForm<ManualConnectInput>({
    resolver: zodResolver(manualConnectSchema),
    defaultValues: { accessToken: '', wabaId: '', phoneNumberId: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ pin, ...values }) => {
    try {
      const phone = await api<PhoneNumberDto>('/whatsapp/manual-connect', {
        method: 'POST',
        body: { ...values, ...(pin ? { pin } : {}) },
      });
      announce(phone);
      await onConnected();
      form.reset();
      setOpen(false);
    } catch (err) {
      handleApiError(err, form.setError);
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Connect with a token</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Connect with a system user token</DialogTitle>
            <DialogDescription>
              For development and Meta test numbers. The token is encrypted and can&apos;t be viewed
              again.
            </DialogDescription>
          </DialogHeader>
          <CardContent className="grid gap-4 p-0">
            <FormField
              label="System user access token"
              type="password"
              autoComplete="off"
              error={errors.accessToken?.message}
              {...form.register('accessToken')}
            />
            <FormField
              label="WhatsApp Business Account ID"
              inputMode="numeric"
              autoComplete="off"
              error={errors.wabaId?.message}
              {...form.register('wabaId')}
            />
            <FormField
              label="Phone number ID"
              inputMode="numeric"
              autoComplete="off"
              hint="The ID from WhatsApp > API Setup, not the phone number itself."
              error={errors.phoneNumberId?.message}
              {...form.register('phoneNumberId')}
            />
            <FormField
              label="2-step PIN (optional)"
              inputMode="numeric"
              maxLength={6}
              autoComplete="off"
              hint="Only to register a real number. Leave empty for test numbers."
              error={errors.pin?.message}
              {...form.register('pin', { setValueAs: (v: string) => v || undefined })}
            />
          </CardContent>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Connecting…' : 'Connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
