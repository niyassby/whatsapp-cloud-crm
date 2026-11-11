'use client';

import {
  FLOW_NODE_META,
  FLOW_TRIGGER_TYPES,
  type FlowNode,
  type FlowTrigger,
  handleLabel,
  nodeHandles,
  nodeSummary,
} from '@wacrm/shared';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { CircleAlert, Zap } from 'lucide-react';
import { memo } from 'react';
import { TRIGGER_LABELS } from '@/lib/flows';
import { cn } from '@/lib/utils';

export interface StepNodeData extends Record<string, unknown> {
  step: FlowNode;
  isStart: boolean;
  errors: string[];
  /** The simulator went through this step. */
  visited: boolean;
  /** The simulator is waiting here. */
  current: boolean;
}

export interface TriggerNodeData extends Record<string, unknown> {
  trigger: FlowTrigger;
  errors: string[];
}

/** A step on the canvas: what it is, what it says, and one labelled exit per outcome. */
export const StepNode = memo(function StepNode({ data, selected }: NodeProps) {
  const { step, isStart, errors, visited, current } = data as StepNodeData;
  const meta = FLOW_NODE_META[step.type];
  const handles = nodeHandles(step);
  return (
    <div
      data-testid={`step-${step.id}`}
      className={cn(
        'w-64 rounded-lg border bg-card text-card-foreground shadow-sm',
        selected && 'ring-2 ring-primary',
        visited && !current && 'border-primary/60',
        current && 'ring-2 ring-amber-500',
        errors.length > 0 && 'border-destructive',
      )}
    >
      <Handle type="target" position={Position.Top} className="!size-3" />
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">{meta.label}</span>
        <span className="flex items-center gap-1">
          {isStart && (
            <span className="rounded bg-primary/10 px-1.5 text-xs text-primary">First step</span>
          )}
          {errors.length > 0 && (
            <span title={errors.join('\n')} aria-label={`${errors.length} problems`}>
              <CircleAlert className="size-4 text-destructive" aria-hidden />
            </span>
          )}
        </span>
      </div>
      <p className="line-clamp-3 px-3 py-2 text-xs text-muted-foreground">{nodeSummary(step)}</p>
      <code className="block px-3 pb-1 text-[10px] text-muted-foreground">{step.id}</code>
      {handles.length > 0 && (
        <div className="flex border-t">
          {handles.map((h) => (
            <div key={h} className="relative flex-1 px-1 pt-1 pb-3 text-center">
              <span className="block truncate text-[10px] text-muted-foreground">
                {handleLabel(step, h)}
              </span>
              <Handle
                id={h}
                type="source"
                position={Position.Bottom}
                className="!size-3 !bg-primary"
                style={{ left: '50%' }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

/** The trigger, above the first step. Its one exit leads to where the flow starts. */
export const TriggerNode = memo(function TriggerNode({ data, selected }: NodeProps) {
  const { trigger, errors } = data as TriggerNodeData;
  let detail = '';
  if (trigger.type === 'keyword') {
    detail =
      trigger.matchType === 'regex' ? (trigger.pattern ?? '') : trigger.keywords.join(', ') || '—';
  }
  return (
    <div
      data-testid="step-trigger"
      className={cn(
        'w-64 rounded-lg border-2 border-dashed bg-card px-3 py-2 shadow-sm',
        selected && 'ring-2 ring-primary',
        errors.length > 0 && 'border-destructive',
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Zap className="size-4 text-amber-500" aria-hidden /> Starts when
      </div>
      <p className="text-xs text-muted-foreground">
        {FLOW_TRIGGER_TYPES.includes(trigger.type) ? TRIGGER_LABELS[trigger.type] : trigger.type}
        {detail ? `: ${detail}` : ''}
      </p>
      <Handle
        id="start"
        type="source"
        position={Position.Bottom}
        className="!size-3 !bg-amber-500"
      />
    </div>
  );
});
