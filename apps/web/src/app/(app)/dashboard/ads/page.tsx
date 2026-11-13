'use client';

import { useQuery } from '@tanstack/react-query';
import { type AdsReportDto, Permission } from '@wacrm/shared';
import Link from 'next/link';
import { useState } from 'react';
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
import { api, ApiError } from '@/lib/api';
import { useCan } from '@/lib/queries';

const RANGES = [7, 30, 90];

/** Click-to-WhatsApp and Instagram ads: what each brought in, and whether the team answered. */
export default function AdsReportPage() {
  const canRead = useCan(Permission.ANALYTICS_READ);
  const [days, setDays] = useState(30);
  const report = useQuery({
    queryKey: ['ads-report', days],
    enabled: canRead,
    retry: false,
    queryFn: () => api<AdsReportDto>(`/analytics/ads?days=${days}`),
  });

  if (!canRead) {
    return <p className="text-sm text-muted-foreground">Only owners and admins can see reports.</p>;
  }
  const notOnPlan =
    report.error instanceof ApiError && report.error.code === 'PLAN_FEATURE_UNAVAILABLE';
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold">Ad attribution</h1>
        <Link href="/dashboard" className="text-sm text-muted-foreground hover:underline">
          Back to dashboard
        </Link>
        <span className="ml-auto flex gap-1" role="group" aria-label="Period">
          {RANGES.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? 'secondary' : 'ghost'}
              aria-pressed={days === d}
              onClick={() => setDays(d)}
            >
              {d} days
            </Button>
          ))}
        </span>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Click-to-chat ads</CardTitle>
          <CardDescription>
            Each message that came from an ad is counted. New people had never written before.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {notOnPlan ? (
            <p className="text-sm text-muted-foreground">Ad reports are not on your plan.</p>
          ) : report.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : !report.data?.rows.length ? (
            <p className="text-sm text-muted-foreground">No messages from ads in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ad</TableHead>
                  <TableHead className="text-right">Messages</TableHead>
                  <TableHead className="text-right">Conversations</TableHead>
                  <TableHead className="text-right">New people</TableHead>
                  <TableHead className="text-right">Answered</TableHead>
                  <TableHead>Last</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.data.rows.map((r) => (
                  <TableRow key={r.sourceId ?? 'unknown'} data-testid={`ad-${r.sourceId}`}>
                    <TableCell>
                      <div className="font-medium">{r.headline ?? 'Untitled ad'}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.sourceId ?? 'No ad id'}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.referrals}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.conversations}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.newContacts}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.replied}</TableCell>
                    <TableCell>{new Date(r.lastAt).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
