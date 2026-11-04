'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type CreateOrgInput, createOrgSchema, type OrgSummary } from '@wacrm/shared';
import { useForm } from 'react-hook-form';
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
import { handleApiError } from '@/lib/forms';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (orgId: string) => void;
}

export function CreateOrgDialog({ open, onOpenChange, onCreated }: Props) {
  const form = useForm<CreateOrgInput>({
    resolver: zodResolver(createOrgSchema),
    defaultValues: { name: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const org = await api<OrgSummary>('/orgs', { method: 'POST', body: values });
      form.reset();
      onOpenChange(false);
      onCreated(org.id);
    } catch (err) {
      handleApiError(err, form.setError);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              Each workspace has its own WhatsApp numbers, team and contacts.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Business name"
            autoFocus
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
