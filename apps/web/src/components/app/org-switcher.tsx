'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { AuthTokensResponse, MeResponse } from '@wacrm/shared';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api, setSession } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { CreateOrgDialog } from './create-org-dialog';

export function OrgSwitcher({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const switchTo = async (orgId: string) => {
    if (orgId === me.currentOrg?.id) return;
    try {
      setSession(
        await api<AuthTokensResponse>('/auth/switch-org', { method: 'POST', body: { orgId } }),
      );
      // Everything cached belongs to the previous org.
      await queryClient.resetQueries();
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="max-w-64 justify-between gap-2 px-2"
            aria-label="Switch workspace"
          >
            <span className="truncate font-medium">{me.currentOrg?.name ?? 'No workspace'}</span>
            <ChevronsUpDown className="size-4 opacity-50" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Workspaces
          </DropdownMenuLabel>
          {me.orgs.map((org) => (
            <DropdownMenuItem key={org.id} onSelect={() => void switchTo(org.id)}>
              <span className="truncate">{org.name}</span>
              <span className="ml-auto text-xs capitalize text-muted-foreground">{org.role}</span>
              {org.id === me.currentOrg?.id && <Check className="size-4" aria-label="Current" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden /> New workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateOrgDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => void switchTo(id)}
      />
    </>
  );
}
