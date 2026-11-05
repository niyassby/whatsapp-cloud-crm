'use client';

import type { PhoneNumberDto } from '@wacrm/shared';
import { useState } from 'react';
import { toast } from 'sonner';
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
import { handleApiError } from '@/lib/forms';

/** Numbers that already have 2-step verification need their existing PIN to register. */
export function RegisterDialog({
  phone,
  onDone,
}: {
  phone: PhoneNumberDto;
  onDone: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api(`/whatsapp/phone-numbers/${phone.id}/register`, {
        method: 'POST',
        body: pin ? { pin } : {},
      });
      toast.success('Number registered');
      setOpen(false);
      await onDone();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Retry
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register this number</DialogTitle>
          <DialogDescription>
            If the number already has a 2-step verification PIN, enter it. Otherwise leave this
            empty and we&apos;ll set one.
          </DialogDescription>
        </DialogHeader>
        <FormField
          label="6-digit PIN (optional)"
          name="pin"
          inputMode="numeric"
          maxLength={6}
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || (pin.length > 0 && pin.length !== 6)}
            onClick={() => void submit()}
          >
            {busy ? 'Registering…' : 'Register'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
