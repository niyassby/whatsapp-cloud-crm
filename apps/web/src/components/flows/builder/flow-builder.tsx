'use client';

import '@xyflow/react/dist/style.css';
import { useQueryClient } from '@tanstack/react-query';
import {
  addNode,
  connect,
  duplicateNode,
  FLOW_NODE_GROUPS,
  FLOW_NODE_META,
  FLOW_NODE_TYPES,
  type FlowDefinition,
  flowDefinitionSchema,
  type FlowDto,
  type FlowIssue,
  flowIssues,
  type FlowNode,
  type FlowNodeType,
  handleLabel,
  moveNode,
  newNode,
  nodeHandles,
  removeNode,
  updateNode,
  variableOptions,
} from '@wacrm/shared';
import {
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  MarkerType,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { FlaskConical, Plus } from 'lucide-react';
import { useTheme } from 'next-themes';
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { useContactFields, useTags } from '@/lib/contacts';
import { flowKeys } from '@/lib/flows';
import { usePhoneNumbers, useMembers } from '@/lib/queries';
import { useTemplates } from '@/lib/templates';
import { cn } from '@/lib/utils';
import { type BuilderData, StepPanel, TriggerPanel } from './node-form';
import { SimulatorPanel } from './simulator-panel';
import { StepNode, TriggerNode } from './step-node';

const TRIGGER_ID = '__trigger';
const nodeTypes = { step: StepNode, trigger: TriggerNode };
const DRAG_TYPE = 'application/x-wacrm-step';

export type SaveState = 'saved' | 'saving' | 'unsaved' | { error: string };

function useBuilderData(): BuilderData {
  const templates = useTemplates('approved', '');
  const tags = useTags();
  const members = useMembers();
  const fields = useContactFields();
  const phones = usePhoneNumbers();
  return {
    templates: templates.data?.pages.flatMap((p) => p.items) ?? [],
    tags: tags.data ?? [],
    members: members.data ?? [],
    fields: fields.data ?? [],
    phones: phones.data ?? [],
  };
}

/** Where a new step goes: under the selected step, else under the lowest one. */
/**
 * Where a new step goes: under the selected step, else under the lowest one, moved right past any
 * step already there, so two steps added under one parent sit side by side instead of stacked.
 */
function placeFor(def: FlowDefinition, selected: string | null) {
  const anchor = def.nodes.find((n) => n.id === selected);
  const lowest = def.nodes.reduce<FlowNode | null>(
    (a, b) => (!a || b.position.y > a.position.y ? b : a),
    null,
  );
  const base = anchor ?? lowest;
  const spot = base ? { x: base.position.x, y: base.position.y + 200 } : { x: 0, y: 140 };
  const taken = (x: number, y: number) =>
    def.nodes.some((n) => Math.abs(n.position.x - x) < 280 && Math.abs(n.position.y - y) < 150);
  while (taken(spot.x, spot.y)) spot.x += 300;
  return spot;
}

function Canvas({
  def,
  setDef,
  issues,
  selected,
  setSelected,
  path,
}: {
  def: FlowDefinition;
  setDef: (fn: (d: FlowDefinition) => FlowDefinition) => void;
  issues: FlowIssue[];
  selected: string | null;
  setSelected: (id: string | null) => void;
  path: { visited: string[]; current: string | null };
}) {
  const { resolvedTheme } = useTheme();
  const flow = useReactFlow();
  const derived = useMemo<Node[]>(() => {
    const start = def.nodes.find((n) => n.id === def.startNodeId);
    const triggerPos = start ? { x: start.position.x, y: start.position.y - 140 } : { x: 0, y: 0 };
    const byNode = new Map<string, string[]>();
    for (const i of issues) {
      if (i.level !== 'error') continue;
      const key = i.nodeId ?? TRIGGER_ID;
      byNode.set(key, [...(byNode.get(key) ?? []), i.message]);
    }
    const visited = new Set(path.visited);
    return [
      {
        id: TRIGGER_ID,
        type: 'trigger',
        position: triggerPos,
        data: { trigger: def.trigger, errors: byNode.get(TRIGGER_ID) ?? [] },
        selected: selected === TRIGGER_ID,
        deletable: false,
        draggable: false,
      },
      ...def.nodes.map((n) => ({
        id: n.id,
        type: 'step',
        position: n.position,
        data: {
          step: n,
          isStart: n.id === def.startNodeId,
          errors: byNode.get(n.id) ?? [],
          visited: visited.has(n.id),
          current: path.current === n.id,
        },
        selected: selected === n.id,
      })),
    ];
  }, [def, issues, selected, path]);

  // A step added or removed: frame the whole flow again, so a new step is never out of view.
  const count = def.nodes.length;
  useEffect(() => {
    const t = requestAnimationFrame(
      () => void flow.fitView({ maxZoom: 1, padding: 0.15, duration: 200 }),
    );
    return () => cancelAnimationFrame(t);
  }, [count, flow]);

  // Local copy so dragging is smooth; positions are written back when a drag ends.
  const [nodes, setNodes] = useState<Node[]>(derived);
  useEffect(() => setNodes(derived), [derived]);

  const edges = useMemo<Edge[]>(() => {
    const list: Edge[] = def.edges.map((e) => {
      const source = def.nodes.find((n) => n.id === e.source);
      return {
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        label: source ? handleLabel(source, e.sourceHandle) : e.sourceHandle,
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: path.visited.includes(e.source) && path.visited.includes(e.target),
      };
    });
    if (def.startNodeId) {
      list.push({
        id: 'trigger-start',
        source: TRIGGER_ID,
        sourceHandle: 'start',
        target: def.startNodeId,
        markerEnd: { type: MarkerType.ArrowClosed },
        deletable: false,
      });
    }
    return list;
  }, [def, path]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.target === TRIGGER_ID) return;
      if (c.source === TRIGGER_ID) {
        setDef((d) => ({ ...d, startNodeId: c.target }));
        return;
      }
      setDef((d) => connect(d, c.source!, c.sourceHandle ?? 'next', c.target));
    },
    [setDef],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const ch of changes) {
        if (ch.type !== 'remove') continue;
        setDef((d) => {
          const edge = d.edges.find((e) => e.id === ch.id);
          return edge ? connect(d, edge.source, edge.sourceHandle, null) : d;
        });
      }
    },
    [setDef],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData(DRAG_TYPE) as FlowNodeType;
    if (!FLOW_NODE_TYPES.includes(type)) return;
    const position = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setDef((d) => {
      const node = newNode(d, type, position);
      setSelected(node.id);
      return addNode(d, node);
    });
  };

  return (
    <div className="h-full w-full" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
        onNodesChange={(changes) =>
          setNodes((ns) => {
            for (const ch of changes) {
              if (ch.type === 'remove' && ch.id !== TRIGGER_ID) {
                setDef((d) => removeNode(d, ch.id));
                setSelected(null);
              }
            }
            return ns.map((n) => {
              const moved = changes.find((c) => c.type === 'position' && c.id === n.id);
              return moved && moved.type === 'position' && moved.position
                ? { ...n, position: moved.position }
                : n;
            });
          })
        }
        onNodeDragStop={(_, node) => {
          if (node.id !== TRIGGER_ID) setDef((d) => moveNode(d, node.id, node.position));
        }}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => setSelected(node.id)}
        onPaneClick={() => setSelected(null)}
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        deleteKeyCode={['Delete', 'Backspace']}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

