'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type BulkContactsInput,
  type OptInStatus,
  OPT_IN_STATUSES,
  Permission,
} from '@wacrm/shared';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import {
  contactKeys,
  contactLabel,
  type ContactFilters,
  OPT_IN_LABELS,
  useContactCount,
  useContacts,
  useSegments,
  useTags,
} from '@/lib/contacts';
import { handleApiError } from '@/lib/forms';
import { displayWaId, shortTime } from '@/lib/inbox';
import { useCan } from '@/lib/queries';
import { ConsentBadge } from './consent-badge';
import { MergeDialog } from './merge-dialog';
import { TagChip } from './tag-chip';

const ALL = '__all__';
const ROW_HEIGHT = 52;
const GRID =
  'grid grid-cols-[2rem_minmax(10rem,1.4fr)_9.5rem_7rem_minmax(8rem,1fr)_6rem] items-center gap-2';

type PendingBulk = { action: BulkContactsInput['action']; title: string; description: string };

export function ContactsTable() {
  const queryClient = useQueryClient();
  const canManage = useCan(Permission.CONTACTS_MANAGE);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [tagId, setTagId] = useState<string>();
  const [optIn, setOptIn] = useState<OptInStatus>();
  const [segmentId, setSegmentId] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingBulk | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = useMemo<ContactFilters>(
    () => ({ q: q || undefined, tagId, optIn, segmentId }),
    [q, tagId, optIn, segmentId],
  );
  const query = useContacts(filters);
  const count = useContactCount(filters);
  const tags = useTags();
  const segments = useSegments();
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const rows = virtualizer.getVirtualItems();
  const lastIndex = rows.at(-1)?.index;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (
      lastIndex !== undefined &&
      lastIndex >= items.length - 20 &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      void fetchNextPage();
    }
  }, [lastIndex, items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allLoadedSelected = items.length > 0 && items.every((c) => selected.has(c.id));
  const selectedContacts = items.filter((c) => selected.has(c.id));

  const runBulk = async (action: BulkContactsInput['action']) => {
    setBusy(true);
    try {
      const res = await api<{ affected: number }>('/contacts/bulk', {
        method: 'POST',
        body: { ids: [...selected], action },
      });
      toast.success(`${res.affected.toLocaleString()} contact(s) changed`);
      setPending(null);
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: contactKeys.all });
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const exportList = async () => {
    try {
      await api('/contact-jobs/export', { method: 'POST', body: filters });
      await queryClient.invalidateQueries({ queryKey: contactKeys.jobs });
      toast.success('Export started. It will appear here when it is ready.');
    } catch (err) {
      handleApiError(err);
    }
  };

  const filtersActive = Boolean(q || tagId || optIn || segmentId);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search contacts"
          className="w-56"
          placeholder="Search name, number or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          value={segmentId ?? ALL}
          onValueChange={(v) => setSegmentId(v === ALL ? undefined : v)}
        >
          <SelectTrigger aria-label="Filter by segment" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All segments</SelectItem>
            {segments.data?.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={tagId ?? ALL} onValueChange={(v) => setTagId(v === ALL ? undefined : v)}>
          <SelectTrigger aria-label="Filter by tag" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All tags</SelectItem>
            {tags.data?.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={optIn ?? ALL}
          onValueChange={(v) => setOptIn(v === ALL ? undefined : (v as OptInStatus))}
        >
          <SelectTrigger aria-label="Filter by consent" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any consent</SelectItem>
            {OPT_IN_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {OPT_IN_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {count.data ? `${count.data.count.toLocaleString()} contacts` : ''}
        </span>
        {canManage && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void exportList()}>
            Export {filtersActive ? 'filtered' : 'all'}
          </Button>
        )}
      </div>

      {canManage && selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md bg-muted p-2 text-sm"
          role="toolbar"
          aria-label="Bulk actions"
        >
          <span className="font-medium">{selected.size.toLocaleString()} selected</span>
          <Select value="" onValueChange={(v) => void runBulk({ type: 'add_tag', tagId: v })}>
            <SelectTrigger
              aria-label="Add a tag to the selected contacts"
              size="sm"
              className="w-32"
            >
              <SelectValue placeholder="Add tag" />
            </SelectTrigger>
            <SelectContent>
              {tags.data?.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value="" onValueChange={(v) => void runBulk({ type: 'remove_tag', tagId: v })}>
            <SelectTrigger
              aria-label="Remove a tag from the selected contacts"
              size="sm"
              className="w-32"
            >
              <SelectValue placeholder="Remove tag" />
            </SelectTrigger>
            <SelectContent>
              {tags.data?.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <MergeDialog contacts={selectedContacts} onDone={() => setSelected(new Set())} />
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setPending({
                action: { type: 'opt_out' },
                title: `Opt out ${selected.size.toLocaleString()} contact(s)?`,
                description:
                  'They will stop receiving marketing. Each contact then needs new proof of consent to opt back in.',
              })
            }
          >
            Opt out
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() =>
              setPending({
                action: { type: 'delete' },
                title: `Delete ${selected.size.toLocaleString()} contact(s)?`,
                description:
                  'They disappear from your list. Conversations and consent records are kept, and a contact returns if they message you.',
              })
            }
          >
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-x-auto rounded-md border">
        <div
          className="flex min-h-0 min-w-[44rem] flex-1 flex-col"
          role="table"
          aria-label="Contacts"
        >
          <div
            className={`${GRID} border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground`}
            role="row"
          >
            <span role="columnheader">
              {canManage && (
                <input
                  type="checkbox"
                  aria-label="Select all loaded contacts"
                  checked={allLoadedSelected}
                  onChange={() =>
                    setSelected(
                      allLoadedSelected
                        ? new Set()
                        : new Set(items.slice(0, 1000).map((c) => c.id)),
                    )
                  }
                />
              )}
            </span>
            <span role="columnheader">Name</span>
            <span role="columnheader">Number</span>
            <span role="columnheader">Consent</span>
            <span role="columnheader">Tags</span>
            <span role="columnheader">Active</span>
          </div>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            {query.isPending ? (
              <div className="grid gap-2 p-3">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : query.isError ? (
              <p className="p-6 text-center text-sm text-destructive">{query.error.message}</p>
            ) : items.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {filtersActive
                  ? 'No contacts match these filters.'
                  : 'No contacts yet. Add one, import a CSV, or wait for a customer to message you.'}
              </p>
            ) : (
              <div
                className="relative"
                style={{ height: virtualizer.getTotalSize() }}
                role="rowgroup"
              >
                {rows.map((row) => {
                  const c = items[row.index];
                  if (!c) return null;
                  return (
                    <div
                      key={c.id}
                      role="row"
                      className={`${GRID} absolute inset-x-0 border-b px-3 text-sm hover:bg-muted/40`}
                      style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                    >
                      <span role="cell">
                        {canManage && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${contactLabel(c)}`}
                            checked={selected.has(c.id)}
                            onChange={() => toggle(c.id)}
                          />
                        )}
                      </span>
                      <span role="cell" className="truncate">
                        <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">
                          {contactLabel(c)}
                        </Link>
                      </span>
                      <span role="cell" className="truncate text-muted-foreground">
                        {displayWaId(c.waId)}
                      </span>
                      <span role="cell">
                        <ConsentBadge status={c.optInStatus} />
                      </span>
                      <span role="cell" className="flex gap-1 overflow-hidden">
                        {c.tags.slice(0, 2).map((t) => (
                          <TagChip key={t.id} tag={t} />
                        ))}
                        {c.tags.length > 2 && (
                          <span className="text-xs text-muted-foreground">
                            +{c.tags.length - 2}
                          </span>
                        )}
                      </span>
                      <span role="cell" className="truncate text-xs text-muted-foreground">
                        {c.lastActivityAt ? shortTime(c.lastActivityAt) : 'Never'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending?.title}</DialogTitle>
            <DialogDescription>{pending?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => pending && void runBulk(pending.action)}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
