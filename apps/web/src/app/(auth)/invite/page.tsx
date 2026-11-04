'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AuthTokensResponse,
  type InvitationPreviewDto,
  type MeResponse,
  passwordSchema,
} from '@wacrm/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
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
import { api, ApiError, refreshSession, setSession } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { handleApiError } from '@/lib/forms';

const newAccountSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(100),
  password: passwordSchema,
});
type NewAccount = z.infer<typeof newAccountSchema>;

function AcceptInvite() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((s) => s.accessToken);
  const [sessionChecked, setSessionChecked] = useState(false);

  // Restore an existing session (if any) so logged-in users can accept with one click.
  useEffect(() => {
    if (accessToken) setSessionChecked(true);
    else void refreshSession().finally(() => setSessionChecked(true));
  }, [accessToken]);

  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () =>
      api<InvitationPreviewDto>('/invitations/preview', {
        method: 'POST',
        body: { token },
        auth: false,
      }),
    enabled: Boolean(token),
    retry: false,
  });

  // Who is logged in (if anyone), to catch "invited email != current account" up front.
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/auth/me'),
    enabled: sessionChecked && Boolean(accessToken),
    retry: false,
  });

  const logoutAndContinue = async () => {
    await api('/auth/logout', { method: 'POST', auth: false }).catch(() => undefined);
    useAuthStore.getState().setAccessToken(null);
    queryClient.removeQueries({ queryKey: ['me'] });
  };

  const form = useForm<NewAccount>({
    resolver: zodResolver(newAccountSchema),
    defaultValues: { name: '', password: '' },
  });

  const accept = async (extra: Partial<NewAccount> = {}) => {
    try {
      const tokens = await api<AuthTokensResponse>('/invitations/accept', {
        method: 'POST',
        body: { token, ...extra },
        auth: Boolean(accessToken),
      });
      setSession(tokens);
      queryClient.clear();
      router.replace('/inbox');
    } catch (err) {
      handleApiError(err, form.setError);
    }
  };

  if (!token || preview.isError) {
    const message =
      preview.error instanceof ApiError
        ? preview.error.message
        : 'This invitation link is not valid.';
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invitation unavailable</CardTitle>
          <CardDescription>
            {message} Ask the person who invited you for a new link.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!preview.data || !sessionChecked || (accessToken && me.isPending)) {
    return <Card className="p-6 text-sm text-muted-foreground">Loading invitation…</Card>;
  }

  const inv = preview.data;
  const heading = (
    <CardHeader>
      <CardTitle>Join {inv.orgName}</CardTitle>
      <CardDescription>
        You were invited as <strong className="text-foreground">{inv.role}</strong> ({inv.email}).
      </CardDescription>
    </CardHeader>
  );

  if (accessToken && me.data && me.data.user.email !== inv.email) {
    return (
      <Card>
        {heading}
        <CardContent className="text-sm text-muted-foreground">
          You are logged in as <strong className="text-foreground">{me.data.user.email}</strong>.
          Log out to accept this invitation as {inv.email}.
        </CardContent>
        <CardFooter>
          <Button className="w-full" variant="outline" onClick={() => void logoutAndContinue()}>
            Log out and continue
          </Button>
        </CardFooter>
      </Card>
    );
  }

  if (accessToken) {
    return (
      <Card>
        {heading}
        <CardFooter className="flex flex-col gap-3">
          <Button className="w-full" onClick={() => void accept()}>
            Accept invitation
          </Button>
        </CardFooter>
      </Card>
    );
  }

  if (inv.accountExists) {
    const next = `/invite?token=${encodeURIComponent(token)}`;
    return (
      <Card>
        {heading}
        <CardFooter>
          <Button asChild className="w-full">
            <Link href={`/login?next=${encodeURIComponent(next)}`}>Log in to accept</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      {heading}
      <form onSubmit={form.handleSubmit((v) => accept(v))} noValidate>
        <CardContent className="grid gap-4">
          <FormField label="Email" value={inv.email} disabled readOnly />
          <FormField
            label="Your name"
            autoComplete="name"
            autoFocus
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
          <FormField
            label="Password"
            type="password"
            autoComplete="new-password"
            hint="At least 10 characters."
            error={form.formState.errors.password?.message}
            {...form.register('password')}
          />
        </CardContent>
        <CardFooter className="mt-6">
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Joining…' : 'Create account and join'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function InvitePage() {
  return (
    <Suspense>
      <AcceptInvite />
    </Suspense>
  );
}
