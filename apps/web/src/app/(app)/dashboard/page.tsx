'use client';

import { useState } from 'react';
import { VolumeChart } from '@/components/dashboard/volume-chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import Link from 'next/link';
import { useDashboard } from '@/lib/campaigns';

const percent = (rate: number | null) => (rate === null ? '—' : `${(rate * 100).toFixed(1)}%`);

function duration(seconds: number | null) {
  if (seconds === null) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums" data-testid={`tile-${label}`}>
          {value}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardHeader>
    </Card>
  );
}

export default function DashboardPage() {
  const [days, setDays] = useState(30);
  const dashboard = useDashboard(days);
  const data = dashboard.data;
  const hasMessages = data ? data.totals.inbound + data.totals.outbound > 0 : false;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold">Dashboard</h1>
            <Link
              href="/dashboard/ads"
              className="text-sm text-primary underline-offset-4 hover:underline"
            >
              Ad attribution
            </Link>
            {data && <p className="text-sm text-muted-foreground">Days shown in {data.timezone}</p>}
          </div>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger aria-label="Time range" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {!data ? (
          <Skeleton className="h-96 w-full" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile
                label="Delivery rate"
                value={percent(data.outbound.deliveryRate)}
                hint={`${data.outbound.delivered.toLocaleString()} of ${data.outbound.attempted.toLocaleString()} sent`}
              />
              <Tile
                label="Read rate"
                value={percent(data.outbound.readRate)}
                hint={`${data.outbound.read.toLocaleString()} read, ${data.outbound.failed.toLocaleString()} failed`}
              />
              <Tile
                label="Median response time"
                value={duration(data.responseTime.medianSeconds)}
                hint={`Across ${data.responseTime.replied.toLocaleString()} team replies`}
              />
              <Tile
                label="Active conversations"
                value={data.activeConversations.toLocaleString()}
                hint="Open right now"
              />
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Messages per day</CardTitle>
                <CardDescription>
                  {data.totals.inbound.toLocaleString()} received,{' '}
                  {data.totals.outbound.toLocaleString()} sent
                </CardDescription>
              </CardHeader>
              <CardContent>
                {hasMessages ? (
                  <VolumeChart points={data.volume} />
                ) : (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    No messages in this period yet.
                  </p>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
