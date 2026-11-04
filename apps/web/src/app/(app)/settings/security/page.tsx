'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { TotpSetupResponse } from '@wacrm/shared';
import { ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { queryKeys, useMe } from '@/lib/queries';

export default function SecurityPage() {
  const { data: me } = useMe();
  if (!me) return <Skeleton className="h-56 w-full" />;
  return me.user.totpEnabled ? <DisableTotp /> : <EnableTotp />;
}

function EnableTotp() {
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState<(TotpSetupResponse & { qr: string }) | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const res = await api<TotpSetupResponse>('/auth/2fa/setup', { method: 'POST' });
      setSetup({ ...res, qr: await QRCode.toDataURL(res.otpauthUrl, { margin: 1, width: 192 }) });
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setBusy(true);
    try {
      await api('/auth/2fa/enable', { method: 'POST', body: { code } });
      toast.success('Two-factor authentication is on');
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication <Badge variant="secondary">Off</Badge>
        </CardTitle>
        <CardDescription>
          Require a code from an authenticator app (Google Authenticator, 1Password, Authy) when you
          log in.
        </CardDescription>
      </CardHeader>
      {setup ? (
        <>
          <CardContent className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
            <img
              src={setup.qr}
              alt="QR code for your authenticator app"
              width={192}
              height={192}
              className="rounded-md border"
            />
            <div className="grid gap-3">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>Scan the QR code with your authenticator app.</li>
                <li>Enter the 6-digit code it shows.</li>
              </ol>
              <p className="text-xs text-muted-foreground">
                Can&apos;t scan? Enter this key:{' '}
                <code className="break-all rounded bg-muted px-1 py-0.5">{setup.secret}</code>
              </p>
              <FormField
                label="Verification code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </div>
          </CardContent>
          <CardFooter className="mt-6 gap-2">
            <Button disabled={busy || code.length !== 6} onClick={() => void enable()}>
              Turn on
            </Button>
            <Button variant="ghost" onClick={() => setSetup(null)}>
              Cancel
            </Button>
          </CardFooter>
        </>
      ) : (
        <CardFooter>
          <Button disabled={busy} onClick={() => void start()}>
            <ShieldCheck className="size-4" aria-hidden /> Set up 2FA
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function DisableTotp() {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const disable = async () => {
    setBusy(true);
    try {
      await api('/auth/2fa/disable', { method: 'POST', body: { password, code } });
      toast.success('Two-factor authentication is off');
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication <Badge>On</Badge>
        </CardTitle>
        <CardDescription>
          Your account asks for an authenticator code at login. To turn it off, confirm your
          password and a current code.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:max-w-sm">
        <FormField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <FormField
          label="Authentication code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </CardContent>
      <CardFooter className="mt-6">
        <Button
          variant="destructive"
          disabled={busy || !password || code.length !== 6}
          onClick={() => void disable()}
        >
          Turn off 2FA
        </Button>
      </CardFooter>
    </Card>
  );
}
