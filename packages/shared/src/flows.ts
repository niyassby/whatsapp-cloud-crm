/**
 * Flow definitions: a JSON graph of nodes and edges, validated with Zod, plus the pure parts of the
 * engine (variables, conditions, answer checks, which edge to follow). The API validates and stores
 * definitions, the worker runs them, and the builder (3.3) edits them, all with this one module.
 *
 * Shape follows React Flow: nodes have an id, a type, a position and their own data; edges join a
 * node's named handle (`sourceHandle`) to another node. A handle with no edge ends the run.
 */
import { z } from 'zod';
import { AUTO_REPLY_MATCH_TYPES, matchesRule, regexProblem } from './automation';

// ------------------------------------------------------------------ limits

/** Every node a run executes counts. Ends a run that would go on forever. */
export const FLOW_MAX_STEPS_PER_RUN = 500;
/** Nodes executed without stopping to wait. More than this is a loop with no wait in it. */
export const FLOW_MAX_STEPS_WITHOUT_WAIT = 50;
/** A wait with no timeout of its own ends after this long. */
export const FLOW_DEFAULT_WAIT_MINUTES = 7 * 24 * 60;
export const FLOW_MAX_DELAY_MINUTES = 30 * 24 * 60;
/** Runs of one flow a contact can start in an hour, so two bots cannot trigger each other forever. */
export const FLOW_MAX_STARTS_PER_HOUR = 5;
export const FLOW_MAX_NODES = 200;
export const FLOW_HTTP_TIMEOUT_MS = 10_000;
/** Of an HTTP response body, kept for variables and the run history. */
export const FLOW_HTTP_MAX_BODY = 64 * 1024;

// ------------------------------------------------------------------ building blocks

const id = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Ids are letters, numbers, - and _');
/** Variable names, as used in {{vars.name}}. */
export const flowVariableName = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Lower-case letters, numbers and _, starting with a letter');
const text = (max: number) => z.string().trim().min(1, 'Required').max(max);
const position = z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 });

/** Minutes to wait for a reply. null: FLOW_DEFAULT_WAIT_MINUTES, then the run ends. */
const timeoutMinutes = z.number().int().min(1).max(FLOW_MAX_DELAY_MINUTES).nullable().default(null);

export const FLOW_CONDITION_OPS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_set',
  'is_not_set',
] as const;
export type FlowConditionOp = (typeof FLOW_CONDITION_OPS)[number];

export const flowConditionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('value'),
    /** Text with {{variables}}, such as "{{vars.size}}". */
    left: z.string().max(500),
    op: z.enum(FLOW_CONDITION_OPS),
    right: z.string().max(500).default(''),
  }),
  z.object({ kind: z.literal('tag'), tagId: z.uuid(), has: z.boolean().default(true) }),
  z.object({ kind: z.literal('business_hours'), open: z.boolean().default(true) }),
]);
export type FlowCondition = z.infer<typeof flowConditionSchema>;

const branch = z.object({
  id,
  label: z.string().trim().max(60).default(''),
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(flowConditionSchema).min(1).max(20),
});

export const FLOW_ANSWER_TYPES = ['any', 'text', 'number', 'email', 'phone'] as const;
export type FlowAnswerType = (typeof FLOW_ANSWER_TYPES)[number];

export const FLOW_MEDIA_KINDS = ['image', 'video', 'audio', 'document'] as const;
export type FlowMediaKind = (typeof FLOW_MEDIA_KINDS)[number];

const httpHeader = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,64}$/, 'Not a header name'),
  value: z.string().max(1000),
});

// ------------------------------------------------------------------ nodes

const nodeBase = { id, position };

