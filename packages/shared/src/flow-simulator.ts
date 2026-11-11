/**
 * Runs a flow in memory against a made-up contact, for the builder's Test panel. Nothing is sent,
 * stored or charged. It makes the same decisions as the worker engine, through the same helpers
 * (exits, answers, conditions, variables, loop guards), so what a test shows is what a run does.
 * What only a real run can do (24-hour window, wallet, a real HTTP call) is shown as a note or
 * asked of the person testing.
 */
import {
  checkAnswer,
  choiceHandle,
  chooseBranch,
  delayMinutes,
  edgeTarget,
  FLOW_DEFAULT_WAIT_MINUTES,
  FLOW_MAX_STEPS_PER_RUN,
  FLOW_MAX_STEPS_WITHOUT_WAIT,
  type FlowDefinition,
  type FlowNode,
  type FlowReply,
  type FlowScope,
  interpolate,
  readPath,
} from './flows';
import {
  cleanVariableValue,
  renderedText,
  renderTemplate,
  type TemplateDefinition,
  templateVariables,
} from './templates';

export interface SimContact {
  name: string | null;
  phone: string;
  email: string | null;
  fields: Record<string, string | number | boolean>;
  tagIds: string[];
}

export interface SimContext {
  /** Templates by id, for send_template steps. */
  templates: Record<string, { name: string; definition: TemplateDefinition }>;
  /** Tag names by id, for the transcript. */
  tagNames?: Record<string, string>;
  /** Whether business hours are open, for conditions. */
  businessOpen: boolean;
  trigger?: Record<string, unknown>;
}

export type SimEvent =
  | { kind: 'bot'; nodeId: string; text: string; options?: { id: string; title: string }[] }
  | { kind: 'bot_media'; nodeId: string; mediaKind: string; caption: string | null }
  | { kind: 'user'; text: string }
  | { kind: 'note'; nodeId: string | null; text: string }
  | { kind: 'error'; nodeId: string | null; text: string };

export interface SimHttpRequest {
  method: string;
  url: string;
  body: string | null;
}

export interface SimState {
  status: 'running' | 'waiting' | 'completed' | 'failed';
  nodeId: string | null;
  /** What the run waits for: a reply, the end of a delay, or the result of an HTTP step. */
  waiting:
    | { kind: 'reply'; nodeId: string; attempts: number; minutes: number }
    | { kind: 'timer'; nodeId: string; minutes: number }
    | { kind: 'http'; nodeId: string; request: SimHttpRequest }
    | null;
  contact: SimContact;
  vars: Record<string, unknown>;
  steps: number;
  stepsSinceWait: number;
  /** Every node visited, in order, with the exit taken. The canvas highlights these. */
  path: { nodeId: string; outcome: string }[];
  transcript: SimEvent[];
  endReason: string | null;
}

type Input =
  | { kind: 'reply'; reply: FlowReply }
  | { kind: 'timeout' }
  | { kind: 'http'; ok: boolean; status: number; json: unknown };

type Outcome =
  | { kind: 'go'; handle: string; vars?: Record<string, unknown> }
  | { kind: 'wait'; waiting: NonNullable<SimState['waiting']> }
  | { kind: 'end'; status: 'completed' | 'failed'; reason: string };

class SimNodeError extends Error {}

const scopeOf = (s: SimState, ctx: SimContext): FlowScope => ({
  contact: {
    id: 'test-contact',
    name: s.contact.name,
    phone: s.contact.phone,
    email: s.contact.email,
    fields: s.contact.fields,
  },
  vars: s.vars,
  trigger: ctx.trigger ?? { type: 'test' },
});

