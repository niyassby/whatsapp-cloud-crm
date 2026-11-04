'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';

function VerifyEmail() {
  const token = useSearchParams().get('token') ?? '';
  const queryClient = useQueryClient();
  const [state, setState] = useState<'pending' | 'ok' | 'error'>(token ? 'pending' : 'error');
  const [message, setMessage] = useState('This verification link is missing its token.');
  const started = useRef(false);

  useEffect(() => {
    // Single-use token: guard against React strict-mode double effects.
    if (!token || started.current) return;
    started.current = true;
    api('/auth/verify-email', { method: 'POST', body: { token }, auth: false })
      .then(() => {
        setState('ok');
        void queryClient.invalidateQueries({ queryKey: ['me'] });
      })
      .catch((err: unknown) => {
        setState('error');
        setMessage(err instanceof ApiError ? err.message : 'Something went wrong.');
      });
  }, [token, queryClient]);

  return (
    <Card>
      <CardHeader>
        {state === 'pending' && <CardTitle>Verifying your email…</CardTitle>}
        {state === 'ok' && (
          <>
            <CheckCircle2 className="size-8 text-primary" aria-hidden />
            <CardTitle>Email verified</CardTitle>
            <CardDescription>Thanks. Your email address is confirmed.</CardDescription>
          </>
        )}
        {state === 'error' && (
          <>
            <XCircle className="size-8 text-destructive" aria-hidden />
            <CardTitle>We could not verify your email</CardTitle>
            <CardDescription>
              {message} You can request a new link from the banner in the app.
            </CardDescription>
          </>
        )}
      </CardHeader>
      {state !== 'pending' && (
        <CardFooter>
          <Link href="/inbox" className="text-sm font-medium hover:underline">
            Continue to the app
          </Link>
        </CardFooter>
      )}
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
