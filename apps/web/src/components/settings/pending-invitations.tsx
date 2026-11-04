'use client';

import { useQueryClient } from '@tanstack/react-query';
import { canManageRole, type InvitationDto, type Role } from '@wacrm/shared';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { queryKeys, useInvitations } from '@/lib/queries';

export function PendingInvitations({ myRole }: { myRole: Role }) {
  const queryClient = useQueryClient();
  const invitations = useInvitations(true);

  const revoke = async (inv: InvitationDto) => {
    try {
      await api(`/team/invitations/${inv.id}`, { method: 'DELETE' });
      toast.success(`Invitation for ${inv.email} revoked`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.invitations });
    } catch (err) {
      handleApiError(err);
    }
  };

  if (!invitations.data?.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending invitations</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="w-24">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitations.data.map((inv) => (
              <TableRow key={inv.id}>
                <TableCell>{inv.email}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {inv.role}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(inv.expiresAt).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  {canManageRole(myRole, inv.role) && (
                    <Button variant="ghost" size="sm" onClick={() => void revoke(inv)}>
                      Revoke
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