/** On narrower screens the step list is a menu on the canvas, so the canvas keeps its room. */
function AddStepMenu({ onAdd }: { onAdd: (type: FlowNodeType) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="absolute top-2 left-2 z-10 xl:hidden">
          <Plus className="size-4" aria-hidden /> Add step
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 overflow-y-auto">
        {FLOW_NODE_GROUPS.map((g) => (
          <div key={g.id}>
            <DropdownMenuLabel>{g.label}</DropdownMenuLabel>
            {FLOW_NODE_TYPES.filter((t) => FLOW_NODE_META[t].group === g.id).map((t) => (
              <DropdownMenuItem key={t} onSelect={() => onAdd(t)}>
                {FLOW_NODE_META[t].label}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Palette({ onAdd }: { onAdd: (type: FlowNodeType) => void }) {
  return (
    <nav aria-label="Add a step" className="hidden flex-col gap-3 overflow-y-auto xl:flex">
      {FLOW_NODE_GROUPS.map((g) => (
        <div key={g.id} className="flex flex-col gap-1">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {g.label}
          </h3>
          {FLOW_NODE_TYPES.filter((t) => FLOW_NODE_META[t].group === g.id).map((t) => (
            <button
              key={t}
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, t);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => onAdd(t)}
              className="rounded-md border bg-card px-2 py-1.5 text-left text-sm hover:bg-accent"
              title={FLOW_NODE_META[t].description}
              aria-label={`Add ${FLOW_NODE_META[t].label}`}
            >
              {FLOW_NODE_META[t].label}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

/**
 * The visual editor. Keeps its own copy of the draft and saves it a moment after each change;
 * the draft may have problems, which show on the steps. Publishing is what checks it fully.
 */
function Builder({
  flow,
  onSaveState,
  registerFlush,
}: {
  flow: FlowDto;
  onSaveState: (s: SaveState) => void;
  registerFlush: (fn: () => Promise<boolean>) => void;
}) {
  const queryClient = useQueryClient();
  const data = useBuilderData();
  const [def, setDefState] = useState<FlowDefinition>(flow.draft);
  const [selected, setSelected] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [path, setPath] = useState<{ visited: string[]; current: string | null }>({
    visited: [],
    current: null,
  });
  const dirty = useRef(false);
  const latest = useRef(def);
  latest.current = def;

  // Replaced from outside (revert, JSON edit, import): take the new draft.
  const lastDraft = useRef(flow.draft);
  useEffect(() => {
    if (flow.draft !== lastDraft.current && !dirty.current) setDefState(flow.draft);
    lastDraft.current = flow.draft;
  }, [flow.draft]);

  const setDef = useCallback((fn: (d: FlowDefinition) => FlowDefinition) => {
    setDefState((d) => {
      const next = fn(d);
      if (next !== d) dirty.current = true;
      return next;
    });
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirty.current) return true;
    const parsed = flowDefinitionSchema.safeParse(latest.current);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      onSaveState({ error: `Not saved: ${first?.path.join('.')} ${first?.message}` });
      return false;
    }
    const sent = latest.current;
    onSaveState('saving');
    try {
      const updated = await api<FlowDto>(`/flows/${flow.id}`, {
        method: 'PUT',
        body: { definition: parsed.data },
      });
      if (latest.current === sent) dirty.current = false;
      lastDraft.current = updated.draft;
      queryClient.setQueryData(flowKeys.one(flow.id), updated);
      onSaveState(dirty.current ? 'unsaved' : 'saved');
      return !dirty.current;
    } catch (err) {
      onSaveState({ error: err instanceof Error ? err.message : 'Could not save' });
      return false;
    }
  }, [flow.id, onSaveState, queryClient]);

  useEffect(() => registerFlush(save), [registerFlush, save]);

  useEffect(() => {
    if (!dirty.current) return;
    onSaveState('unsaved');
    const t = setTimeout(() => void save(), 800);
    return () => clearTimeout(t);
  }, [def, save, onSaveState]);

  const issues = useMemo(() => flowIssues(def), [def]);
  const variables = useMemo(
    () =>
      variableOptions(
        def,
        data.fields.map((f) => f.key),
      ),
    [def, data.fields],
  );
  const node = def.nodes.find((n) => n.id === selected);

  const add = (type: FlowNodeType) =>
    setDef((d) => {
      const n = newNode(d, type, placeFor(d, selected));
      let next = addNode(d, n);
      // Joined to the selected step's first free exit, so building top to bottom needs no wiring.
      const from = d.nodes.find((x) => x.id === selected);
      if (from) {
        const free = flowHandlesFree(next, from);
        if (free) next = connect(next, from.id, free, n.id);
      }
      setSelected(n.id);
      return next;
    });

  return (
    <div className="grid h-full grid-cols-[1fr_20rem] gap-3 xl:grid-cols-[11rem_1fr_22rem]">
      <Palette onAdd={add} />
      <div className="relative min-h-0 rounded-lg border">
        <AddStepMenu onAdd={add} />
        <Canvas
          def={def}
          setDef={setDef}
          issues={issues}
          selected={selected}
          setSelected={setSelected}
          path={path}
        />
        <Button
          size="sm"
          variant={testing ? 'default' : 'outline'}
          className="absolute top-2 right-2 z-10"
          onClick={() => setTesting((v) => !v)}
        >
          <FlaskConical className="size-4" aria-hidden /> {testing ? 'Close test' : 'Test'}
        </Button>
      </div>
      <aside className={cn('min-h-0 overflow-y-auto rounded-lg border p-3')}>
        {testing ? (
          <SimulatorPanel def={def} data={data} onPath={setPath} />
        ) : selected === TRIGGER_ID ? (
          <TriggerPanel
            def={def}
            issues={issues}
            data={data}
            onTrigger={(trigger) => setDef((d) => ({ ...d, trigger }))}
            onSettings={(settings) => setDef((d) => ({ ...d, settings }))}
          />
        ) : node ? (
          <StepPanel
            key={node.id}
            node={node}
            def={def}
            issues={issues}
            data={data}
            variables={variables}
            onChange={(n: FlowNode) => setDef((d) => updateNode(d, n))}
            onConnect={(handle, target) => setDef((d) => connect(d, node.id, handle, target))}
            onMakeStart={() => setDef((d) => ({ ...d, startNodeId: node.id }))}
            onDuplicate={() => setDef((d) => duplicateNode(d, node.id))}
            onDelete={() => {
              setDef((d) => removeNode(d, node.id));
              setSelected(null);
            }}
          />
        ) : (
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>Add steps from the left, then click a step to set it up.</p>
            <p>Click the trigger at the top to choose what starts the flow.</p>
            <p>
              Join steps by dragging from an exit to another step, or pick “Then” in a step’s
              settings.
            </p>
            {issues.filter((i) => i.level === 'error').length > 0 && (
              <p className="text-destructive">
                {issues.filter((i) => i.level === 'error').length} problems to fix before
                publishing.
              </p>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

/** The first exit of a step with nothing connected, or null. */
function flowHandlesFree(def: FlowDefinition, node: FlowNode): string | null {
  const used = new Set(def.edges.filter((e) => e.source === node.id).map((e) => e.sourceHandle));
  const handles = nodeHandles(node);
  return (
    handles.find((h) => !used.has(h) && h !== 'timeout' && h !== 'invalid' && h !== 'failure') ??
    null
  );
}

export function FlowBuilder(props: {
  flow: FlowDto;
  onSaveState: (s: SaveState) => void;
  registerFlush: (fn: () => Promise<boolean>) => void;
}) {
  return (
    <ReactFlowProvider>
      <Builder {...props} />
    </ReactFlowProvider>
  );
}
