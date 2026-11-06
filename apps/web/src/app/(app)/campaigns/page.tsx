'use client';

import { CAMPAIGN_STATUSES, type CampaignStatus } from '@wacrm/shared';
import Link from 'next/link';
import { useState } from 'react';
import { CampaignStatusBadge } from '@/components/campaigns/campaign-status';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CAMPAIGN_STATUS_LABELS, useCampaigns } from '@/lib/campaigns';

const ALL = '__all__';

const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export default function CampaignsPage() {
  const [status, setStatus] = useState<CampaignStatus | undefined>();
  const campaigns = useCampaigns(status);
  const rows = campaigns.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Campaigns</h1>
          <p className="text-sm text-muted-foreground">
            Send an approved template to a segment or a list.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/campaigns/drips">Drip sequences</Link>
          </Button>
          <Button asChild>
            <Link href="/campaigns/new">New campaign</Link>
          </Button>
        </div>
      </div>

      <div className="w-48">
        <Select
          value={status ?? ALL}
          onValueChange={(v) => setStatus(v === ALL ? undefined : (v as CampaignStatus))}
        >
          <SelectTrigger aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {CAMPAIGN_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {CAMPAIGN_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {campaigns.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {status ? 'No campaigns with this status.' : 'No campaigns yet. Create your first one.'}
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Starts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    <Link href={`/campaigns/${c.id}`} className="hover:underline">
                      {c.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <CampaignStatusBadge status={c.status} />
                  </TableCell>
                  <TableCell>{c.templateName}</TableCell>
                  <TableCell>{c.phoneDisplay ?? '—'}</TableCell>
                  <TableCell>{dateText(c.startedAt ?? c.scheduledAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {campaigns.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={campaigns.isFetchingNextPage}
          onClick={() => void campaigns.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