function exec(
  def: FlowDefinition,
  node: FlowNode,
  s: SimState,
  ctx: SimContext,
  input: Input | null,
): Outcome {
  const scope = scopeOf(s, ctx);
  const say = (t: string) => interpolate(t, scope).trim();
  const bot = (text: string, options?: { id: string; title: string }[]) =>
    s.transcript.push({ kind: 'bot', nodeId: node.id, text, options });
  const note = (text: string) => s.transcript.push({ kind: 'note', nodeId: node.id, text });
  const mine = s.waiting?.nodeId === node.id;
  const reply = input?.kind === 'reply' && mine ? input.reply : null;
  const timedOut = input?.kind === 'timeout' && mine;
  const waitReply = (minutes: number | null, attempts = 0): Outcome => ({
    kind: 'wait',
    waiting: {
      kind: 'reply',
      nodeId: node.id,
      attempts,
      minutes: minutes ?? FLOW_DEFAULT_WAIT_MINUTES,
    },
  });

  switch (node.type) {
    case 'send_message': {
      const text = say(node.data.text);
      if (!text) throw new SimNodeError('The message is empty once variables are filled in');
      bot(text);
      return { kind: 'go', handle: 'next' };
    }
    case 'send_template': {
      const t = ctx.templates[node.data.templateId];
      if (!t) throw new SimNodeError('The template is missing or not approved');
      const values: Record<string, string> = {};
      for (const v of templateVariables(t.definition)) {
        const button = t.definition.buttons[v.buttonIndex ?? -1];
        const value = cleanVariableValue(
          say(node.data.variables[v.key] ?? '') ||
            (button?.type === 'COPY_CODE' ? button.example : ''),
        );
        if (!value) throw new SimNodeError(`No value for the template variable ${v.key}`);
        values[v.key] = value;
      }
      bot(
        renderedText(renderTemplate(t.definition, values)),
        t.definition.buttons
          .filter((b) => b.type === 'QUICK_REPLY')
          .map((b, i) => ({ id: `t${i}`, title: b.text })),
      );
      note(`Template ${t.name}. A real send is charged to the wallet.`);
      return { kind: 'go', handle: 'next' };
    }
    case 'media': {
      s.transcript.push({
        kind: 'bot_media',
        nodeId: node.id,
        mediaKind: node.data.kind,
        caption: node.data.caption ? say(node.data.caption) : null,
      });
      return { kind: 'go', handle: 'next' };
    }
    case 'buttons':
    case 'list': {
      if (timedOut) return { kind: 'go', handle: 'timeout' };
      if (reply) {
        const { handle, value } = choiceHandle(node, reply);
        return {
          kind: 'go',
          handle,
          vars: node.data.saveAs ? { [node.data.saveAs]: value } : undefined,
        };
      }
      const options =
        node.type === 'buttons'
          ? node.data.buttons
          : node.data.sections.flatMap((sec) =>
              sec.rows.map((r) => ({ id: r.id, title: r.title })),
            );
      bot(say(node.data.body), options);
      return waitReply(node.data.timeoutMinutes);
    }
    case 'ask_question': {
      if (timedOut) return { kind: 'go', handle: 'timeout' };
      if (reply) {
        let answer = checkAnswer(node.data.answerType, reply.text);
        if (answer !== null && node.data.contactField) {
          // A real run also checks the answer against the field type.
          s.contact.fields = { ...s.contact.fields, [node.data.contactField]: answer };
        }
        if (answer === null) {
          const attempts = (s.waiting?.kind === 'reply' ? s.waiting.attempts : 0) + 1;
          if (attempts > node.data.retries) return { kind: 'go', handle: 'invalid' };
          bot(say(node.data.retryMessage));
          return waitReply(node.data.timeoutMinutes, attempts);
        }
        answer = answer.slice(0, 1000);
        return { kind: 'go', handle: 'next', vars: { [node.data.saveAs]: answer } };
      }
      bot(say(node.data.question));
      return waitReply(node.data.timeoutMinutes);
    }
    case 'wait_for_reply': {
      if (timedOut) return { kind: 'go', handle: 'timeout' };
      if (reply) {
        return {
          kind: 'go',
          handle: 'next',
          vars: node.data.saveAs ? { [node.data.saveAs]: reply.text ?? '' } : undefined,
        };
      }
      return waitReply(node.data.timeoutMinutes);
    }
    case 'delay': {
      if (timedOut) return { kind: 'go', handle: 'next' };
      return {
        kind: 'wait',
        waiting: { kind: 'timer', nodeId: node.id, minutes: delayMinutes(node.data) },
      };
    }
    case 'condition':
      return {
        kind: 'go',
        handle: chooseBranch(node, {
          scope,
          tagIds: s.contact.tagIds,
          businessOpen: ctx.businessOpen,
        }),
      };
    case 'http_request': {
      if (input?.kind === 'http' && mine) {
        const vars: Record<string, unknown> = {};
        if (input.ok) {
          for (const [name, path] of Object.entries(node.data.saveResponse)) {
            vars[name] = readPath(input.json, path) ?? null;
          }
        }
        return { kind: 'go', handle: input.ok ? 'success' : 'failure', vars };
      }
      const body = node.data.body;
      const looksJson = body !== undefined && /^\s*[[{]/.test(body);
      return {
        kind: 'wait',
        waiting: {
          kind: 'http',
          nodeId: node.id,
          request: {
            method: node.data.method,
            url: interpolate(node.data.url, scope, encodeURIComponent),
            body:
              body === undefined
                ? null
                : interpolate(
                    body,
                    scope,
                    looksJson ? (v) => JSON.stringify(v).slice(1, -1) : undefined,
                  ),
          },
        },
      };
    }
    case 'integration_action':
      note(`Connector ${node.data.connector} is not set up, so this takes the failure exit.`);
      return { kind: 'go', handle: 'failure' };
    case 'ai_reply':
      note('AI replies are not set up yet, so this hands over.');
      return { kind: 'go', handle: 'handoff' };
    case 'tag': {
      const name = ctx.tagNames?.[node.data.tagId] ?? 'a tag';
      if (node.data.action === 'add') {
        if (!s.contact.tagIds.includes(node.data.tagId)) s.contact.tagIds.push(node.data.tagId);
        note(`Tag added: ${name}`);
      } else {
        s.contact.tagIds = s.contact.tagIds.filter((t) => t !== node.data.tagId);
        note(`Tag removed: ${name}`);
      }
      return { kind: 'go', handle: 'next' };
    }
    case 'assign_agent':
      note(
        node.data.userId ? 'Assigned to the chosen person' : 'Assigned by your assignment rules',
      );
      return { kind: 'go', handle: 'next' };
    case 'human_handoff':
      if (node.data.message) bot(say(node.data.message));
      note('Handed over to your team. The conversation opens in the inbox.');
      return { kind: 'end', status: 'completed', reason: 'handoff' };
    case 'end':
      return { kind: 'end', status: 'completed', reason: 'end' };
  }
}

/** Run until the flow waits or ends. Mutates and returns `s`. */
function run(def: FlowDefinition, s: SimState, ctx: SimContext, first: Input | null): SimState {
  let input = first;
  while (s.status === 'running') {
    const end = (status: 'completed' | 'failed', reason: string, error?: string) => {
      s.status = status;
      s.endReason = reason;
      s.waiting = null;
      if (error) s.transcript.push({ kind: 'error', nodeId: s.nodeId, text: error });
    };
    if (s.steps >= FLOW_MAX_STEPS_PER_RUN) {
      end('failed', 'step_limit', `Stopped after ${FLOW_MAX_STEPS_PER_RUN} steps`);
      break;
    }
    if (s.stepsSinceWait >= FLOW_MAX_STEPS_WITHOUT_WAIT) {
      end(
        'failed',
        'loop',
        `Stopped after ${FLOW_MAX_STEPS_WITHOUT_WAIT} steps without waiting: the flow loops`,
      );
      break;
    }
    const node = def.nodes.find((n) => n.id === s.nodeId);
    if (!node) {
      end('completed', 'end');
      break;
    }
    let outcome: Outcome;
    try {
      outcome = exec(def, node, s, ctx, input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      s.steps++;
      s.path.push({ nodeId: node.id, outcome: 'failed' });
      if (def.settings.onError === 'handoff') {
        s.transcript.push({ kind: 'note', nodeId: node.id, text: 'Handed over to your team.' });
      }
      end('failed', def.settings.onError === 'handoff' ? 'error_handoff' : 'error', message);
      break;
    }
    input = null;
    s.steps++;
    if (outcome.kind === 'go') {
      s.path.push({ nodeId: node.id, outcome: outcome.handle });
      if (outcome.vars) s.vars = { ...s.vars, ...outcome.vars };
      s.waiting = null;
      s.stepsSinceWait++;
      const target = edgeTarget(def, node.id, outcome.handle);
      if (!target) {
        end('completed', 'end');
        break;
      }
      s.nodeId = target;
    } else if (outcome.kind === 'wait') {
      s.path.push({ nodeId: node.id, outcome: 'waiting' });
      s.status = 'waiting';
      s.waiting = outcome.waiting;
      s.stepsSinceWait = 0;
      if (outcome.waiting.kind === 'timer') {
        s.transcript.push({
          kind: 'note',
          nodeId: node.id,
          text: `Waiting ${outcome.waiting.minutes} minutes`,
        });
      }
    } else {
      s.path.push({ nodeId: node.id, outcome: outcome.reason });
      end(outcome.status, outcome.reason);
    }
  }
  return s;
}

const clone = (s: SimState): SimState => structuredClone(s);

/** Start a test run at the flow's first step. */
export function startSimulation(
  def: FlowDefinition,
  contact: SimContact,
  ctx: SimContext,
  firstMessage?: string,
): SimState {
  const s: SimState = {
    status: 'running',
    nodeId: def.startNodeId,
    waiting: null,
    contact: structuredClone(contact),
    vars: {},
    steps: 0,
    stepsSinceWait: 0,
    path: [],
    transcript: firstMessage ? [{ kind: 'user', text: firstMessage }] : [],
    endReason: null,
  };
  return run(def, s, { ...ctx, trigger: { text: firstMessage ?? '', ...ctx.trigger } }, null);
}

/** The test contact writes or taps something. Ignored unless the run waits for a reply. */
export function simulateReply(
  def: FlowDefinition,
  state: SimState,
  ctx: SimContext,
  reply: { text: string; replyId?: string | null },
): SimState {
  if (state.status !== 'waiting' || state.waiting?.kind !== 'reply') return state;
  const s = clone(state);
  s.transcript.push({ kind: 'user', text: reply.text });
  s.status = 'running';
  return run(def, s, ctx, {
    kind: 'reply',
    reply: { messageId: 'test', type: 'text', text: reply.text, replyId: reply.replyId ?? null },
  });
}

/** Skip a delay, or let a wait for a reply time out. */
export function simulateTimeout(def: FlowDefinition, state: SimState, ctx: SimContext): SimState {
  if (state.status !== 'waiting' || !state.waiting || state.waiting.kind === 'http') return state;
  const s = clone(state);
  s.transcript.push({
    kind: 'note',
    nodeId: s.waiting!.nodeId,
    text: s.waiting!.kind === 'timer' ? 'Wait skipped' : 'No answer: timed out',
  });
  s.status = 'running';
  return run(def, s, ctx, { kind: 'timeout' });
}

/** Answer an HTTP step with a made-up response. */
export function simulateHttp(
  def: FlowDefinition,
  state: SimState,
  ctx: SimContext,
  response: { ok: boolean; status?: number; json: unknown },
): SimState {
  if (state.status !== 'waiting' || state.waiting?.kind !== 'http') return state;
  const s = clone(state);
  s.transcript.push({
    kind: 'note',
    nodeId: s.waiting!.nodeId,
    text: response.ok ? 'Request answered' : 'Request failed',
  });
  s.status = 'running';
  return run(def, s, ctx, {
    kind: 'http',
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: response.json,
  });
}
