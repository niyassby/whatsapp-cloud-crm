'use client';

import { useQuery } from '@tanstack/react-query';
import type { DataDeletionStatusDto } from '@wacrm/shared';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

/** Public status page: Meta shows this link to people who asked to delete their data. */
function DataDeletionStatus() {
  const code = useSearchParams().get('code') ?? '';
  const status = useQuery({
    queryKey: ['data-deletion', code],
    queryFn: () =>
      api<DataDeletionStatusDto>(`/meta/data-deletion/${encodeURIComponent(code)}`, {
        auth: false,
      }),
    enabled: Boolean(code),
    retry: false,
  });

  if (!code || status.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Request not found</CardTitle>
          <CardDescription>We could not find a deletion request with this code.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!status.data) {
    return <Card className="p-6 text-sm text-muted-foreground">Checking your request…</Card>;
  }

  const done = status.data.status === 'completed';
  return (
    <Card>
      <CardHeader>
        <CardTitle>{done ? 'Your data was deleted' : 'Your request is being processed'}</CardTitle>
        <CardDescription>
          {done
            ? 'We removed the Facebook connection details we held for you.'
            : 'We received your request and are removing the Facebook connection details we hold for you.'}
          <br />
          Confirmation code: <code className="break-all">{status.data.confirmationCode}</code>
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

export default function DataDeletionPage() {
  return (
    <Suspense>
      <DataDeletionStatus />
    </Suspense>
  );
}
