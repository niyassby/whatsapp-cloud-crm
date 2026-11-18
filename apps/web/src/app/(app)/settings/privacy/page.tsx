'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Permission, type PrivacyRequestDto, type PrivacySettingsDto } from '@wacrm/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useCan, useOrg } from '@/lib/queries';

const RETENTION = [
  { value: '', label: 'Keep messages' },
  { value: '90', label: '90 days' },
  { value: '180', label: '6 months' },
  { value: '365', label: '1 year' },
  { value: '730', label: '2 years' },
];

const bytes = (n: number | null) =>
  n === null
    ? ''
    : n < 1_048_576
      ? `${Math.ceil(n / 1024)} KB`
      : `${(n / 1_048_576).toFixed(1)} MB`;

/**
 * Owners only: how long message content is kept, a full export of the workspace, and deleting
 * it, with a grace period during which it can be cancelled (Phase 4.4).
 */
export default function PrivacySettingsPage() {
  const canDelete = useCan(Permission.ORG_DELETE);
  const queryClient = useQueryClient();
  const org = useOrg();
  const settings = useQuery({
    queryKey: ['privacy', 'workspace'],
    enabled: canDelete,
    queryFn: () => api<PrivacySettingsDto>('/privacy/workspace'),
  });
  const exports = useQuery({
    queryKey: ['privacy', 'workspace', 'exports'],
    enabled: canDelete,
    queryFn: () => api<PrivacyRequestDto[]>('/privacy/workspace/exports'),
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === 'pending' || r.status === 'running') ? 3000 : false,
  });
  const [confirmName, setConfirmName] = useState('');
  const set = (data: PrivacySettingsDto) =>
    queryClient.setQueryData(['privacy', 'workspace'], data);
  const onError = (err: Error) => toast.error(err.message);

  const retention = useMutation({
    mutationFn: (days: number | null) =>
      api<PrivacySettingsDto>('/privacy/workspace/retention', {
        method: 'PATCH',
        body: { messageRetentionDays: days },
      }),
    onSuccess: (d) => {
      set(d);
      toast.success('Saved');
    },
    onError,
  });
  const startExport = useMutation({
    mutationFn: () => api<PrivacyRequestDto>('/privacy/workspace/exports', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Preparing the export');
      void queryClient.invalidateQueries({ queryKey: ['privacy', 'workspace', 'exports'] });
    },
    onError,
  });
  const requestDeletion = useMutation({
    mutationFn: () =>
      api<PrivacySettingsDto>('/privacy/workspace/deletion', {
        method: 'POST',
        body: { confirmName },
      }),
    onSuccess: (d) => {
      set(d);
      setConfirmName('');
    },
    onError,
  });
  const cancelDeletion = useMutation({
    mutationFn: () => api<PrivacySettingsDto>('/privacy/workspace/deletion', { method: 'DELETE' }),
    onSuccess: (d) => {
      set(d);
      toast.success('The workspace will not be deleted');
    },
    onError,
  });
  const download = async (id: string) => {
    try {
      const { url } = await api<{ url: string }>(`/privacy/workspace/exports/${id}/download`);
      window.location.assign(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download');
    }
  };

  if (!canDelete) {
    return (
      <p className="text-sm text-muted-foreground">Only owners can manage privacy settings.</p>
    );
  }
  if (settings.isPending || !settings.data) return <Skeleton className="h-60 w-full" />;
  const s = settings.data;
  const name = org.data?.name ?? '';

  return (
    <div className="flex flex-col gap-4">
      {s.deletesAt ? (
        <Alert variant="destructive" data-testid="deletion-pending">
          <AlertTitle>
            This workspace will be deleted on {new Date(s.deletesAt).toLocaleDateString()}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            Everything keeps working until then. After that its numbers are disconnected, and a week
            later all of its data is removed for good.
            <Button
              size="sm"
              variant="outline"
              disabled={cancelDeletion.isPending}
              onClick={() => cancelDeletion.mutate()}
            >
              Keep the workspace
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Message retention</CardTitle>
          <CardDescription>
            The text and files of older messages are erased every night. Counts, dates and bills are
            kept.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="retention">Keep message content for</Label>
            <select
              id="retention"
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              value={s.messageRetentionDays?.toString() ?? ''}
              onChange={(e) => retention.mutate(e.target.value ? Number(e.target.value) : null)}
            >
              {RETENTION.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Export all data</CardTitle>
          <CardDescription>
            Every contact, conversation, message and setting as one compressed file of JSON lines.
            Credentials are left out. Files are kept for 7 days.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button
            variant="outline"
            className="self-start"
            disabled={startExport.isPending}
            onClick={() => startExport.mutate()}
          >
            Export the workspace
          </Button>
          {exports.data?.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-sm">
              <Badge variant={r.status === 'failed' ? 'destructive' : 'secondary'}>
                {r.status}
              </Badge>
              <span className="text-muted-foreground">
                {new Date(r.createdAt).toLocaleString()}
              </span>
              <span className="text-muted-foreground">{bytes(r.fileSize)}</span>
              {r.status === 'done' ? (
                <Button size="sm" variant="ghost" onClick={() => void download(r.id)}>
                  Download
                </Button>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      {!s.deletesAt ? (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle>Delete this workspace</CardTitle>
            <CardDescription>
              After 14 days its numbers are disconnected and nobody can sign in to it; a week later
              all of its data is removed. You can cancel during the 14 days. Export first if you
              want to keep anything.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                requestDeletion.mutate();
              }}
            >
              <div className="flex flex-col gap-1">
                <Label htmlFor="confirm-name">
                  Type <strong>{name}</strong> to confirm
                </Label>
                <Input
                  id="confirm-name"
                  autoComplete="off"
                  className="w-64"
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                />
              </div>
              <Button
                type="submit"
                variant="destructive"
                disabled={confirmName.trim() !== name.trim() || requestDeletion.isPending}
              >
                Delete workspace
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
