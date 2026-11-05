'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { ContactDto } from '@wacrm/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { contactKeys, contactLabel } from '@/lib/contacts';
import { handleApiError } from '@/lib/forms';
import { inboxKeys } from '@/lib/inbox';

export function MergeDialog({ contacts, onDone }: { contacts: ContactDto[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [primaryId, setPrimaryId] = useState(contacts[0]?.id);
  const [busy, setBusy] = useState(false);
  const chosen = contacts.some((c) => c.id === primaryId) ? primaryId : contacts[0]?.id;

  const merge = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await api('/contacts/merge', {
        method: 'POST',
        body: {
          primaryId: chosen,
          duplicateIds: contacts.filter((c) => c.id !== chosen).map((c) => c.id),
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: contactKeys.all }),
        queryClient.invalidateQueries({ queryKey: inboxKeys.all }),
      ]);
      toast.success('Contacts merged');
      setOpen(false);
      onDone();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={contacts.length < 2 || contacts.length > 11}>
          Merge
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge {contacts.length} contacts</DialogTitle>
          <DialogDescription>
            Choose the contact to keep. Its values win and gaps are filled from the others.
            Conversations, tags and notes move over. If anyone opted out, the result is opted out.
            This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-1">
          <legend className="sr-only">Contact to keep</legend>
          {contacts.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm"
            >
              <input
                type="radio"
                name="merge-primary"
                checked={chosen === c.id}
                onChange={() => setPrimaryId(c.id)}
              />
              <span className="font-medium">{contactLabel(c)}</span>
              <span className="text-muted-foreground">+{c.waId}</span>
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Replies go to the number of the contact you keep, so an open 24-hour window on another
          number does not carry over.
        </p>
        <DialogFooter>
          <Button disabled={busy} onClick={() => void merge()}>
            {busy ? 'Merging…' : 'Merge contacts'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
