/**
 * What the flow builder needs beyond the schema: names and descriptions for each step, a valid
 * starting point for a new step, readable names for exits, editing the graph, and the variables a
 * step can insert. Pure functions, so they are tested here and the canvas stays thin.
 */
import {
  type FlowDefinition,
  type FlowEdge,
  type FlowNode,
  type FlowNodeType,
  flowNodeSchema,
  nodeHandles,
  UNSET_ID,
} from './flows';

export type FlowNodeGroup = 'messages' | 'questions' | 'logic' | 'actions' | 'finish';

export const FLOW_NODE_META: Record<
  FlowNodeType,
  { label: string; description: string; group: FlowNodeGroup }
> = {
  send_message: { label: 'Send message', description: 'A text message', group: 'messages' },
  send_template: {
    label: 'Send template',
    description: 'An approved template, also outside the 24-hour window',
    group: 'messages',
  },
  media: {
    label: 'Send file',
    description: 'An image, video, audio or document',
    group: 'messages',
  },
  buttons: { label: 'Buttons', description: 'Up to 3 buttons to tap', group: 'questions' },
  list: { label: 'List', description: 'A menu of up to 10 choices', group: 'questions' },
  ask_question: {
    label: 'Ask a question',
    description: 'Save the answer, checking its type',
    group: 'questions',
  },
  wait_for_reply: {
    label: 'Wait for reply',
    description: 'Pause until the customer writes',
    group: 'questions',
  },
  condition: {
    label: 'Condition',
    description: 'Branch on answers, tags or hours',
    group: 'logic',
  },
  delay: { label: 'Delay', description: 'Wait some minutes, hours or days', group: 'logic' },
  http_request: {
    label: 'HTTP request',
    description: 'Call your own system and save the answer',
    group: 'logic',
  },
  integration_action: {
    label: 'Integration',
    description: 'An action in a connected app',
    group: 'actions',
  },
  tag: { label: 'Tag contact', description: 'Add or remove a tag', group: 'actions' },
  assign_agent: {
    label: 'Assign',
    description: 'Give the conversation to someone',
    group: 'actions',
  },
  ai_reply: { label: 'AI reply', description: 'Answer from your knowledge base', group: 'actions' },
  human_handoff: {
    label: 'Hand over',
    description: 'End the flow and pass to your team',
    group: 'finish',
  },
  end: { label: 'End', description: 'End the flow', group: 'finish' },
};

export const FLOW_NODE_GROUPS: { id: FlowNodeGroup; label: string }[] = [
  { id: 'messages', label: 'Messages' },
  { id: 'questions', label: 'Questions' },
  { id: 'logic', label: 'Logic' },
  { id: 'actions', label: 'Actions' },
  { id: 'finish', label: 'Finish' },
];

/** A valid step of this type, ready to edit. Template and tag ids are left for the person. */
const DEFAULT_DATA: Record<FlowNodeType, unknown> = {
  send_message: { text: 'Hello {{contact.name}}' },
  send_template: { templateId: UNSET_ID, variables: {} },
  media: { kind: 'image', mediaKey: 'unset', mimeType: 'image/jpeg' },
  buttons: {
    body: 'How can we help?',
    buttons: [
      { id: 'option_1', title: 'Option 1' },
      { id: 'option_2', title: 'Option 2' },
    ],
  },
  list: {
    body: 'Choose one',
    buttonText: 'See options',
    sections: [{ rows: [{ id: 'row_1', title: 'Choice 1' }] }],
  },
  ask_question: { question: 'What is your name?', saveAs: 'answer' },
  wait_for_reply: {},
  condition: {
    branches: [
      {
        id: 'branch_1',
        label: 'Matches',
        conditions: [{ kind: 'value', left: '{{vars.answer}}', op: 'eq', right: 'yes' }],
      },
    ],
  },
  delay: { amount: 1, unit: 'hours' },
  http_request: { method: 'GET', url: 'https://example.com/orders/{{vars.answer}}' },
  integration_action: { connector: 'connector', action: 'action' },
  tag: { tagId: UNSET_ID, action: 'add' },
  assign_agent: { userId: null },
  ai_reply: {},
  human_handoff: { message: 'Connecting you to our team.' },
  end: {},
};