export const flowNodeSchema = z.discriminatedUnion('type', [
  z.object({
    ...nodeBase,
    type: z.literal('send_message'),
    data: z.object({ text: text(4096) }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('send_template'),
    data: z.object({
      templateId: z.uuid(),
      /** Values by template variable key; each may hold {{variables}}. */
      variables: z.record(z.string().max(100), z.string().max(1024)).default({}),
    }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('buttons'),
    data: z.object({
      body: text(1024),
      header: z.string().trim().max(60).optional(),
      footer: z.string().trim().max(60).optional(),
      buttons: z
        .array(z.object({ id, title: text(20) }))
        .min(1)
        .max(3),
      saveAs: flowVariableName.optional(),
      timeoutMinutes,
    }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('list'),
    data: z.object({
      body: text(1024),
      header: z.string().trim().max(60).optional(),
      footer: z.string().trim().max(60).optional(),
      buttonText: text(20),
      sections: z
        .array(
          z.object({
            title: z.string().trim().max(24).optional(),
            rows: z
              .array(
                z.object({
                  id,
                  title: text(24),
                  description: z.string().trim().max(72).optional(),
                }),
              )
              .min(1)
              .max(10),
          }),
        )
        .min(1)
        .max(10),
      saveAs: flowVariableName.optional(),
      timeoutMinutes,
    }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('media'),
    data: z.object({
      kind: z.enum(FLOW_MEDIA_KINDS),
      /** Object storage key from POST /flows/media. */
      mediaKey: z.string().min(1).max(300),
      mimeType: z.string().min(1).max(200),
      filename: z.string().max(200).optional(),
      caption: z.string().trim().max(1024).optional(),
    }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('ask_question'),
    data: z.object({
      question: text(1024),
      answerType: z.enum(FLOW_ANSWER_TYPES).default('any'),
      saveAs: flowVariableName,
      /** Also store the answer on the contact, in this custom field. */
      contactField: z.string().max(64).optional(),
      retries: z.number().int().min(0).max(5).default(2),
      retryMessage: z.string().trim().max(1024).default("Sorry, I didn't understand that."),
      timeoutMinutes,
    }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('wait_for_reply'),
    data: z.object({ saveAs: flowVariableName.optional(), timeoutMinutes }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('condition'),
    data: z.object({ branches: z.array(branch).min(1).max(10) }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('delay'),
    data: z.object({
      amount: z.number().int().min(1),
      unit: z.enum(['minutes', 'hours', 'days']),
    }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('http_request'),
    data: z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      /** https only; may hold {{variables}}, which are percent-encoded. */
      url: z.string().trim().min(1).max(2000),
      headers: z.array(httpHeader).max(20).default([]),
      /** JSON or text with {{variables}}. */
      body: z.string().max(10_000).optional(),
      /** Variable name -> dotted path into the JSON response, such as "order.status". */
      saveResponse: z.record(flowVariableName, z.string().max(200)).default({}),
    }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('integration_action'),
    data: z.object({
      /** A connector key and one of its actions (packages/connectors). */
      connector: z.string().trim().min(1).max(64),
      /** Which connection to use. null: the workspace's first working one for the connector. */
      connectionId: z.uuid().nullable().default(null),
      action: z.string().trim().min(1).max(64),
      input: z.record(z.string().max(64), z.string().max(2000)).default({}),
      saveResponse: z.record(flowVariableName, z.string().max(200)).default({}),
    }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('tag'),
    data: z.object({ tagId: z.uuid(), action: z.enum(['add', 'remove']).default('add') }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('assign_agent'),
    /** userId null: the assignment rules choose, as for a new conversation. */
    data: z.object({ userId: z.uuid().nullable().default(null) }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('ai_reply'),
    data: z.object({
      instructions: z.string().trim().max(2000).default(''),
      /** 0 to 1. Below it, the run takes the handoff edge instead of answering. */
      minConfidence: z.number().min(0).max(1).default(0.7),
    }),
  }),
  z.object({
    ...nodeBase,
    type: z.literal('human_handoff'),
    data: z.object({
      message: z.string().trim().max(4096).optional(),
      userId: z.uuid().nullable().default(null),
    }),
  }),
  z.object({ ...nodeBase, type: z.literal('end'), data: z.object({}).default({}) }),
]);
export type FlowNode = z.infer<typeof flowNodeSchema>;
export type FlowNodeType = FlowNode['type'];
export const FLOW_NODE_TYPES = flowNodeSchema.options.map((o) => o.shape.type.value);

export const flowEdgeSchema = z.object({
  id,
  source: id,
  sourceHandle: id.default('next'),
  target: id,
});
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

// ------------------------------------------------------------------ triggers

export const FLOW_TRIGGER_TYPES = [
  'keyword',
  'new_contact',
  'tag_added',
  'template_button',
  'integration_event',
  'ad_referral',
  'manual',
] as const;
export type FlowTriggerType = (typeof FLOW_TRIGGER_TYPES)[number];

export const flowTriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('keyword'),
    matchType: z.enum(AUTO_REPLY_MATCH_TYPES),
    keywords: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    pattern: z.string().max(200).nullable().default(null),
  }),
  /** The first message a contact ever sends. */
  z.object({ type: z.literal('new_contact') }),
  z.object({ type: z.literal('tag_added'), tagId: z.uuid() }),
  /** A quick-reply button on a template. Either filter may be left empty to match any. */
  z.object({
    type: z.literal('template_button'),
    templateId: z.uuid().nullable().default(null),
    buttonText: z.string().trim().max(25).nullable().default(null),
  }),
  z.object({
    type: z.literal('integration_event'),
    connector: z.string().trim().min(1).max(64),
    event: z.string().trim().min(1).max(64),
  }),
  /** A message from a click-to-WhatsApp ad. sourceId null matches any ad. */
  z.object({ type: z.literal('ad_referral'), sourceId: z.string().trim().max(64).nullable() }),
  /** Only started from the API or another tool. */
  z.object({ type: z.literal('manual') }),
]);
export type FlowTrigger = z.infer<typeof flowTriggerSchema>;

export const FLOW_ERROR_ACTIONS = ['end', 'handoff'] as const;

export const flowSettingsSchema = z.object({
  /** What happens when a node fails and has no failure edge: end, or hand to a person. */
  onError: z.enum(FLOW_ERROR_ACTIONS).default('end'),
  /** once: a contact runs this flow at most once, ever. */
  reentry: z.enum(['always', 'once']).default('always'),
  /** Number the run speaks from when a trigger has no conversation. null: the newest one. */
  phoneId: z.uuid().nullable().default(null),
});
export type FlowSettings = z.infer<typeof flowSettingsSchema>;

export const flowDefinitionSchema = z.object({
  trigger: flowTriggerSchema,
  startNodeId: id.nullable().default(null),
  nodes: z.array(flowNodeSchema).max(FLOW_MAX_NODES).default([]),
  edges: z
    .array(flowEdgeSchema)
    .max(FLOW_MAX_NODES * 12)
    .default([]),
  settings: flowSettingsSchema.default(flowSettingsSchema.parse({})),
});
export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;
export type FlowDefinitionInput = z.input<typeof flowDefinitionSchema>;

export const EMPTY_FLOW_DEFINITION: FlowDefinition = flowDefinitionSchema.parse({
  trigger: { type: 'manual' },
});

// ------------------------------------------------------------------ handles

/** The named exits of a node. Edges may only leave from these. */
export function nodeHandles(node: FlowNode): string[] {
  switch (node.type) {
    case 'buttons':
      return [...node.data.buttons.map((b) => b.id), 'other', 'timeout'];
    case 'list':
      return [...node.data.sections.flatMap((s) => s.rows.map((r) => r.id)), 'other', 'timeout'];
    case 'ask_question':
      return ['next', 'invalid', 'timeout'];
    case 'wait_for_reply':
      return ['next', 'timeout'];
    case 'condition':
      return [...node.data.branches.map((b) => b.id), 'else'];
    case 'http_request':
    case 'integration_action':
      return ['success', 'failure'];
    case 'ai_reply':
      return ['answered', 'handoff'];
    case 'human_handoff':
    case 'end':
      return [];
    default:
      return ['next'];
  }
}

/** Nodes that stop the run until a customer answers. */
export const WAITING_NODE_TYPES = new Set<FlowNodeType>([
  'buttons',
  'list',
  'ask_question',
  'wait_for_reply',
]);

// ------------------------------------------------------------------ checking a definition

/** Placeholder id in a new step, until the person chooses a template or tag. */
export const UNSET_ID = '00000000-0000-0000-0000-000000000000';

export interface FlowIssue {
  /** The node it concerns, or null for the flow as a whole. */
  nodeId: string | null;
  message: string;
  /** Errors stop publishing; warnings do not. */
  level: 'error' | 'warning';
}

/**
 * What is wrong with a definition beyond its shape: ids, edges, handles, reachability and settings
 * that only make sense together. A draft may have issues; publishing needs no errors.
 */
export function flowIssues(def: FlowDefinition): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const error = (nodeId: string | null, message: string) =>
    issues.push({ nodeId, message, level: 'error' });
  const warn = (nodeId: string | null, message: string) =>
    issues.push({ nodeId, message, level: 'warning' });

  if (def.trigger.type === 'keyword') {
    const t = def.trigger;
    if (t.matchType === 'regex') {
      const problem = t.pattern ? regexProblem(t.pattern) : 'Enter a pattern';
      if (problem) error(null, `Trigger: ${problem}`);
    } else if (t.keywords.length === 0) {
      error(null, 'Trigger: add at least one keyword');
    }
  }

  const byId = new Map<string, FlowNode>();
  for (const node of def.nodes) {
    if (byId.has(node.id)) error(node.id, `Two nodes have the id ${node.id}`);
    byId.set(node.id, node);
  }
  if (def.nodes.length === 0) {
    error(null, 'Add at least one step');
    return issues;
  }
  if (!def.startNodeId || !byId.has(def.startNodeId)) {
    error(null, 'Choose the first step');
  }

  const edgeIds = new Set<string>();
  const usedHandles = new Set<string>();
  for (const edge of def.edges) {
    if (edgeIds.has(edge.id)) error(null, `Two connections have the id ${edge.id}`);
    edgeIds.add(edge.id);
    const source = byId.get(edge.source);
    if (!source) {
      error(null, `A connection starts at a missing step (${edge.source})`);
      continue;
    }
    if (!byId.has(edge.target)) {
      error(source.id, 'A connection goes to a missing step');
      continue;
    }
    if (!nodeHandles(source).includes(edge.sourceHandle)) {
      error(source.id, `This step has no exit called "${edge.sourceHandle}"`);
      continue;
    }
    const key = `${edge.source}:${edge.sourceHandle}`;
    if (usedHandles.has(key)) error(source.id, 'One exit is connected to two steps');
    usedHandles.add(key);
  }

  for (const node of def.nodes) {
    if (node.type === 'send_template' && node.data.templateId === UNSET_ID) {
      error(node.id, 'Choose a template');
    }
    if (node.type === 'tag' && node.data.tagId === UNSET_ID) error(node.id, 'Choose a tag');
    if (node.type === 'media' && node.data.mediaKey === 'unset') error(node.id, 'Upload a file');
    switch (node.type) {
      case 'buttons': {
        const ids = node.data.buttons.map((b) => b.id);
        if (new Set(ids).size !== ids.length) error(node.id, 'Two buttons have the same id');
        const titles = node.data.buttons.map((b) => b.title.toLowerCase());
        if (new Set(titles).size !== titles.length) error(node.id, 'Button titles must differ');
        break;
      }
      case 'list': {
        const rows = node.data.sections.flatMap((s) => s.rows);
        if (rows.length > 10) error(node.id, 'A list has at most 10 rows in all');
        if (new Set(rows.map((r) => r.id)).size !== rows.length) {
          error(node.id, 'Two rows have the same id');
        }
        if (node.data.sections.length > 1 && node.data.sections.some((s) => !s.title)) {
          error(node.id, 'With more than one section, every section needs a title');
        }
        break;
      }
      case 'condition': {
        const ids = node.data.branches.map((b) => b.id);
        if (ids.includes('else') || new Set(ids).size !== ids.length) {
          error(node.id, 'Branch ids must differ, and "else" is taken');
        }
        break;
      }
      case 'delay': {
        if (delayMinutes(node.data) > FLOW_MAX_DELAY_MINUTES) {
          error(node.id, 'A delay can be at most 30 days');
        }
        break;
      }
      case 'http_request': {
        const url = node.data.url;
        if (!/^https:\/\//i.test(url)) error(node.id, 'The address must start with https://');
        else if (/^https:\/\/\{\{/.test(url)) {
          error(node.id, 'The host cannot come from a variable');
        }
        break;
      }
    }
  }

  // Reachability from the first step. Unreachable steps are allowed in a draft, but say so.
  if (def.startNodeId && byId.has(def.startNodeId)) {
    const next = new Map<string, string[]>();
    for (const e of def.edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
    const seen = new Set<string>([def.startNodeId]);
    const queue = [def.startNodeId];
    while (queue.length) {
      for (const t of next.get(queue.shift()!) ?? []) {
        if (!seen.has(t)) {
          seen.add(t);
          queue.push(t);
        }
      }
    }
    for (const node of def.nodes) {
      if (!seen.has(node.id)) warn(node.id, 'Nothing leads to this step');
    }
  }
  return issues;
}

export const hasFlowErrors = (issues: FlowIssue[]) => issues.some((i) => i.level === 'error');

export const delayMinutes = (d: { amount: number; unit: 'minutes' | 'hours' | 'days' }) =>
  d.amount * (d.unit === 'days' ? 1440 : d.unit === 'hours' ? 60 : 1);

/** Where an exit leads, or null when nothing is connected (the run ends). */
export function edgeTarget(def: FlowDefinition, nodeId: string, handle: string): string | null {
  return def.edges.find((e) => e.source === nodeId && e.sourceHandle === handle)?.target ?? null;
}

// ------------------------------------------------------------------ variables

/** What {{...}} can read during a run. */
export interface FlowScope {
  contact: {
    id: string;
    name: string | null;
    /** Empty for someone known only on Instagram or website chat. */
    phone: string;
    email: string | null;
    fields: Record<string, string | number | boolean>;
  };
  vars: Record<string, unknown>;
  trigger: Record<string, unknown>;
}

/** Reads a dotted path such as "order.items.0.name". Missing parts give undefined. */
export function readPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (part === '') continue;
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(part);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (typeof cur === 'object') {
      cur = Object.prototype.hasOwnProperty.call(cur, part)
        ? (cur as Record<string, unknown>)[part]
        : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

const asText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
};

const VAR_PATTERN = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

function lookup(scope: FlowScope, path: string): unknown {
  const [root, ...rest] = path.split('.');
  const tail = rest.join('.');
  if (root === 'contact') {
    if (tail === 'phone') return scope.contact.phone ? `+${scope.contact.phone}` : '';
    if (tail.startsWith('fields.')) return readPath(scope.contact.fields, tail.slice(7));
    return readPath(scope.contact, tail);
  }
  if (root === 'vars') return readPath(scope.vars, tail);
  if (root === 'trigger') return readPath(scope.trigger, tail);
  return undefined;
}

/**
 * Replace {{contact.name}}, {{vars.x}}, {{trigger.data.y}} and so on. Unknown names become empty
 * text. `encode` percent-encodes each value, for URLs.
 */
export function interpolate(
  template: string,
  scope: FlowScope,
  encode?: (value: string) => string,
): string {
  return template.replace(VAR_PATTERN, (_, path: string) => {
    const value = asText(lookup(scope, path));
    return encode ? encode(value) : value;
  });
}

/** The variable names a definition reads, for the builder's picker and checks. */
export function referencedVariables(template: string): string[] {
  return [...template.matchAll(VAR_PATTERN)].map((m) => m[1]!);
}

// ------------------------------------------------------------------ conditions

const asNumber = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Text comparisons ignore case and surrounding spaces; gt/lt compare as numbers. */
export function compareValues(left: string, op: FlowConditionOp, right: string): boolean {
  const l = left.trim().toLowerCase();
  const r = right.trim().toLowerCase();
  switch (op) {
    case 'eq': {
      const ln = asNumber(l);
      const rn = asNumber(r);
      return ln !== null && rn !== null ? ln === rn : l === r;
    }
    case 'neq':
      return !compareValues(left, 'eq', right);
    case 'contains':
      return l.includes(r);
    case 'not_contains':
      return !l.includes(r);
    case 'starts_with':
      return l.startsWith(r);
    case 'is_set':
      return l !== '';
    case 'is_not_set':
      return l === '';
    default: {
      const ln = asNumber(l);
      const rn = asNumber(r);
      if (ln === null || rn === null) return false;
      if (op === 'gt') return ln > rn;
      if (op === 'gte') return ln >= rn;
      if (op === 'lt') return ln < rn;
      return ln <= rn;
    }
  }
}

export interface ConditionFacts {
  scope: FlowScope;
  tagIds: string[];
  businessOpen: boolean;
}

export function conditionHolds(c: FlowCondition, facts: ConditionFacts): boolean {
  switch (c.kind) {
    case 'value':
      return compareValues(
        interpolate(c.left, facts.scope),
        c.op,
        interpolate(c.right, facts.scope),
      );
    case 'tag':
      return facts.tagIds.includes(c.tagId) === c.has;
    case 'business_hours':
      return facts.businessOpen === c.open;
  }
}

/** The first branch whose conditions hold, else "else". */
export function chooseBranch(
  node: Extract<FlowNode, { type: 'condition' }>,
  facts: ConditionFacts,
): string {
  for (const b of node.data.branches) {
    const results = b.conditions.map((c) => conditionHolds(c, facts));
    if (b.match === 'all' ? results.every(Boolean) : results.some(Boolean)) return b.id;
  }
  return 'else';
}

// ------------------------------------------------------------------ answers

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The cleaned answer, or null when it does not fit the expected type. */
export function checkAnswer(type: FlowAnswerType, raw: string | null): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  switch (type) {
    case 'any':
    case 'text':
      return value.slice(0, 1000);
    case 'number': {
      const n = asNumber(value);
      return n === null ? null : String(n);
    }
    case 'email':
      return EMAIL.test(value) ? value.toLowerCase() : null;
    case 'phone': {
      const digits = value.replace(/[\s().-]/g, '');
      return /^\+?\d{6,15}$/.test(digits) ? digits : null;
    }
  }
}

/** A customer's message, as a waiting node sees it. */
export interface FlowReply {
  messageId: string;
  type: string;
  text: string | null;
  /** The id of the button or list row tapped, when it was one. */
  replyId: string | null;
}

/** Which exit a reply to a buttons or list node takes. */
export function choiceHandle(
  node: Extract<FlowNode, { type: 'buttons' | 'list' }>,
  reply: FlowReply,
): { handle: string; value: string | null } {
  const options =
    node.type === 'buttons'
      ? node.data.buttons
      : node.data.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title })));
  // A tapped option carries its id. A typed answer matching a title counts too.
  const byId = reply.replyId ? options.find((o) => o.id === reply.replyId) : undefined;
  const typed = reply.text?.trim().toLowerCase();
  const chosen = byId ?? options.find((o) => typed && o.title.toLowerCase() === typed);
  return chosen
    ? { handle: chosen.id, value: chosen.title }
    : { handle: 'other', value: reply.text };
}

// ------------------------------------------------------------------ triggers

export interface FlowTriggerFacts {
  text: string | null;
  isNewContact: boolean;
  /** Quick-reply button on a template: its text and the template it came from. */
  templateButton: { text: string; templateId: string | null } | null;
  adSourceId: string | null;
}

/** Does an inbound message start this trigger? Event triggers are matched elsewhere. */
export function messageMatchesTrigger(trigger: FlowTrigger, facts: FlowTriggerFacts): boolean {
  switch (trigger.type) {
    case 'keyword':
      return matchesRule(
        { matchType: trigger.matchType, keywords: trigger.keywords, pattern: trigger.pattern },
        facts.text,
      );
    case 'new_contact':
      return facts.isNewContact;
    case 'template_button':
      return (
        facts.templateButton !== null &&
        (!trigger.templateId || trigger.templateId === facts.templateButton.templateId) &&
        (!trigger.buttonText ||
          trigger.buttonText.toLowerCase() === facts.templateButton.text.trim().toLowerCase())
      );
    case 'ad_referral':
      return (
        facts.adSourceId !== null && (!trigger.sourceId || trigger.sourceId === facts.adSourceId)
      );
    default:
      return false;
  }
}

/** Message triggers in the order they are tried: the most specific first. */
export const MESSAGE_TRIGGER_ORDER: FlowTriggerType[] = [
  'template_button',
  'ad_referral',
  'keyword',
  'new_contact',
];

// ------------------------------------------------------------------ API

export const FLOW_RUN_STATUSES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
] as const;
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];
export const ACTIVE_FLOW_RUN_STATUSES: FlowRunStatus[] = ['running', 'waiting'];

export const createFlowSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(100),
  definition: flowDefinitionSchema.optional(),
});
export type CreateFlowInput = z.input<typeof createFlowSchema>;

export const updateFlowSchema = z
  .object({
    name: z.string().trim().min(1, 'Required').max(100).optional(),
    /** The draft. Saved even with issues; publishing checks it. */
    definition: flowDefinitionSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.definition !== undefined, 'Nothing to update');
export type UpdateFlowInput = z.input<typeof updateFlowSchema>;

export const setFlowActiveSchema = z.object({ active: z.boolean() });

export const listFlowRunsSchema = z.object({
  status: z.enum([...FLOW_RUN_STATUSES, 'any']).default('any'),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListFlowRunsQuery = z.infer<typeof listFlowRunsSchema>;

export const startFlowRunSchema = z.object({ contactId: z.uuid() });

export interface FlowDto {
  id: string;
  name: string;
  active: boolean;
  triggerType: FlowTriggerType;
  draft: FlowDefinition;
  issues: FlowIssue[];
  /** The draft differs from what is published. */
  hasUnpublishedChanges: boolean;
  publishedVersion: number | null;
  publishedAt: string | null;
  activeRuns: number;
  createdAt: string;
  updatedAt: string;
}

export interface FlowVersionDto {
  id: string;
  version: number;
  publishedAt: string;
  publishedByName: string | null;
}

export interface FlowRunDto {
  id: string;
  flowId: string;
  version: number;
  status: FlowRunStatus;
  contact: { id: string; name: string | null; waId: string | null };
  conversationId: string | null;
  currentNodeId: string | null;
  variables: Record<string, unknown>;
  steps: number;
  waitingUntil: string | null;
  endReason: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface FlowRunStepDto {
  id: string;
  nodeId: string;
  nodeType: string;
  /** The exit taken, or what happened: waiting, failed, ended. */
  outcome: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}
