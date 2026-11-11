'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { FlowRunDto } from '@wacrm/shared';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { flowKeys, RUN_STATUS_LABELS, useFlowRun, useFlowRuns, useFlowVersions } from '@/lib/flows';
import { handleApiError } from '@/lib/forms';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function RunDetail({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const run = useFlowRun(runId);
  const cancel = async () => {
    if (!runId) return;
    try {
      await api(`/flows/runs/${runId}/cancel`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: flowKeys.run(runId) });
    } catch (err) {
      handleApiError(err);
    }
  };
  const data = run.data;
  return (
    <Dialog open={Boolean(runId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run</DialogTitle>
          <DialogDescription>
            {data
              ? `${data.contact.name ?? `+${data.contact.waId}`} · version ${data.version} · ${RUN_STATUS_LABELS[data.status]}`
              : 'Loading'}
          </DialogDescription>
        </DialogHeader>
        {!data ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            {data.error && <p className="text-destructive">{data.error}</p>}
            {data.waitingUntil && <p>Waiting until {when(data.waitingUntil)}</p>}
            <div>
              <h3 className="mb-1 font-medium">Variables</h3>
              <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
                {JSON.stringify(data.variables, null, 2)}
              </pre>
            </div>
            <div>
              <h3 className="mb-1 font-medium">Steps</h3>
              <ol className="flex flex-col gap-1" aria-label="Run history">
                {data.history.map((step) => (
                  <li key={step.id} className="flex flex-wrap items-baseline gap-2">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {new Date(step.createdAt).toLocaleTimeString()}
                    </span>
                    <code className="text-xs">{step.nodeId || '—'}</code>
                    <span className="text-muted-foreground">{step.nodeType}</span>
                    <Badge variant="outline">{step.outcome}</Badge>
                    {step.detail && (
                      <span className="w-full truncate text-xs text-muted-foreground">
                        {JSON.stringify(step.detail)}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
            {(data.status === 'running' || data.status === 'waiting') && (
              <div>
                <Button variant="outline" onClick={() => void cancel()}>
                  Stop this run
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function FlowRuns({ flowId }: { flowId: string }) {
  const runs = useFlowRuns(flowId);
  const [open, setOpen] = useState<string | null>(null);
  const items: FlowRunDto[] = runs.data?.pages.flatMap((p) => p.items) ?? [];
  if (runs.isPending) return <Skeleton className="h-24 w-full" />;
  if (items.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No runs yet.</p>;
  }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Contact</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Step</TableHead>
            <TableHead>Started</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((run) => (
            <TableRow key={run.id}>
              <TableCell>
                <button
                  type="button"
                  className="text-left font-medium hover:underline"
                  onClick={() => setOpen(run.id)}
                >
                  {run.contact.name ?? `+${run.contact.waId}`}
                </button>
              </TableCell>
              <TableCell>
                {RUN_STATUS_LABELS[run.status]}
                {run.endReason ? (
                  <span className="text-muted-foreground"> · {run.endReason}</span>
                ) : null}
              </TableCell>
              <TableCell>
                <code className="text-xs">{run.currentNodeId ?? '—'}</code>
              </TableCell>
              <TableCell>{when(run.startedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {runs.hasNextPage && (
        <Button
          variant="ghost"
          onClick={() => void runs.fetchNextPage()}
          disabled={runs.isFetchingNextPage}
        >
          Show older runs
        </Button>
      )}
      <RunDetail runId={open} onClose={() => setOpen(null)} />
    </>
  );
}

export function FlowVersions({ flowId }: { flowId: string }) {
  const versions = useFlowVersions(flowId);
  if (versions.isPending) return <Skeleton className="h-16 w-full" />;
  if (!versions.data?.length) {
    return <p className="text-sm text-muted-foreground">Not published yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {versions.data.map((v) => (
        <li key={v.id}>
          Version {v.version}, {when(v.publishedAt)}
          {v.publishedByName ? ` by ${v.publishedByName}` : ''}
        </li>
      ))}
    </ul>
  );
}
