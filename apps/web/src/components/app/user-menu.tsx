'use client';

import { useQueryClient } from '@tanstack/react-query';
import { type MeResponse, Permission } from '@wacrm/shared';
import { Building2, Handshake, LogOut, Settings, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { handleApiError } from '@/lib/forms';
import { queryKeys, useCan, useMembers } from '@/lib/queries';

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || '?';

export function UserMenu({ me }: { me: MeResponse }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const canReply = useCan(Permission.INBOX_REPLY);
  const members = useMembers(Boolean(me.currentOrg) && canReply);
  const mine = members.data?.find((m) => m.userId === me.user.id);

  const setAvailable = async (available: boolean) => {
    try {
      await api('/automation/me/availability', { method: 'PATCH', body: { available } });
      await queryClient.invalidateQueries({ queryKey: queryKeys.members });
    } catch (err) {
      handleApiError(err);
    }
  };

  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST', auth: false });
    } finally {
      useAuthStore.getState().setAccessToken(null);
      queryClient.clear();
      router.replace('/login');
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account menu">
          <Avatar className="size-8">
            <AvatarFallback>{initials(me.user.name)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="truncate">{me.user.name}</div>
          <div className="truncate text-xs font-normal text-muted-foreground">{me.user.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {mine && (
          <>
            <DropdownMenuCheckboxItem
              checked={mine.available}
              onCheckedChange={(v) => void setAvailable(Boolean(v))}
            >
              Available for new conversations
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
          </>
        )}
        {!me.impersonation && me.partner && (
          <DropdownMenuItem asChild>
            <Link href="/partner">
              <Handshake className="size-4" aria-hidden /> Partner console
            </Link>
          </DropdownMenuItem>
        )}
        {!me.impersonation && me.platformAdmin && (
          <DropdownMenuItem asChild>
            <Link href="/admin">
              <Building2 className="size-4" aria-hidden /> Platform admin
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href="/settings/security">
            <ShieldCheck className="size-4" aria-hidden /> Security
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings className="size-4" aria-hidden /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut className="size-4" aria-hidden /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