/** A short id that is not taken, such as `ask_question_2`. */
export function newNodeId(def: FlowDefinition, type: FlowNodeType): string {
  const taken = new Set(def.nodes.map((n) => n.id));
  for (let i = 1; ; i++) {
    const id = `${type}_${i}`;
    if (!taken.has(id)) return id;
  }
}

export function newNode(
  def: FlowDefinition,
  type: FlowNodeType,
  position: { x: number; y: number },
): FlowNode {
  return flowNodeSchema.parse({
    id: newNodeId(def, type),
    type,
    position,
    data: structuredClone(DEFAULT_DATA[type]),
  });
}

/** Add a step. The first step added becomes the start. */
export function addNode(def: FlowDefinition, node: FlowNode): FlowDefinition {
  return {
    ...def,
    nodes: [...def.nodes, node],
    startNodeId: def.startNodeId ?? node.id,
  };
}

/** Replace a step's data, dropping edges from exits it no longer has. */
export function updateNode(def: FlowDefinition, node: FlowNode): FlowDefinition {
  const handles = new Set(nodeHandles(node));
  return {
    ...def,
    nodes: def.nodes.map((n) => (n.id === node.id ? node : n)),
    edges: def.edges.filter((e) => e.source !== node.id || handles.has(e.sourceHandle)),
  };
}

export function removeNode(def: FlowDefinition, id: string): FlowDefinition {
  const nodes = def.nodes.filter((n) => n.id !== id);
  return {
    ...def,
    nodes,
    edges: def.edges.filter((e) => e.source !== id && e.target !== id),
    startNodeId: def.startNodeId === id ? (nodes[0]?.id ?? null) : def.startNodeId,
  };
}

/** A copy of a step, beside the original, with no connections. */
export function duplicateNode(def: FlowDefinition, id: string): FlowDefinition {
  const node = def.nodes.find((n) => n.id === id);
  if (!node) return def;
  const copy = {
    ...structuredClone(node),
    id: newNodeId(def, node.type),
    position: { x: node.position.x + 40, y: node.position.y + 80 },
  } as FlowNode;
  return { ...def, nodes: [...def.nodes, copy] };
}

/** Point one exit at a step, or disconnect it with null. An exit leads to one step at most. */
export function connect(
  def: FlowDefinition,
  source: string,
  handle: string,
  target: string | null,
): FlowDefinition {
  const edges = def.edges.filter((e) => !(e.source === source && e.sourceHandle === handle));
  if (target && target !== source) {
    const edge: FlowEdge = {
      id: `${source}-${handle}-${target}`,
      source,
      sourceHandle: handle,
      target,
    };
    edges.push(edge);
  }
  return { ...def, edges };
}

export function moveNode(
  def: FlowDefinition,
  id: string,
  position: { x: number; y: number },
): FlowDefinition {
  return {
    ...def,
    nodes: def.nodes.map((n) => (n.id === id ? ({ ...n, position } as FlowNode) : n)),
  };
}

const FIXED_HANDLE_LABELS: Record<string, string> = {
  next: 'Next',
  other: 'Anything else',
  timeout: 'No answer',
  invalid: 'Wrong answer',
  else: 'Otherwise',
  success: 'Worked',
  failure: 'Failed',
  answered: 'Answered',
  handoff: 'Hand over',
};

