import { describe, expect, it } from 'vitest';
import {
  addNode,
  connect,
  duplicateNode,
  handleLabel,
  newNode,
  removeNode,
  updateNode,
  variableOptions,
} from './flow-builder';
import {
  type SimContact,
  type SimContext,
  simulateHttp,
  simulateReply,
  simulateTimeout,
  startSimulation,
} from './flow-simulator';
import {
  EMPTY_FLOW_DEFINITION,
  type FlowDefinitionInput,
  flowDefinitionSchema,
  flowIssues,
  hasFlowErrors,
  UNSET_ID,
} from './flows';

const edge = (source: string, target: string, sourceHandle = 'next') => ({
  id: `${source}-${sourceHandle}`,
  source,
  sourceHandle,
  target,
});
const parse = (d: FlowDefinitionInput) => flowDefinitionSchema.parse(d);

const TAG = '7b5f3c2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const contact: SimContact = {
  name: 'Ravi',
  phone: '919800000001',
  email: null,
  fields: {},
  tagIds: [],
};
const ctx: SimContext = { templates: {}, businessOpen: true, tagNames: { [TAG]: 'VIP' } };

/** The order-status flow from the 3.3 acceptance: ask, look up, answer, or hand over. */
const ORDER_STATUS = parse({
  trigger: { type: 'keyword', matchType: 'contains', keywords: ['order'] },
  startNodeId: 'menu',
  nodes: [
    {
      id: 'menu',
      type: 'buttons',
      data: {
        body: 'Hi {{contact.name}}, what do you need?',
        buttons: [
          { id: 'status', title: 'Order status' },
          { id: 'human', title: 'Talk to us' },
        ],
      },
    },
    {
      id: 'ask',
      type: 'ask_question',
      data: { question: 'Your order number?', answerType: 'number', saveAs: 'order', retries: 1 },
    },
    {
      id: 'lookup',
      type: 'http_request',
      data: {
        method: 'GET',
        url: 'https://shop.example.com/orders/{{vars.order}}',
        saveResponse: { state: 'status' },
      },
    },
    { id: 'tell', type: 'send_message', data: { text: 'Order {{vars.order}} is {{vars.state}}.' } },
    { id: 'vip', type: 'tag', data: { tagId: TAG } },
    { id: 'later', type: 'delay', data: { amount: 2, unit: 'days' } },
    { id: 'check', type: 'send_message', data: { text: 'Did it arrive?' } },
    { id: 'human', type: 'human_handoff', data: { message: 'Connecting you.' } },
  ],
  edges: [
    edge('menu', 'ask', 'status'),
    edge('menu', 'human', 'human'),
    edge('ask', 'lookup'),
    edge('ask', 'human', 'invalid'),
    edge('lookup', 'tell', 'success'),
    edge('lookup', 'human', 'failure'),
    edge('tell', 'vip'),
    edge('vip', 'later'),
    edge('later', 'check'),
  ],
});

const botTexts = (s: ReturnType<typeof startSimulation>) =>
  s.transcript.flatMap((e) => (e.kind === 'bot' ? [e.text] : []));

