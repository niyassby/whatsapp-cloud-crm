'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Permission, type SegmentDto, type SegmentFilter } from '@wacrm/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { SegmentBuilder } from '@/components/contacts/segment-builder';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { contactKeys, useSegmentCount, useSegments } from '@/lib/contacts';
import { handleApiError } from '@/lib/forms';
import { useCan } from '@/lib/queries';

function SegmentDialog({ segment }: { segment?: SegmentDto }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(segment?.name ?? '');
  const [filter, setFilter] = useState<SegmentFilter | null>(
    segment?.filter ?? { match: 'all', rules: [] },
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!filter) return;
    setBusy(true);
    try {
      await api(segment ? `/segments/${segment.id}` : '/segments', {
        method: segment ? 'PATCH' : 'POST',
        body: { name, filter },
      });
      await queryClient.invalidateQueries({ queryKey: contactKeys.segments });
      setOpen(false);
      if (!segment) {
        setName('');
        setFilter({ match: 'all', rules: [] });
      }
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={segment ? 'ghost' : 'default'}>
          {segment ? 'Edit' : 'New segment'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{segment ? 'Edit segment' : 'New segment'}</DialogTitle>
          <DialogDescription>
            A saved filter. Membership updates by itself as contacts change.
          </DialogDescription>
        </DialogHeader>
        <FormField
          label="Name"
          name="segment-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {open && <SegmentBuilder initial={segment?.filter} onChange={setFilter} />}
        <DialogFooter>
          <Button disabled={!name.trim() || !filter || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save segment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SegmentRow({ segment, canManage }: { segment: SegmentDto; canManage: boolean }) {
  const queryClient = useQueryClient();
  const count = useSegmentCount(segment.id);

  const remove = async () => {
    try {
      await api(`/segments/${segment.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: contactKeys.segments });
      toast.success('Segment deleted');
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-2 border-b py-2 last:border-0">
      <span className="font-medium">{segment.name}</span>
      <span className="text-sm text-muted-foreground">
        {count.data ? `${count.data.count.toLocaleString()} contacts` : '…'}
      </span>
      {canManage && (
        <span className="ml-auto flex gap-1">
          <SegmentDialog key={segment.updatedAt} segment={segment} />
          <Button size="sm" variant="ghost" onClick={() => void remove()}>
            Delete
          </Button>
        </span>
      )}
    </li>
  );
}

export default function SegmentsPage() {
  const canManage = useCan(Permission.CONTACTS_MANAGE);
  const segments = useSegments();

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <div>
        <Button size="sm" variant="ghost" asChild>
          <Link href="/contacts">
            <ArrowLeft className="size-4" aria-hidden /> Contacts
          </Link>
        </Button>
      </div>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div className="grid gap-1.5">
            <CardTitle>Segments</CardTitle>
            <CardDescription>
              Filter contacts by tag, custom field, last activity or consent.
            </CardDescription>
          </div>
          {canManage && <SegmentDialog />}
        </CardHeader>
        <CardContent>
          {segments.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : !segments.data?.length ? (
            <p className="text-sm text-muted-foreground">No segments yet.</p>
          ) : (
            <ul>
              {segments.data.map((s) => (
                <SegmentRow key={s.id} segment={s} canManage={canManage} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
