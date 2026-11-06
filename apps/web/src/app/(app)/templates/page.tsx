'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Permission, TEMPLATE_STATUSES, type TemplateDto } from '@wacrm/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { rejectionText, TemplateStatusBadge } from '@/components/templates/template-status';
import { Badge } from '@/components/ui/badge';
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
import { handleApiError } from '@/lib/forms';
import { useCan } from '@/lib/queries';
import { STATUS_LABELS, templateKeys, useTemplates } from '@/lib/templates';

const ALL = '__all__';

export default function TemplatesPage() {
  const queryClient = useQueryClient();
  const canManage = useCan(Permission.TEMPLATES_MANAGE);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>();
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState<TemplateDto | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const templates = useTemplates(status, q);
  const items = templates.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: templateKeys.all });

  const sync = async () => {
    setSyncing(true);
    try {
      const { changed } = await api<{ changed: number }>('/templates/sync', { method: 'POST' });
      await refresh();
      toast.success(changed ? `${changed} template(s) updated from Meta` : 'Already up to date');
    } catch (err) {
      handleApiError(err);
    } finally {
      setSyncing(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await api(`/templates/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      await refresh();
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Templates</h1>
        {canManage && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={syncing} onClick={() => void sync()}>
              {syncing ? 'Checking…' : 'Sync with Meta'}
            </Button>
            <Button size="sm" asChild>
              <Link href="/templates/new">New template</Link>
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Search templates"
          className="w-56"
          placeholder="Search by name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={status ?? ALL} onValueChange={(v) => setStatus(v === ALL ? undefined : v)}>
          <SelectTrigger aria-label="Filter by status" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any status</SelectItem>
            {TEMPLATE_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {templates.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : templates.isError ? (
        <p className="text-sm text-destructive">{templates.error.message}</p>
      ) : items.length === 0 ? (
        <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">
          {q || status
            ? 'No templates match these filters.'
            : 'No templates yet. Create one, or sync those you already have at Meta.'}
        </p>
      ) : (
        <ul className="grid gap-2">
          {items.map((t) => (
            <li key={t.id} className="flex flex-wrap items-start gap-3 rounded-md border p-3">
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/templates/${t.id}`} className="font-medium hover:underline">
                    {t.name}
                  </Link>
                  <span className="text-sm text-muted-foreground">{t.language}</span>
                  <TemplateStatusBadge status={t.status} />
                  <Badge variant="outline">{t.category.toLowerCase()}</Badge>
                  {!t.supported && <Badge variant="outline">Cannot be sent here</Badge>}
                  {t.qualityScore && t.qualityScore !== 'UNKNOWN' && (
                    <Badge variant={t.qualityScore === 'RED' ? 'destructive' : 'outline'}>
                      Quality: {t.qualityScore.toLowerCase()}
                    </Badge>
                  )}
                </div>
                {t.definition && (
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {t.definition.body}
                  </p>
                )}
                {t.status === 'rejected' && (
                  <p className="mt-1 text-sm text-destructive">{rejectionText(t.rejectedReason)}</p>
                )}
              </div>
              {canManage && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${t.name} (${t.language})`}
                  onClick={() => setDeleting(t)}
                >
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {templates.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={templates.isFetchingNextPage}
            onClick={() => void templates.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      )}

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting?.name}?</DialogTitle>
            <DialogDescription>
              {deleting?.metaTemplateId
                ? 'This also deletes it at Meta, in this language only. After deleting an approved template, Meta does not let you reuse its name for 30 days.'
                : 'This draft was never submitted, so it is only removed here.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void remove()}>
              Delete template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
