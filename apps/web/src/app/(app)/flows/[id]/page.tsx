'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { FlowDto, FlowIssue } from '@wacrm/shared';
import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FlowBuilder, type SaveState } from '@/components/flows/builder/flow-builder';
import { FlowRuns, FlowVersions } from '@/components/flows/flow-runs';
import { FlowState } from '@/components/flows/flow-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';
import { exportFlow, flowKeys, TRIGGER_LABELS, useFlow } from '@/lib/flows';
import { handleApiError } from '@/lib/forms';

function SaveStatus({ state }: { state: SaveState }) {
  const text =
    typeof state === 'object'
      ? state.error
      : state === 'saving'
        ? 'Saving…'
        : state === 'unsaved'
          ? 'Unsaved changes'
          : 'Draft saved';
  return (
    <span
      role="status"
      data-testid="save-status"
      className={
        typeof state === 'object' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
      }
    >
      {text}
    </span>
  );
}

/** The draft as JSON, for people who prefer it, and for pasting a flow in. */
function JsonDialog({
  flow,
  open,
  onClose,
  onSaved,
}: {
  flow: FlowDto;
  open: boolean;
  onClose: () => void;
  onSaved: (f: FlowDto) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(flow.draft, null, 2));
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    let definition: unknown;
    try {
      definition = JSON.parse(text);
    } catch {
      setError('This is not valid JSON');
      return;
    }
    try {
      onSaved(await api<FlowDto>(`/flows/${flow.id}`, { method: 'PUT', body: { definition } }));
      onClose();
    } catch (err) {
      handleApiError(err);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit as JSON</DialogTitle>
          <DialogDescription>The whole draft. Saving replaces it.</DialogDescription>
        </DialogHeader>
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
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()}>Save draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function FlowPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const flow = useFlow(id);
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [publishIssues, setPublishIssues] = useState<FlowIssue[] | null>(null);
  const [json, setJson] = useState(false);
  const [builderKey, setBuilderKey] = useState(0);
  const flush = useRef<() => Promise<boolean>>(async () => true);
  const registerFlush = useCallback((fn: () => Promise<boolean>) => {
    flush.current = fn;
  }, []);

  const refresh = (updated: FlowDto, remount = false) => {
    queryClient.setQueryData(flowKeys.one(id), updated);
    void queryClient.invalidateQueries({ queryKey: flowKeys.all });
    void queryClient.invalidateQueries({ queryKey: flowKeys.versions(id) });
    if (remount) setBuilderKey((k) => k + 1);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const publish = () =>
    run(async () => {
      if (!(await flush.current())) {
        toast.error('Fix the draft before publishing');
        return;
      }
      try {
        refresh(await api<FlowDto>(`/flows/${id}/publish`, { method: 'POST' }));
        setPublishIssues(null);
        toast.success('Published');
      } catch (err) {
        const issues =
          err instanceof ApiError ? (err.details?.issues as FlowIssue[] | undefined) : undefined;
        if (issues) setPublishIssues(issues.filter((i) => i.level === 'error'));
        throw err;
      }
    });

  const rename = (name: string) =>
    run(async () => {
      if (!name.trim() || name === flow.data?.name) return;
      refresh(await api<FlowDto>(`/flows/${id}`, { method: 'PUT', body: { name: name.trim() } }));
    });

  if (flow.isPending) {
    return <Skeleton className="h-96 w-full" />;
  }
  if (!flow.data) return <p className="text-sm text-muted-foreground">Flow not found.</p>;
  const f = flow.data;

  return (
    <div className="flex h-full min-h-[32rem] flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/flows"
            aria-label="Back to flows"
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-5" aria-hidden />
          </Link>
          <div className="flex min-w-0 flex-col">
            <h1 className="sr-only">{f.name}</h1>
            <Input
              aria-label="Flow name"
              defaultValue={f.name}
              key={f.name}
              maxLength={100}
              className="h-8 w-72 border-transparent text-lg font-semibold hover:border-input"
              onBlur={(e) => void rename(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2 px-3 text-xs text-muted-foreground">
              <FlowState flow={f} />
              <span>Starts on: {TRIGGER_LABELS[f.triggerType]}</span>
              <span>{f.activeRuns} running now</span>
              <SaveStatus state={saveState} />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void publish()} disabled={busy}>
            Publish
          </Button>
          {f.publishedVersion && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  refresh(
                    await api<FlowDto>(`/flows/${id}/active`, {
                      method: 'PATCH',
                      body: { active: !f.active },
                    }),
                  ),
                )
              }
            >
              {f.active ? 'Turn off' : 'Turn on'}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More flow actions">
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {f.publishedVersion && f.hasUnpublishedChanges && (
                <DropdownMenuItem
                  onSelect={() =>
                    void run(async () => {
                      if (!window.confirm('Discard the changes since the last publish?')) return;
                      refresh(await api<FlowDto>(`/flows/${id}/revert`, { method: 'POST' }), true);
                    })
                  }
                >
                  Discard unpublished changes
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() =>
                  void run(async () => {
                    await flush.current();
                    const copy = await api<FlowDto>(`/flows/${id}/duplicate`, { method: 'POST' });
                    await queryClient.invalidateQueries({ queryKey: flowKeys.all });
                    router.push(`/flows/${copy.id}`);
                  })
                }
              >
                Duplicate flow
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  void run(async () => {
                    await flush.current();
                    const latest = queryClient.getQueryData<FlowDto>(flowKeys.one(id)) ?? f;
                    exportFlow(latest);
                  })
                }
              >
                Export as file
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  void run(async () => {
                    await flush.current();
                    setJson(true);
                  })
                }
              >
                Edit as JSON
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onSelect={() =>
                  void run(async () => {
                    if (
                      !window.confirm(
                        'Remove this flow? Runs under way are stopped. Their history stays.',
                      )
                    ) {
                      return;
                    }
                    await api(`/flows/${id}`, { method: 'DELETE' });
                    await queryClient.invalidateQueries({ queryKey: flowKeys.all });
                    router.push('/flows');
                  })
                }
              >
                Remove flow
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {publishIssues && publishIssues.length > 0 && (
        <div role="alert" className="rounded-md border border-destructive p-2 text-sm">
          <p className="font-medium">Fix these before publishing:</p>
          <ul className="list-disc pl-5">
            {publishIssues.map((i, k) => (
              <li key={k}>
                {i.nodeId ? <code className="mr-1 text-xs">{i.nodeId}</code> : null}
                {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Tabs defaultValue="builder" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="builder">Builder</TabsTrigger>
          <TabsTrigger value="runs">
            Runs {f.activeRuns > 0 && <Badge variant="secondary">{f.activeRuns}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
        </TabsList>
        <TabsContent value="builder" className="min-h-0 flex-1" forceMount>
          <FlowBuilder
            key={builderKey}
            flow={f}
            onSaveState={setSaveState}
            registerFlush={registerFlush}
          />
        </TabsContent>
        <TabsContent value="runs" className="overflow-y-auto">
          <FlowRuns flowId={id} />
        </TabsContent>
        <TabsContent value="versions">
          <FlowVersions flowId={id} />
        </TabsContent>
      </Tabs>

      {json && (
        <JsonDialog
          flow={queryClient.getQueryData<FlowDto>(flowKeys.one(id)) ?? f}
          open={json}
          onClose={() => setJson(false)}
          onSaved={(updated) => refresh(updated, true)}
        />
      )}
    </div>
  );
}
