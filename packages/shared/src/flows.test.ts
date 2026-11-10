import { describe, expect, it } from 'vitest';
import {
  checkAnswer,
  choiceHandle,
  chooseBranch,
  compareValues,
  edgeTarget,
  type FlowDefinitionInput,
  flowDefinitionSchema,
  flowIssues,
  type FlowNode,
  type FlowScope,
  hasFlowErrors,
  interpolate,
  messageMatchesTrigger,
  nodeHandles,
  readPath,
} from './flows';

const parse = (def: FlowDefinitionInput) => flowDefinitionSchema.parse(def);
const edge = (source: string, target: string, sourceHandle = 'next') => ({
  id: `${source}-${sourceHandle}`,
  source,
  sourceHandle,
  target,
});

const scope: FlowScope = {
  contact: {
    id: 'c',
    name: 'Asha',
    phone: '919800000001',
    email: null,
    fields: { city: 'Pune', tier: 2 },
  },
  vars: { order: { id: 'A1', items: [{ name: 'Tea' }] }, size: 'L' },
  trigger: { text: 'hello' },
};

describe('definitions', () => {
  it('fills in defaults, and knows each node’s exits', () => {
    const def = parse({
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['hi'] },
      startNodeId: 'b',
      nodes: [
        {
          id: 'b',
          type: 'buttons',
          data: { body: 'Pick', buttons: [{ id: 'yes', title: 'Yes' }] },
        },
      ],
    });
    expect(def.settings).toEqual({ onError: 'end', reentry: 'always', phoneId: null });
    expect(nodeHandles(def.nodes[0]!)).toEqual(['yes', 'other', 'timeout']);
  });

  it('refuses shapes WhatsApp would refuse', () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, title: `B${i}` }));
    expect(
      flowDefinitionSchema.safeParse({
        trigger: { type: 'manual' },
        nodes: [{ id: 'x', type: 'buttons', data: { body: 'x', buttons: many } }],
      }).success,
    ).toBe(false);
    expect(
      flowDefinitionSchema.safeParse({
        trigger: { type: 'manual' },
        nodes: [
          {
            id: 'x',
            type: 'buttons',
            data: { body: 'x', buttons: [{ id: 'a', title: 'A title over twenty chars' }] },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('finds what stops publishing, and warns about unreachable steps', () => {
    const def = parse({
      trigger: { type: 'keyword', matchType: 'contains', keywords: [] },
      startNodeId: 'a',
      nodes: [
        { id: 'a', type: 'send_message', data: { text: 'x' } },
        { id: 'a', type: 'end' },
        { id: 'lonely', type: 'end' },
        { id: 'h', type: 'http_request', data: { method: 'GET', url: 'http://x.test' } },
      ],
      edges: [edge('a', 'missing'), edge('a', 'lonely', 'nope')],
    });
    const issues = flowIssues(def);
    const messages = issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'Trigger: add at least one keyword',
        'Two nodes have the id a',
        'A connection goes to a missing step',
        'The address must start with https://',
        'Nothing leads to this step',
      ]),
    );
    expect(issues.find((i) => i.message === 'Nothing leads to this step')?.level).toBe('warning');
    expect(hasFlowErrors(issues)).toBe(true);
  });

  it('a clean flow has no errors, and follows its edges', () => {
    const def = parse({
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['hi'] },
      startNodeId: 'a',
      nodes: [
        { id: 'a', type: 'send_message', data: { text: 'Hi' } },
        { id: 'b', type: 'end' },
      ],
      edges: [edge('a', 'b')],
    });
    expect(hasFlowErrors(flowIssues(def))).toBe(false);
    expect(edgeTarget(def, 'a', 'next')).toBe('b');
    expect(edgeTarget(def, 'b', 'next')).toBeNull();
  });

  it('refuses a host taken from a variable, and one exit wired twice', () => {
    const def = parse({
      trigger: { type: 'manual' },
      startNodeId: 'h',
      nodes: [
        { id: 'h', type: 'http_request', data: { method: 'GET', url: 'https://{{vars.host}}/x' } },
        { id: 'a', type: 'end' },
        { id: 'b', type: 'end' },
      ],
      edges: [
        { id: '1', source: 'h', sourceHandle: 'success', target: 'a' },
        { id: '2', source: 'h', sourceHandle: 'success', target: 'b' },
      ],
    });
    const messages = flowIssues(def).map((i) => i.message);
    expect(messages).toContain('The host cannot come from a variable');
    expect(messages).toContain('One exit is connected to two steps');
  });
});

describe('variables', () => {
  it('reads contact, fields, variables and the trigger', () => {
    expect(
      interpolate(
        'Hi {{contact.name}} ({{contact.phone}}) from {{ contact.fields.city }}: {{vars.order.items.0.name}}, {{trigger.text}}',
        scope,
      ),
    ).toBe('Hi Asha (+919800000001) from Pune: Tea, hello');
  });

  it('unknown names are empty, objects are JSON, and values can be encoded', () => {
    expect(interpolate('[{{vars.nope}}][{{secret.x}}]', scope)).toBe('[][]');
    expect(interpolate('{{vars.order.items}}', scope)).toBe('[{"name":"Tea"}]');
    expect(interpolate('/o/{{vars.size}}?q={{trigger.text}}', scope, encodeURIComponent)).toBe(
      '/o/L?q=hello',
    );
  });

  it('readPath does not reach into prototypes', () => {
    expect(readPath({ a: 1 }, 'constructor')).toBeUndefined();
    expect(readPath({ a: [1, 2] }, 'a.1')).toBe(2);
  });
});

