'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { FlowDto, FlowIssue, FlowRunDto } from '@wacrm/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FlowState } from '@/components/flows/flow-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';
import {
  flowKeys,
  RUN_STATUS_LABELS,
  TRIGGER_LABELS,
  useFlow,
  useFlowRun,
  useFlowRuns,
  useFlowVersions,
} from '@/lib/flows';
import { handleApiError } from '@/lib/forms';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function Issues({ issues }: { issues: FlowIssue[] }) {
  if (issues.length === 0) {
    return <p className="text-sm text-muted-foreground">No problems found.</p>;
  }
  return (
    <ul className="flex flex-col gap-1 text-sm" aria-label="Problems">
      {issues.map((issue, i) => (
        <li key={i} className="flex gap-2">
          <Badge variant={issue.level === 'error' ? 'destructive' : 'secondary'}>
            {issue.level === 'error' ? 'Error' : 'Warning'}
          </Badge>
          <span>
            {issue.nodeId ? <code className="mr-1 text-xs">{issue.nodeId}</code> : null}
            {issue.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The draft as JSON. The visual builder replaces this in phase 3.3. */
function DraftEditor({ flow }: { flow: FlowDto }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => JSON.stringify(flow.draft, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setText(JSON.stringify(flow.draft, null, 2));
  }, [flow.draft]);

  const save = async () => {
    let definition: unknown;
    try {
      definition = JSON.parse(text);
      setParseError(null);
    } catch {
      setParseError('This is not valid JSON');
      return;
    }
    setBusy(true);
    try {
      const updated = await api<FlowDto>(`/flows/${flow.id}`, {
        method: 'PUT',
        body: { definition },
      });
      queryClient.setQueryData(flowKeys.one(flow.id), updated);
      void queryClient.invalidateQueries({ queryKey: flowKeys.all });
      toast.success('Draft saved');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="flow-definition" className="text-sm font-medium">
        Definition
      </label>
      <textarea
        id="flow-definition"
        className="min-h-96 w-full rounded-md border bg-transparent p-3 font-mono text-xs"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {parseError && <p className="text-sm text-destructive">{parseError}</p>}
      <div>
        <Button onClick={() => void save()} disabled={busy}>
          Save draft
        </Button>
      </div>
    </div>
  );
}

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

function Runs({ flowId }: { flowId: string }) {
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

function Versions({ flowId }: { flowId: string }) {
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

export default function FlowPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const flow = useFlow(id);
  const [busy, setBusy] = useState(false);
  const [publishIssues, setPublishIssues] = useState<FlowIssue[] | null>(null);

  const refresh = (updated: FlowDto) => {
    queryClient.setQueryData(flowKeys.one(id), updated);
    void queryClient.invalidateQueries({ queryKey: flowKeys.all });
    void queryClient.invalidateQueries({ queryKey: flowKeys.versions(id) });
  };

  const publish = async () => {
    setBusy(true);
    try {
      refresh(await api<FlowDto>(`/flows/${id}/publish`, { method: 'POST' }));
      setPublishIssues(null);
      toast.success('Published');
    } catch (err) {
      const issues =
        err instanceof ApiError ? (err.details?.issues as FlowIssue[] | undefined) : undefined;
      if (issues) setPublishIssues(issues);
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (active: boolean) => {
    setBusy(true);
    try {
      refresh(await api<FlowDto>(`/flows/${id}/active`, { method: 'PATCH', body: { active } }));
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Remove this flow? Runs under way are stopped. Their history stays.'))
      return;
    try {
      await api(`/flows/${id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: flowKeys.all });
      router.push('/flows');
    } catch (err) {
      handleApiError(err);
    }
  };

  if (flow.isPending) {
    return (
      <div className="p-6">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!flow.data) return <p className="p-6 text-sm text-muted-foreground">Flow not found.</p>;
  const f = flow.data;
  const errors = f.issues.some((i) => i.level === 'error');

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-col gap-3">
        <Link
          href="/flows"
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden /> Flows
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold">{f.name}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <FlowState flow={f} />
              <span>Starts on: {TRIGGER_LABELS[f.triggerType]}</span>
              <span>{f.activeRuns} running now</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void publish()}
              disabled={busy || errors || !f.hasUnpublishedChanges}
            >
              Publish
            </Button>
            {f.publishedVersion && (
              <Button variant="outline" onClick={() => void toggle(!f.active)} disabled={busy}>
                {f.active ? 'Turn off' : 'Turn on'}
              </Button>
            )}
            <Button variant="ghost" onClick={() => void remove()}>
              Remove
            </Button>
          </div>
        </div>
      </div>

      <Tabs defaultValue="steps">
        <TabsList>
          <TabsTrigger value="steps">Steps</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
        </TabsList>
        <TabsContent value="steps" className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Problems</CardTitle>
              <CardDescription>Errors stop publishing. Warnings do not.</CardDescription>
            </CardHeader>
            <CardContent>
              <Issues issues={publishIssues ?? f.issues} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <DraftEditor flow={f} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="runs">
          <Card>
            <CardContent className="pt-6">
              <Runs flowId={id} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="versions">
          <Card>
            <CardContent className="pt-6">
              <Versions flowId={id} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
