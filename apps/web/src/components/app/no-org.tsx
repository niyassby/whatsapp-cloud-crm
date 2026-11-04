'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { AuthTokensResponse, MeResponse } from '@wacrm/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { api, setSession } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { CreateOrgDialog } from './create-org-dialog';

/** Shown when the session has no active org (e.g. the user was removed from it). */
export function NoOrg({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const switchTo = async (orgId: string) => {
    try {
      setSession(
        await api<AuthTokensResponse>('/auth/switch-org', { method: 'POST', body: { orgId } }),
      );
      await queryClient.resetQueries();
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <Card className="mx-auto mt-10 max-w-md">
      <CardHeader>
        <CardTitle>
          {me.orgs.length ? 'Choose a workspace' : 'You are not in a workspace'}
        </CardTitle>
        <CardDescription>
          {me.orgs.length
            ? 'Pick a workspace to continue.'
            : 'Create a workspace, or ask a teammate to invite you to theirs.'}
        </CardDescription>
      </CardHeader>
      <CardFooter className="flex flex-col items-stretch gap-2">
        {me.orgs.map((org) => (
          <Button key={org.id} variant="outline" onClick={() => void switchTo(org.id)}>
            {org.name}
          </Button>
        ))}
        <Button onClick={() => setCreating(true)}>Create a workspace</Button>
      </CardFooter>
      <CreateOrgDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => void switchTo(id)}
      />
    </Card>
  );
}
