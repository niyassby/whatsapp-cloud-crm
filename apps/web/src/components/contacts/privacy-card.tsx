'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ContactDto, ERASED_CONFIRM_WORD, type PrivacyRequestDto } from '@wacrm/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { contactKeys } from '@/lib/contacts';

const KIND_LABEL: Record<string, string> = {
  contact_export: 'Data export',
  contact_erase: 'Erasure',
};
const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting',
  running: 'In progress',
  done: 'Done',
  failed: 'Failed',
  expired: 'Expired',
};

/**
 * Data requests for one person (GDPR and DPDP): export what is held about them, or erase it.
 * Erasure cannot be undone, so their name (or ERASE) is typed to confirm.
 */
export function PrivacyCard({ contact }: { contact: ContactDto }) {
  const queryClient = useQueryClient();
  const key = ['privacy', contact.id];
  const requests = useQuery({
    queryKey: key,
    queryFn: () => api<PrivacyRequestDto[]>(`/privacy/contacts/${contact.id}/requests`),
    // Requests finish in the background; look again while one is under way.
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === 'pending' || r.status === 'running') ? 3000 : false,
  });
  const [erasing, setErasing] = useState(false);
  const [confirm, setConfirm] = useState('');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: contactKeys.contact(contact.id) });
  };

  const exportData = useMutation({
    mutationFn: () =>
      api<PrivacyRequestDto>(`/privacy/contacts/${contact.id}/export`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Preparing the export');
      refresh();
    },
    onError: (err) => toast.error(err.message),
  });
  const erase = useMutation({
    mutationFn: () =>
      api<PrivacyRequestDto>(`/privacy/contacts/${contact.id}/erase`, {
        method: 'POST',
        body: { confirm },
      }),
    onSuccess: () => {
      toast.success('Erasing their data');
      setErasing(false);
      setConfirm('');
      refresh();
    },
    onError: (err) => toast.error(err.message),
  });
  const download = async (id: string) => {
    try {
      const { url } = await api<{ url: string }>(`/privacy/contacts/requests/${id}/download`);
      window.location.assign(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download');
    }
  };

  const erased = contact.erasedAt !== null;
  const expected = contact.name?.trim() || ERASED_CONFIRM_WORD;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Privacy</CardTitle>
        <CardDescription>
          When this person asks for their data, or to be forgotten. Exports are kept for 7 days.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={erased || exportData.isPending}
            onClick={() => exportData.mutate()}
          >
            Export their data
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={erased}
            onClick={() => setErasing(true)}
          >
            Erase their data
          </Button>
        </div>
        {requests.data?.length ? (
          <ul className="flex flex-col gap-1 text-sm" data-testid="privacy-requests">
            {requests.data.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span>{KIND_LABEL[r.kind] ?? r.kind}</span>
                <Badge variant={r.status === 'failed' ? 'destructive' : 'secondary'}>
                  {STATUS_LABEL[r.status] ?? r.status}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
                {r.kind === 'contact_export' && r.status === 'done' ? (
                  <Button size="sm" variant="ghost" onClick={() => void download(r.id)}>
                    Download
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>

      <Dialog open={erasing} onOpenChange={setErasing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Erase this person’s data?</DialogTitle>
            <DialogDescription>
              Their name, number, email, fields, notes, tags, and every message and file in their
              conversations are erased, and they stay opted out. Message counts and bills are kept.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              erase.mutate();
            }}
          >
            <Label htmlFor="erase-confirm">
              Type <strong>{expected}</strong> to confirm
            </Label>
            <Input
              id="erase-confirm"
              autoComplete="off"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setErasing(false)}>
                Keep their data
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={confirm.trim() !== expected || erase.isPending}
              >
                Erase
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