/** What an exit is called on the canvas and in the side panel. */
export function handleLabel(node: FlowNode, handle: string): string {
  if (node.type === 'buttons') {
    const b = node.data.buttons.find((x) => x.id === handle);
    if (b) return b.title;
  }
  if (node.type === 'list') {
    const r = node.data.sections.flatMap((s) => s.rows).find((x) => x.id === handle);
    if (r) return r.title;
  }
  if (node.type === 'condition') {
    const b = node.data.branches.find((x) => x.id === handle);
    if (b) return b.label || b.id;
  }
  return FIXED_HANDLE_LABELS[handle] ?? handle;
}

/** One line about what a step does, for its card on the canvas. */
export function nodeSummary(node: FlowNode): string {
  const cut = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  switch (node.type) {
    case 'send_message':
      return cut(node.data.text);
    case 'buttons':
    case 'list':
      return cut(node.data.body);
    case 'ask_question':
      return `${cut(node.data.question, 60)} → {{vars.${node.data.saveAs}}}`;
    case 'wait_for_reply':
      return node.data.saveAs ? `Saves to {{vars.${node.data.saveAs}}}` : 'Waits for any message';
    case 'delay':
      return `${node.data.amount} ${node.data.unit}`;
    case 'condition':
      return `${node.data.branches.length} branch${node.data.branches.length === 1 ? '' : 'es'}`;
    case 'http_request':
      return `${node.data.method} ${cut(node.data.url, 60)}`;
    case 'tag':
      return node.data.action === 'add' ? 'Adds a tag' : 'Removes a tag';
    case 'assign_agent':
      return node.data.userId ? 'To a chosen person' : 'By your assignment rules';
    case 'human_handoff':
      return node.data.message ? cut(node.data.message) : 'Passes to your team';
    case 'media':
      return node.data.filename ?? node.data.kind;
    case 'send_template':
      return 'An approved template';
    case 'integration_action':
      return `${node.data.connector}: ${node.data.action}`;
    case 'ai_reply':
      return 'Answers, or hands over when unsure';
    case 'end':
      return 'Ends the conversation flow';
  }
}

export interface FlowVariableOption {
  token: string;
  label: string;
  group: 'Contact' | 'Answers' | 'Trigger';
}

/** What {{...}} a step can use: contact details, custom fields, earlier answers, the trigger. */
export function variableOptions(def: FlowDefinition, fieldKeys: string[]): FlowVariableOption[] {
  const options: FlowVariableOption[] = [
    { token: '{{contact.name}}', label: 'Name', group: 'Contact' },
    { token: '{{contact.phone}}', label: 'Phone', group: 'Contact' },
    { token: '{{contact.email}}', label: 'Email', group: 'Contact' },
    ...fieldKeys.map((k) => ({
      token: `{{contact.fields.${k}}}`,
      label: k,
      group: 'Contact' as const,
    })),
  ];
  const answers = new Set<string>();
  for (const node of def.nodes) {
    if (
      (node.type === 'ask_question' ||
        node.type === 'buttons' ||
        node.type === 'list' ||
        node.type === 'wait_for_reply') &&
      node.data.saveAs
    ) {
      answers.add(node.data.saveAs);
    }
    if (node.type === 'http_request' || node.type === 'integration_action') {
      for (const name of Object.keys(node.data.saveResponse)) answers.add(name);
    }
  }
  for (const name of [...answers].sort()) {
    options.push({ token: `{{vars.${name}}}`, label: name, group: 'Answers' });
  }
  options.push({ token: '{{trigger.text}}', label: 'Message that started it', group: 'Trigger' });
  return options;
}

/** Variables an integration trigger's data offers, from its sample: {{trigger.data.order.id}}. */
export function triggerDataOptions(
  sample: Record<string, unknown>,
  max = 40,
): FlowVariableOption[] {
  const out: FlowVariableOption[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (out.length >= max || path.length > 4) return;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
      return;
    }
    out.push({
      token: `{{trigger.data.${path.join('.')}}}`,
      label: path.join('.'),
      group: 'Trigger',
    });
  };
  walk(sample, []);
  return out;
}
