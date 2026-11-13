'use client';

import { useQueryClient } from '@tanstack/react-query';
import { formatMoney } from '@wacrm/shared';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import type { ConsolePath } from '@/lib/auth-store';
import { handleApiError } from '@/lib/forms';
import { newKey, startImpersonation } from '@/lib/reseller';

export interface WorkspaceRef {
  id: string;
  name: string;
}

/**
 * Asks why before opening someone else's workspace. The reason goes into that workspace's audit
 * log, where its owners can read it.
 */
export function ImpersonateDialog({
  workspace,
  basePath,
  returnTo,
  onClose,
}: {
  workspace: WorkspaceRef | null;
  /** `/partner/clients` or `/admin/orgs`. */
  basePath: string;
  returnTo: ConsolePath;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!workspace) return;
    setBusy(true);
    try {
      await startImpersonation(
        queryClient,
        `${basePath}/${workspace.id}/impersonate`,
        reason.trim(),
        returnTo,
      );
      router.push('/inbox');
    } catch (err) {
      handleApiError(err);
      setBusy(false);
    }
  };

  return (
    <Dialog open={workspace !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>View {workspace?.name}</DialogTitle>
            <DialogDescription>
              You will work inside this workspace as an admin for up to 30 minutes. Its owners can
              see that you were there, why, and everything you change.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Reason"
            name="impersonation-reason"
            value={reason}
            maxLength={300}
            placeholder="Client asked for help with a template"
            hint="Shown to the workspace in its audit log."
            onChange={(e) => setReason(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || reason.trim().length < 5}>
              Open workspace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Add funds to a workspace's wallet. One key per opening of the dialog, so a retry adds once. */
export function CreditDialog({
  workspace,
  basePath,
  currency,
  description,
  onClose,
  onDone,
}: {
  workspace: WorkspaceRef | null;
  basePath: string;
  currency: string;
  description: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setAmount('');
    setNote('');
    setKey(newKey());
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!workspace) return;
    setBusy(true);
    try {
      await api(`${basePath}/${workspace.id}/wallet/credit`, {
        method: 'POST',
        body: { amount: amount.trim(), note: note.trim(), idempotencyKey: key },
      });
      onDone();
      close();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const value = Number(amount);
  return (
    <Dialog open={workspace !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add funds to {workspace?.name}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FormField
            label={`Amount (${currency})`}
            name="credit-amount"
            inputMode="decimal"
            value={amount}
            placeholder="500"
            onChange={(e) => setAmount(e.target.value)}
          />
          <FormField
            label="Note"
            name="credit-note"
            value={note}
            maxLength={200}
            placeholder="Paid by bank transfer, invoice 1042"
            hint="Shown in the workspace's wallet history."
            onChange={(e) => setNote(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !(value > 0) || note.trim().length < 3}>
              {value > 0 ? `Add ${formatMoney(Math.round(value * 1_000_000), currency)}` : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
