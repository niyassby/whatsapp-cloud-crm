'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import {
  canManageRole,
  type CreateInvitationInput,
  createInvitationSchema,
  type Role,
  ROLES,
} from '@wacrm/shared';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { queryKeys } from '@/lib/queries';

export function InviteDialog({ myRole }: { myRole: Role }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const form = useForm<CreateInvitationInput>({
    resolver: zodResolver(createInvitationSchema),
    defaultValues: { email: '', role: 'agent' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await api('/team/invitations', { method: 'POST', body: values });
      toast.success(`Invitation sent to ${values.email}`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.invitations });
      form.reset();
      setOpen(false);
    } catch (err) {
      const apiErr = handleApiError(err, form.setError);
      if (apiErr?.code === 'ALREADY_MEMBER') form.setError('email', { message: apiErr.message });
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus className="size-4" aria-hidden /> Invite
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Invite a teammate</DialogTitle>
            <DialogDescription>
              They get an email with a link that expires in 7 days.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Email"
            type="email"
            autoFocus
            error={form.formState.errors.email?.message}
            {...form.register('email')}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Controller
              control={form.control}
              name="role"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.filter((r) => canManageRole(myRole, r)).map((r) => (
                      <SelectItem key={r} value={r} className="capitalize">
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
