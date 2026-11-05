'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { ContactDto } from '@wacrm/shared';
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
  DialogTrigger,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { contactKeys } from '@/lib/contacts';
import { handleApiError } from '@/lib/forms';

export function NewContactDialog() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const contact = await api<ContactDto>('/contacts', {
        method: 'POST',
        body: { phone, name: name || undefined, email: email || undefined },
      });
      await queryClient.invalidateQueries({ queryKey: contactKeys.all });
      setOpen(false);
      router.push(`/contacts/${contact.id}`);
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">New contact</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New contact</DialogTitle>
            <DialogDescription>
              New contacts have no marketing consent until you record it.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Phone number"
            name="contact-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91 98765 43210"
            hint="Include the country code."
            required
          />
          <FormField
            label="Name"
            name="contact-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <FormField
            label="Email"
            name="contact-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <DialogFooter>
            <Button type="submit" disabled={busy || !phone.trim()}>
              {busy ? 'Saving…' : 'Add contact'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
