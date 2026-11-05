'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuditLogs } from '@/lib/queries';

const LABELS: Record<string, string> = {
  'whatsapp.connected': 'Connected a WhatsApp number',
  'whatsapp.disconnected': 'Disconnected a WhatsApp number',
  'whatsapp.registered': 'Registered a WhatsApp number',
  'whatsapp.webhook_replayed': 'Replayed a webhook event',
  'auth.signup': 'Created the workspace',
  'auth.login': 'Logged in',
  'auth.login_mfa': 'Logged in with 2FA',
  'auth.password_reset': 'Reset their password',
  'auth.refresh_reuse_detected': 'Session revoked: token reuse detected',
  'auth.2fa_enabled': 'Turned on 2FA',
  'auth.2fa_disabled': 'Turned off 2FA',
  'auth.email_verified': 'Verified their email',
  'org.created': 'Created the workspace',
  'org.updated': 'Updated workspace settings',
  'team.invite_created': 'Invited a teammate',
  'team.invite_revoked': 'Revoked an invitation',
  'team.invite_accepted': 'Joined via invitation',
  'team.role_changed': 'Changed a role',
  'team.member_removed': 'Removed a member',
};

function describe(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object') return '';
  const m = metadata as Record<string, unknown>;
  if (m.from && m.to) return `${String(m.from)} → ${String(m.to)}`;
  if (m.email) return `${String(m.email)}${m.role ? ` as ${String(m.role)}` : ''}`;
  if (m.role) return String(m.role);
  if (m.name || m.timezone)
    return Object.entries(m)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');
  return '';
}

export default function AuditLogPage() {
  const logs = useAuditLogs();
  const items = logs.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
        <CardDescription>Sensitive actions in this workspace, newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        {logs.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {new Date(log.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>{log.actorName ?? 'System'}</TableCell>
                    <TableCell>
                      <div>{LABELS[log.action] ?? log.action}</div>
                      <div className="text-xs text-muted-foreground">{describe(log.metadata)}</div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{log.ip ?? ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {logs.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="outline"
                  disabled={logs.isFetchingNextPage}
                  onClick={() => void logs.fetchNextPage()}
                >
                  {logs.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
