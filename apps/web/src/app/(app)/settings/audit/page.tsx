'use client';

import { AUDIT_GROUPS, auditDetail, auditLabel } from '@wacrm/shared';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiDownload } from '@/lib/api';
import { useAuditLogs, useMembers } from '@/lib/queries';

const selectClass =
  'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export default function AuditLogPage() {
  const [action, setAction] = useState('');
  const [actorUserId, setActorUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filters = { action, actorUserId, from, to };
  const logs = useAuditLogs(filters);
  const members = useMembers();
  const items = logs.data?.pages.flatMap((p) => p.items) ?? [];
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams(
        Object.entries(filters).filter((e): e is [string, string] => Boolean(e[1])),
      );
      await apiDownload(`/orgs/current/audit-logs/export?${params}`, 'audit-log.csv');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not export');
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
        <CardDescription>
          Sensitive actions in this workspace, newest first. Dates are in UTC.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-action">Kind</Label>
            <select
              id="audit-action"
              className={selectClass}
              value={action}
              onChange={(e) => setAction(e.target.value)}
            >
              <option value="">Everything</option>
              {Object.entries(AUDIT_GROUPS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-person">Person</Label>
            <select
              id="audit-person"
              className={selectClass}
              value={actorUserId}
              onChange={(e) => setActorUserId(e.target.value)}
            >
              <option value="">Anyone</option>
              {(members.data ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-from">From</Label>
            <Input
              id="audit-from"
              type="date"
              className="h-9 w-40"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="audit-to">To</Label>
            <Input
              id="audit-to"
              type="date"
              className="h-9 w-40"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            className="ml-auto"
            disabled={exporting}
            onClick={() => void exportCsv()}
          >
            <Download className="size-4" /> Export CSV
          </Button>
        </div>

        {logs.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing matches these filters.</p>
        ) : (
          <>
            <Table data-testid="audit-table">
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
                    <TableCell>
                      {log.actorName ?? (log.impersonated ? 'Outside admin' : 'System')}{' '}
                      {log.impersonated && (
                        <Badge
                          variant="outline"
                          title="Done by your partner or the platform, not a member"
                        >
                          Not a member
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div>{auditLabel(log.action)}</div>
                      <div className="text-xs text-muted-foreground">
                        {auditDetail(log.metadata)}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{log.ip ?? ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {logs.hasNextPage && (
              <div className="flex justify-center">
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
