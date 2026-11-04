'use client';

import { useQueryClient } from '@tanstack/react-query';
import { canManageRole, type MemberDto, Permission, type Role, ROLES } from '@wacrm/shared';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { InviteDialog } from '@/components/settings/invite-dialog';
import { PendingInvitations } from '@/components/settings/pending-invitations';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { queryKeys, useCan, useMe, useMembers } from '@/lib/queries';

export default function TeamPage() {
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const members = useMembers();
  const canInvite = useCan(Permission.TEAM_INVITE);
  const canChangeRole = useCan(Permission.TEAM_UPDATE_ROLE);
  const canRemove = useCan(Permission.TEAM_REMOVE);
  const myRole = me?.currentOrg?.role;

  const changeRole = async (member: MemberDto, role: Role) => {
    try {
      await api(`/team/members/${member.id}`, { method: 'PATCH', body: { role } });
      toast.success(`${member.name} is now ${role === 'admin' ? 'an' : 'a'} ${role}`);
    } catch (err) {
      handleApiError(err);
    } finally {
      await queryClient.invalidateQueries({ queryKey: queryKeys.members });
    }
  };

  const remove = async (member: MemberDto) => {
    if (!window.confirm(`Remove ${member.name} from this workspace? They lose access immediately.`))
      return;
    try {
      await api(`/team/members/${member.id}`, { method: 'DELETE' });
      toast.success(`${member.name} was removed`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.members });
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <CardTitle>Members</CardTitle>
            <CardDescription>
              Owners manage everything, admins manage the team and settings, agents work the inbox.
            </CardDescription>
          </div>
          {canInvite && myRole && <InviteDialog myRole={myRole} />}
        </CardHeader>
        <CardContent>
          {members.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.data?.map((m) => {
                  const isMe = m.userId === me?.user.id;
                  const manageable = !isMe && myRole !== undefined && canManageRole(myRole, m.role);
                  return (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div className="font-medium">
                          {m.name} {isMe && <span className="text-muted-foreground">(you)</span>}
                        </div>
                        <div className="text-sm text-muted-foreground">{m.email}</div>
                      </TableCell>
                      <TableCell>
                        {canChangeRole && manageable ? (
                          <Select
                            value={m.role}
                            onValueChange={(r) => void changeRole(m, r as Role)}
                          >
                            <SelectTrigger className="w-32" aria-label={`Role for ${m.name}`}>
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
                        ) : (
                          <Badge
                            variant={m.role === 'owner' ? 'default' : 'secondary'}
                            className="capitalize"
                          >
                            {m.role}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {canRemove && manageable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${m.name}`}
                            onClick={() => void remove(m)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {canInvite && myRole && <PendingInvitations myRole={myRole} />}
    </div>
  );
}