describe('conditions', () => {
  it('compares text without case, and numbers as numbers', () => {
    expect(compareValues('Yes ', 'eq', 'yes')).toBe(true);
    expect(compareValues('10', 'gt', '9')).toBe(true);
    expect(compareValues('1,200', 'gte', '1000')).toBe(true);
    expect(compareValues('abc', 'gt', '1')).toBe(false);
    expect(compareValues('', 'is_not_set', '')).toBe(true);
    expect(compareValues('Mumbai', 'contains', 'mum')).toBe(true);
  });

  it('takes the first branch that holds, else else', () => {
    const node = parse({
      trigger: { type: 'manual' },
      nodes: [
        {
          id: 'c',
          type: 'condition',
          data: {
            branches: [
              {
                id: 'vip',
                conditions: [
                  { kind: 'value', left: '{{contact.fields.tier}}', op: 'gte', right: '3' },
                ],
              },
              {
                id: 'pune',
                match: 'any',
                conditions: [
                  { kind: 'value', left: '{{contact.fields.city}}', op: 'eq', right: 'pune' },
                  { kind: 'business_hours', open: true },
                ],
              },
            ],
          },
        },
      ],
    }).nodes[0] as Extract<FlowNode, { type: 'condition' }>;
    const facts = { scope, tagIds: [], businessOpen: false };
    expect(chooseBranch(node, facts)).toBe('pune');
    expect(
      chooseBranch(node, {
        ...facts,
        scope: { ...scope, contact: { ...scope.contact, fields: {} } },
      }),
    ).toBe('else');
  });
});

describe('answers', () => {
  it('checks types', () => {
    expect(checkAnswer('number', ' 42 ')).toBe('42');
    expect(checkAnswer('number', 'forty')).toBeNull();
    expect(checkAnswer('email', 'A@B.co')).toBe('a@b.co');
    expect(checkAnswer('email', 'nope')).toBeNull();
    expect(checkAnswer('phone', '+91 98000 00001')).toBe('+919800000001');
    expect(checkAnswer('any', '   ')).toBeNull();
  });

  it('a tap picks its button, typing its title counts, anything else is other', () => {
    const node = parse({
      trigger: { type: 'manual' },
      nodes: [
        {
          id: 'b',
          type: 'buttons',
          data: {
            body: 'Pick',
            buttons: [
              { id: 'yes', title: 'Yes' },
              { id: 'no', title: 'No' },
            ],
          },
        },
      ],
    }).nodes[0] as Extract<FlowNode, { type: 'buttons' }>;
    const reply = (text: string, replyId: string | null = null) => ({
      messageId: 'm',
      type: 'text',
      text,
      replyId,
    });
    expect(choiceHandle(node, reply('whatever', 'no'))).toEqual({ handle: 'no', value: 'No' });
    expect(choiceHandle(node, reply(' YES '))).toEqual({ handle: 'yes', value: 'Yes' });
    expect(choiceHandle(node, reply('maybe'))).toEqual({ handle: 'other', value: 'maybe' });
  });
});

describe('triggers', () => {
  const facts = {
    text: 'Where is my ORDER?',
    isNewContact: false,
    templateButton: null,
    adSourceId: null,
  };

  it('keywords, new contacts, ads and template buttons', () => {
    expect(
      messageMatchesTrigger(
        { type: 'keyword', matchType: 'contains', keywords: ['order'], pattern: null },
        facts,
      ),
    ).toBe(true);
    expect(messageMatchesTrigger({ type: 'new_contact' }, facts)).toBe(false);
    expect(messageMatchesTrigger({ type: 'new_contact' }, { ...facts, isNewContact: true })).toBe(
      true,
    );
    expect(
      messageMatchesTrigger({ type: 'ad_referral', sourceId: null }, { ...facts, adSourceId: 'x' }),
    ).toBe(true);
    expect(
      messageMatchesTrigger({ type: 'ad_referral', sourceId: 'y' }, { ...facts, adSourceId: 'x' }),
    ).toBe(false);
    const button = { ...facts, templateButton: { text: 'Track', templateId: 't1' } };
    expect(
      messageMatchesTrigger(
        { type: 'template_button', templateId: 't1', buttonText: 'track' },
        button,
      ),
    ).toBe(true);
    expect(
      messageMatchesTrigger(
        { type: 'template_button', templateId: 't2', buttonText: null },
        button,
      ),
    ).toBe(false);
    // Event triggers never match a message.
    expect(messageMatchesTrigger({ type: 'manual' }, facts)).toBe(false);
  });
});