describe('simulator', () => {
  it('runs the order-status flow end to end, asking the tester for the HTTP answer', () => {
    let s = startSimulation(ORDER_STATUS, contact, ctx, 'where is my order');
    expect(s.status).toBe('waiting');
    expect(s.transcript[1]).toMatchObject({
      kind: 'bot',
      text: 'Hi Ravi, what do you need?',
      options: [
        { id: 'status', title: 'Order status' },
        { id: 'human', title: 'Talk to us' },
      ],
    });

    s = simulateReply(ORDER_STATUS, s, ctx, { text: 'Order status', replyId: 'status' });
    s = simulateReply(ORDER_STATUS, s, ctx, { text: 'soon?' });
    expect(botTexts(s).at(-1)).toBe("Sorry, I didn't understand that.");
    s = simulateReply(ORDER_STATUS, s, ctx, { text: '1042' });
    expect(s.waiting).toEqual({
      kind: 'http',
      nodeId: 'lookup',
      request: { method: 'GET', url: 'https://shop.example.com/orders/1042', body: null },
    });

    s = simulateHttp(ORDER_STATUS, s, ctx, { ok: true, json: { status: 'shipped' } });
    expect(botTexts(s).at(-1)).toBe('Order 1042 is shipped.');
    expect(s.contact.tagIds).toEqual([TAG]);
    expect(s.waiting).toMatchObject({ kind: 'timer', minutes: 2880 });

    s = simulateTimeout(ORDER_STATUS, s, ctx);
    expect(s).toMatchObject({ status: 'completed', endReason: 'end' });
    expect(botTexts(s).at(-1)).toBe('Did it arrive?');
    expect(s.vars).toEqual({ order: '1042', state: 'shipped' });
    expect(s.path.map((p) => `${p.nodeId}:${p.outcome}`)).toEqual([
      'menu:waiting',
      'menu:status',
      'ask:waiting',
      'ask:waiting',
      'ask:next',
      'lookup:waiting',
      'lookup:success',
      'tell:next',
      'vip:next',
      'later:waiting',
      'later:next',
      'check:next',
    ]);
  });

  it('a failed lookup and a wrong answer both hand over', () => {
    let s = startSimulation(ORDER_STATUS, contact, ctx);
    s = simulateReply(ORDER_STATUS, s, ctx, { text: 'order status' });
    s = simulateReply(ORDER_STATUS, s, ctx, { text: '7' });
    s = simulateHttp(ORDER_STATUS, s, ctx, { ok: false, json: null });
    expect(s).toMatchObject({ status: 'completed', endReason: 'handoff' });

    let t = startSimulation(ORDER_STATUS, contact, ctx);
    t = simulateReply(ORDER_STATUS, t, ctx, { text: 'x', replyId: 'status' });
    t = simulateReply(ORDER_STATUS, t, ctx, { text: 'no' });
    t = simulateReply(ORDER_STATUS, t, ctx, { text: 'still no' });
    expect(t).toMatchObject({ status: 'completed', endReason: 'handoff' });
    expect(botTexts(t).at(-1)).toBe('Connecting you.');
  });

  it('never changes the state it was given', () => {
    const s = startSimulation(ORDER_STATUS, contact, ctx);
    const before = JSON.stringify(s);
    simulateReply(ORDER_STATUS, s, ctx, { text: 'x', replyId: 'status' });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('stops a loop, and reports a failing step', () => {
    const loop = parse({
      trigger: { type: 'manual' },
      startNodeId: 'a',
      nodes: [
        { id: 'a', type: 'tag', data: { tagId: TAG } },
        { id: 'b', type: 'tag', data: { tagId: TAG, action: 'remove' } },
      ],
      edges: [edge('a', 'b'), edge('b', 'a')],
    });
    expect(startSimulation(loop, contact, ctx)).toMatchObject({
      status: 'failed',
      endReason: 'loop',
    });

    const missing = parse({
      trigger: { type: 'manual' },
      startNodeId: 't',
      nodes: [{ id: 't', type: 'send_template', data: { templateId: UNSET_ID } }],
      settings: { onError: 'handoff' },
    });
    const s = startSimulation(missing, contact, ctx);
    expect(s).toMatchObject({ status: 'failed', endReason: 'error_handoff' });
    expect(s.transcript.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('renders templates with their variables', () => {
    const def = parse({
      trigger: { type: 'manual' },
      startNodeId: 't',
      nodes: [
        {
          id: 't',
          type: 'send_template',
          data: {
            templateId: 'a1b2c3d4-0000-4000-8000-000000000000',
            variables: { 'body.1': '{{contact.name}}' },
          },
        },
      ],
    });
    const s = startSimulation(def, contact, {
      ...ctx,
      templates: {
        'a1b2c3d4-0000-4000-8000-000000000000': {
          name: 'order_update',
          definition: {
            category: 'UTILITY',
            parameterFormat: 'POSITIONAL',
            header: null,
            body: 'Hello {{1}}, your order shipped.',
            footer: null,
            buttons: [],
            examples: { 'body.1': 'Asha' },
          } as never,
        },
      },
    });
    expect(botTexts(s)).toEqual(['Hello Ravi, your order shipped.']);
  });
});

describe('builder helpers', () => {
  it('adds steps, makes the first one the start, and connects exits', () => {
    let def = EMPTY_FLOW_DEFINITION;
    const a = newNode(def, 'buttons', { x: 0, y: 0 });
    def = addNode(def, a);
    const b = newNode(def, 'send_message', { x: 0, y: 200 });
    def = addNode(def, b);
    expect(def.startNodeId).toBe(a.id);
    expect(b.id).toBe('send_message_1');

    def = connect(def, a.id, 'option_1', b.id);
    def = connect(def, a.id, 'option_1', b.id);
    expect(def.edges).toHaveLength(1);
    def = connect(def, a.id, 'option_1', null);
    expect(def.edges).toHaveLength(0);
  });

  it('dropping a button drops its connection, and removing a step cleans up', () => {
    let def = EMPTY_FLOW_DEFINITION;
    const a = newNode(def, 'buttons', { x: 0, y: 0 });
    def = addNode(def, a);
    const b = newNode(def, 'end', { x: 0, y: 200 });
    def = addNode(def, b);
    def = connect(def, a.id, 'option_2', b.id);
    if (a.type !== 'buttons') throw new Error('type');
    def = updateNode(def, { ...a, data: { ...a.data, buttons: [a.data.buttons[0]!] } });
    expect(def.edges).toEqual([]);

    def = connect(def, a.id, 'option_1', b.id);
    def = removeNode(def, a.id);
    expect(def).toMatchObject({ edges: [], startNodeId: b.id });
  });

  it('duplicates a step without its connections', () => {
    let def = addNode(
      EMPTY_FLOW_DEFINITION,
      newNode(EMPTY_FLOW_DEFINITION, 'delay', { x: 0, y: 0 }),
    );
    def = duplicateNode(def, 'delay_1');
    expect(def.nodes.map((n) => n.id)).toEqual(['delay_1', 'delay_2']);
  });

  it('new steps are valid, but say what still needs choosing', () => {
    let def = EMPTY_FLOW_DEFINITION;
    for (const type of ['send_template', 'tag', 'media'] as const) {
      def = addNode(def, newNode(def, type, { x: 0, y: 0 }));
    }
    const messages = flowIssues(def).map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining(['Choose a template', 'Choose a tag', 'Upload a file']),
    );
    expect(hasFlowErrors(flowIssues(def))).toBe(true);
  });

  it('names exits and lists the variables a step can use', () => {
    const menu = ORDER_STATUS.nodes[0]!;
    expect(handleLabel(menu, 'status')).toBe('Order status');
    expect(handleLabel(menu, 'timeout')).toBe('No answer');
    const tokens = variableOptions(ORDER_STATUS, ['city']).map((o) => o.token);
    expect(tokens).toEqual(
      expect.arrayContaining([
        '{{contact.name}}',
        '{{contact.fields.city}}',
        '{{vars.order}}',
        '{{vars.state}}',
        '{{trigger.text}}',
      ]),
    );
  });
});
