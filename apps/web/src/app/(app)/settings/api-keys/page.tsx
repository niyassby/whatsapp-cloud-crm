'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  API_SCOPE_LABELS,
  API_SCOPES,
  type ApiKeyDto,
  type ApiScope,
  type CreatedApiKeyDto,
  Permission,
} from '@wacrm/shared';
import { type FormEvent, useState } from 'react';
import { FormField } from '@/components/form-field';
import { ShownOnce } from '@/components/settings/shown-once';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { developerKeys, useApiKeys } from '@/lib/developer';
import { env } from '@/lib/env';
import { handleApiError } from '@/lib/forms';
import { useCan } from '@/lib/queries';

const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : 'Never');

function keyState(k: ApiKeyDto): { label: string; live: boolean } {
  if (k.revokedAt) return { label: 'Revoked', live: false };
  if (k.expiresAt && new Date(k.expiresAt) <= new Date()) return { label: 'Expired', live: false };
  return { label: 'Active', live: true };
}

function NewKey({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await api<CreatedApiKeyDto>('/api-keys', {
        method: 'POST',
        body: { name: name.trim(), scopes },
      });
      await queryClient.invalidateQueries({ queryKey: developerKeys.apiKeys });
      onCreated(created.key);
      onClose();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>
              Give each integration its own key, with only what it needs.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Name"
            name="key-name"
            value={name}
            maxLength={80}
            placeholder="Order system"
            onChange={(e) => setName(e.target.value)}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">What it can do</legend>
            {API_SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(e) =>
                    setScopes((all) =>
                      e.target.checked ? [...all, scope] : all.filter((s) => s !== scope),
                    )
                  }
                />
                {API_SCOPE_LABELS[scope]}
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button type="submit" disabled={busy || !name.trim() || scopes.length === 0}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ApiKeysPage() {
  const queryClient = useQueryClient();
  const canManage = useCan(Permission.API_KEYS_MANAGE);
  const keys = useApiKeys();
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<string | null>(null);

  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">Only owners and admins can manage API keys.</p>
    );
  }

  const revoke = async (key: ApiKeyDto) => {
    if (!window.confirm(`Revoke "${key.name}"? Anything using it stops working straight away.`)) {
      return;
    }
    try {
      await api(`/api-keys/${key.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: developerKeys.apiKeys });
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {shown && <ShownOnce title="Your new API key" value={shown} onDone={() => setShown(null)} />}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle>API keys</CardTitle>
            <CardDescription>
              Let your own systems use this workspace.{' '}
              <a
                className="underline"
                href={`${env.NEXT_PUBLIC_API_URL}/v1/docs`}
                target="_blank"
                rel="noreferrer"
              >
                API documentation
              </a>
            </CardDescription>
          </div>
          <Button onClick={() => setCreating(true)}>New key</Button>
        </CardHeader>
        <CardContent>
          {keys.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : !keys.data?.length ? (
            <p className="text-sm text-muted-foreground">No API keys yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.data.map((k) => {
                  const state = keyState(k);
                  return (
                    <TableRow key={k.id}>
                      <TableCell className="font-medium">
                        {k.name} {!state.live && <Badge variant="outline">{state.label}</Badge>}
                      </TableCell>
                      <TableCell className="font-mono text-xs">wak_{k.prefix}_…</TableCell>
                      <TableCell>
                        {k.scopes.length} permission{k.scopes.length === 1 ? '' : 's'}
                      </TableCell>
                      <TableCell>{dateText(k.lastUsedAt)}</TableCell>
                      <TableCell className="text-right">
                        {state.live && (
                          <Button variant="ghost" size="sm" onClick={() => void revoke(k)}>
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {creating && (
        <NewKey open onClose={() => setCreating(false)} onCreated={(key) => setShown(key)} />
      )}
    </div>
  );
}
