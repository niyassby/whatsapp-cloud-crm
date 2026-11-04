'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Permission, type UpdateOrgInput, updateOrgSchema } from '@wacrm/shared';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { type OrgDto, queryKeys, useCan, useOrg } from '@/lib/queries';

export default function GeneralSettingsPage() {
  const queryClient = useQueryClient();
  const canEdit = useCan(Permission.ORG_UPDATE);
  const org = useOrg();
  const form = useForm<UpdateOrgInput>({ resolver: zodResolver(updateOrgSchema) });

  useEffect(() => {
    if (org.data) form.reset({ name: org.data.name, timezone: org.data.timezone });
  }, [org.data, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const updated = await api<OrgDto>('/orgs/current', { method: 'PATCH', body: values });
      queryClient.setQueryData(queryKeys.org, updated);
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      toast.success('Workspace updated');
    } catch (err) {
      handleApiError(err, form.setError);
    }
  });

  if (!org.data) return <Skeleton className="h-56 w-full" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
        <CardDescription>
          {canEdit
            ? 'Name and timezone used across the workspace.'
            : 'Only owners and admins can change these.'}
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="grid gap-4 sm:max-w-md">
          <FormField
            label="Workspace name"
            disabled={!canEdit}
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
          <FormField
            label="Timezone"
            disabled={!canEdit}
            hint="IANA name, e.g. Asia/Kolkata. Used for reports and business hours."
            error={form.formState.errors.timezone?.message}
            {...form.register('timezone')}
          />
          <FormField label="Workspace ID" value={org.data.id} readOnly disabled />
        </CardContent>
        {canEdit && (
          <CardFooter className="mt-6">
            <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
              Save changes
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}
