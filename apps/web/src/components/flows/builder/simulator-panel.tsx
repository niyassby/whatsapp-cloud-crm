'use client';

import {
  type FlowDefinition,
  type SimContact,
  type SimContext,
  type SimState,
  simulateHttp,
  simulateReply,
  simulateTimeout,
  startSimulation,
} from '@wacrm/shared';
import { RotateCcw } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { BuilderData } from './node-form';
import { TextField } from './fields';

const REASONS: Record<string, string> = {
  end: 'The flow ended.',
  handoff: 'Handed over to your team.',
  loop: 'Stopped: the flow loops without waiting.',
  step_limit: 'Stopped: too many steps.',
  error: 'Stopped by an error.',
  error_handoff: 'An error handed the conversation to your team.',
};

/**
 * Tries the draft against a made-up contact, in the browser. Nothing is sent or charged, and the
 * HTTP step is answered by hand, so a test never touches a real system.
 */
export function SimulatorPanel({
  def,
  data,
  onPath,
}: {
  def: FlowDefinition;
  data: BuilderData;
  onPath: (path: { visited: string[]; current: string | null }) => void;
}) {
  const [contact, setContact] = useState<SimContact>({
    name: 'Test Customer',
    phone: '919800000000',
    email: null,
    fields: {},
    tagIds: [],
  });
  const [businessOpen, setBusinessOpen] = useState(true);
  const [state, setState] = useState<SimState | null>(null);
  const [text, setText] = useState('');
  const [first, setFirst] = useState(
    def.trigger.type === 'keyword' ? (def.trigger.keywords[0] ?? '') : '',
  );
  const [response, setResponse] = useState('{\n  "status": "shipped"\n}');
  const [responseError, setResponseError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const ctx: SimContext = {
    businessOpen,
    tagNames: Object.fromEntries(data.tags.map((t) => [t.id, t.name])),
    templates: Object.fromEntries(
      data.templates.flatMap((t) =>
        t.definition && t.status === 'approved' && t.supported
          ? [[t.id, { name: t.name, definition: t.definition }]]
          : [],
      ),
    ),
  };

  useEffect(() => {
    onPath({
      visited: state?.path.map((p) => p.nodeId) ?? [],
      current: state?.status === 'waiting' ? (state.waiting?.nodeId ?? null) : null,
    });
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [state, onPath]);

  const start = () => setState(startSimulation(def, contact, ctx, first || undefined));
  const send = (e?: FormEvent, reply?: { text: string; replyId: string }) => {
    e?.preventDefault();
    if (!state) return;
    const r = reply ?? { text: text.trim(), replyId: null };
    if (!r.text) return;
    setState(simulateReply(def, state, ctx, r));
    setText('');
  };
  const answerHttp = (ok: boolean) => {
    if (!state) return;
    let json: unknown = null;
    if (ok) {
      try {
        json = JSON.parse(response);
        setResponseError(null);
      } catch {
        setResponseError('This is not valid JSON');
        return;
      }
    }
    setState(simulateHttp(def, state, ctx, { ok, json }));
  };

  const lastOptions =
    state?.waiting?.kind === 'reply'
      ? [...state.transcript].reverse().find((e) => e.kind === 'bot' && e.options?.length)
      : undefined;

  return (
    <div className="flex h-full flex-col gap-3" aria-label="Test this flow">
      <div>
        <h2 className="text-base font-semibold">Test</h2>
        <p className="text-xs text-muted-foreground">
          Runs the draft against a test contact. Nothing is sent or charged.
        </p>
      </div>

      {!state ? (
        <div className="flex flex-col gap-3">
          <TextField
            label="Test contact name"
            value={contact.name ?? ''}
            onChange={(name) => setContact({ ...contact, name: name || null })}
          />
          <TextField
            label="First message"
            value={first}
            onChange={setFirst}
            hint="What the test contact writes to start, readable as {{trigger.text}}."
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={businessOpen}
              onChange={(e) => setBusinessOpen(e.target.checked)}
            />
            Business hours are open
          </label>
          <Button onClick={start} disabled={!def.startNodeId}>
            Start test
          </Button>
        </div>
      ) : (
        <>
          <div
            role="log"
            aria-label="Test conversation"
            className="flex min-h-48 flex-1 flex-col gap-2 overflow-y-auto rounded-md border bg-muted/30 p-2 text-sm"
          >
            {state.transcript.map((e, i) => {
              if (e.kind === 'user') {
                return (
                  <p
                    key={i}
                    className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-1.5 text-primary-foreground"
                  >
                    {e.text}
                  </p>
                );
              }
              if (e.kind === 'bot') {
                return (
                  <div key={i} className="max-w-[85%] rounded-lg bg-card px-3 py-1.5 shadow-sm">
                    <p className="whitespace-pre-wrap">{e.text}</p>
                    {e.options && e.options.length > 0 && (
                      <ul className="mt-1 flex flex-col gap-0.5 border-t pt-1 text-xs text-primary">
                        {e.options.map((o) => (
                          <li key={o.id}>{o.title}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              }
              if (e.kind === 'bot_media') {
                return (
                  <p key={i} className="max-w-[85%] rounded-lg bg-card px-3 py-1.5 shadow-sm">
                    [{e.mediaKind}] {e.caption}
                  </p>
                );
              }
              return (
                <p
                  key={i}
                  className={cn(
                    'text-center text-xs',
                    e.kind === 'error' ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {e.text}
                </p>
              );
            })}
            {state.status !== 'waiting' && state.endReason && (
              <p className="text-center text-xs font-medium">
                {REASONS[state.endReason] ?? state.endReason}
              </p>
            )}
            <div ref={bottom} />
          </div>

          {state.waiting?.kind === 'reply' && (
            <div className="flex flex-col gap-2">
              {lastOptions?.kind === 'bot' && lastOptions.options && (
                <div className="flex flex-wrap gap-1">
                  {lastOptions.options.map((o) => (
                    <Button
                      key={o.id}
                      size="sm"
                      variant="outline"
                      onClick={() => send(undefined, { text: o.title, replyId: o.id })}
                    >
                      Tap {o.title}
                    </Button>
                  ))}
                </div>
              )}
              <form className="flex gap-2" onSubmit={(e) => send(e)}>
                <Label htmlFor="sim-reply" className="sr-only">
                  Reply as the test contact
                </Label>
                <Input
                  id="sim-reply"
                  placeholder="Reply as the test contact"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <Button type="submit" disabled={!text.trim()}>
                  Send
                </Button>
              </form>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setState(simulateTimeout(def, state, ctx))}
              >
                Do not answer (time out)
              </Button>
            </div>
          )}
          {state.waiting?.kind === 'timer' && (
            <Button onClick={() => setState(simulateTimeout(def, state, ctx))}>
              Skip the wait
            </Button>
          )}
          {state.waiting?.kind === 'http' && (
            <div className="flex flex-col gap-2 rounded-md border p-2 text-sm">
              <p className="font-medium">The flow would call your system:</p>
              <code className="break-all text-xs">
                {state.waiting.request.method} {state.waiting.request.url}
              </code>
              {state.waiting.request.body && (
                <code className="break-all text-xs">{state.waiting.request.body}</code>
              )}
              <Label htmlFor="sim-response">Test answer (JSON)</Label>
              <textarea
                id="sim-response"
                className="min-h-24 rounded-md border bg-transparent p-2 font-mono text-xs"
                value={response}
                onChange={(e) => setResponse(e.target.value)}
              />
              {responseError && <p className="text-xs text-destructive">{responseError}</p>}
              <div className="flex gap-2">
                <Button size="sm" onClick={() => answerHttp(true)}>
                  Answer with this
                </Button>
                <Button size="sm" variant="outline" onClick={() => answerHttp(false)}>
                  Make it fail
                </Button>
              </div>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => setState(null)}>
            <RotateCcw className="size-4" aria-hidden /> Start over
          </Button>
        </>
      )}
    </div>
  );
}
