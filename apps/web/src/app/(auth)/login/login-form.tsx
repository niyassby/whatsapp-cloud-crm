'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import {
  type LoginInput,
  type LoginResponse,
  loginSchema,
  type MfaVerifyInput,
  mfaVerifySchema,
  type AuthTokensResponse,
} from '@wacrm/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
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
import { api, safeNext, setSession } from '@/lib/api';
import { handleApiError } from '@/lib/forms';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const next = safeNext(params.get('next'));
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  const finish = (tokens: AuthTokensResponse) => {
    setSession(tokens);
    queryClient.clear();
    router.replace(next);
  };

  const login = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });
  const mfa = useForm<MfaVerifyInput>({
    resolver: zodResolver(mfaVerifySchema),
    defaultValues: { mfaToken: '', code: '' },
  });

  const onLogin = login.handleSubmit(async (values) => {
    try {
      const res = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: values,
        auth: false,
      });
      if ('mfaRequired' in res) {
        setMfaToken(res.mfaToken);
        mfa.reset({ mfaToken: res.mfaToken, code: '' });
      } else finish(res);
    } catch (err) {
      handleApiError(err, login.setError);
    }
  });

  const onMfa = mfa.handleSubmit(async (values) => {
    try {
      finish(
        await api<AuthTokensResponse>('/auth/2fa/verify', {
          method: 'POST',
          body: values,
          auth: false,
        }),
      );
    } catch (err) {
      const apiErr = handleApiError(err);
      if (apiErr?.code === 'MFA_INVALID')
        mfa.setError('code', { message: 'That code did not work. Try the newest one.' });
    }
  });

  if (mfaToken) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>Enter the 6-digit code from your authenticator app.</CardDescription>
        </CardHeader>
        <form onSubmit={onMfa} noValidate>
          <CardContent className="grid gap-4">
            <FormField
              label="Authentication code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              error={mfa.formState.errors.code?.message}
              {...mfa.register('code')}
            />
          </CardContent>
          <CardFooter className="mt-6 flex flex-col gap-3">
            <Button type="submit" className="w-full" disabled={mfa.formState.isSubmitting}>
              {mfa.formState.isSubmitting ? 'Verifying…' : 'Verify'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => setMfaToken(null)}
            >
              Back to login
            </Button>
          </CardFooter>
        </form>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Log in</CardTitle>
        <CardDescription>Welcome back. Log in to your workspace.</CardDescription>
      </CardHeader>
      <form onSubmit={onLogin} noValidate>
        <CardContent className="grid gap-4">
          <FormField
            label="Email"
            type="email"
            autoComplete="email"
            autoFocus
            error={login.formState.errors.email?.message}
            {...login.register('email')}
          />
          <div className="grid gap-1.5">
            <FormField
              label="Password"
              type="password"
              autoComplete="current-password"
              error={login.formState.errors.password?.message}
              {...login.register('password')}
            />
            <Link
              href="/forgot-password"
              className="justify-self-end text-sm text-muted-foreground hover:underline"
            >
              Forgot password?
            </Link>
          </div>
        </CardContent>
        <CardFooter className="mt-6 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={login.formState.isSubmitting}>
            {login.formState.isSubmitting ? 'Logging in…' : 'Log in'}
          </Button>
          <p className="text-sm text-muted-foreground">
            New here?{' '}
            <Link
              href={`/signup${next !== '/inbox' ? `?next=${encodeURIComponent(next)}` : ''}`}
              className="font-medium text-foreground hover:underline"
            >
              Create an account
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
