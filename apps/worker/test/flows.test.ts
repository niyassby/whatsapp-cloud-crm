/**
 * Phase 3.2 on real Postgres: the flow engine. The acceptance test runs a 10-node flow with
 * delays and branching, stopping the "worker" between and inside steps, and checks every message
 * goes out exactly once and the run ends where it should.
 */
import { randomUUID } from 'node:crypto';
import { type DbClient, withTenant } from '@wacrm/db';
import {
  type FlowDefinitionInput,
  flowDefinitionSchema,
  type FlowJob,
  FLOW_MAX_STEPS_WITHOUT_WAIT,
} from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInboxAutomation } from '../src/processors/automation';
import { advanceRun, flowDueRuns, processFlowJob, wakeRun } from '../src/processors/flows';
import { processMessagesChange } from '../src/processors/inbound';
import { sendOutboundMessage, stuckOutboundMessages } from '../src/processors/outbound';
import { buildDeps, connectNumber, createOrg, db, ownerDb } from './support';

let client: DbClient;
let owner: DbClient;

beforeAll(() => {
  client = db();
  owner = ownerDb();
});
afterAll(async () => {
  await client.$disconnect();
  await owner.$disconnect();
});

const WA = '919811122233';

async function setup() {
  const orgId = await createOrg(client);
  const number = await connectNumber(client, orgId);
  let built = buildDeps(client);

  const inbound = (message: Record<string, unknown>, from = WA) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: number.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '1', phone_number_id: number.phoneNumberId },
              contacts: [{ profile: { name: 'Ravi' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: `wamid.${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'hi' },
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  });

  /** Runs every queued flow job that is due now, as the flows worker would. */
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      const next = built.flowJobs.findIndex((j) => !j.delayMs);
      if (next < 0) return;
      const [{ job }] = built.flowJobs.splice(next, 1) as [{ job: FlowJob }];
      await processFlowJob(built.deps, job);
    }
    throw new Error('flow jobs did not settle');
  };

  /** Webhook, then the automation queue, then the flows queue, as production runs them. */
  const deliver = async (payload: ReturnType<typeof inbound>) => {
    const before = built.automation.length;
    await processMessagesChange(built.deps, orgId, payload);
    for (const job of built.automation.slice(before)) await runInboxAutomation(built.deps, job);
    await drain();
  };
  const say = (text: string, from = WA) => deliver(inbound({ text: { body: text } }, from));
  const tap = (id: string, title: string) =>
    deliver(
      inbound({
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id, title } },
      }),
    );

  /** Time passes: every waiting run is due, then the schedule's tick picks them up. */
  const passTime = async () => {
    await owner.flowRun.updateMany({
      where: { orgId, status: 'waiting' },
      data: { wakeAt: new Date(Date.now() - 1000) },
    });
    await tick();
  };
  const tick = async () => {
    for (const due of await flowDueRuns(built.deps)) {
      if (due.org_id === orgId) await wakeRun(built.deps, orgId, due.id);
    }
    await drain();
  };
  /** A new worker process: nothing in memory carries over, only the database. */
  const restart = () => {
    built = buildDeps(client);
  };

  const flow = async (name: string, def: FlowDefinitionInput, opts: { active?: boolean } = {}) => {
    const definition = flowDefinitionSchema.parse(def);
    const flowId = randomUUID();
    const versionId = randomUUID();
    await withTenant(client, { orgId }, async (tx) => {
      await tx.flow.create({
        data: {
          id: flowId,
          orgId,
          name,
          draft: definition as object,
          active: opts.active ?? true,
          triggerType: definition.trigger.type,
          trigger: definition.trigger as object,
        },
      });
      await tx.flowVersion.create({
        data: { id: versionId, orgId, flowId, version: 1, definition: definition as object },
      });
      await tx.flow.update({ where: { id: flowId }, data: { publishedVersionId: versionId } });
    });
    return { flowId, versionId };
  };

  const texts = async () =>
    (
      await withTenant(client, { orgId }, (tx) =>
        tx.message.findMany({
          where: { direction: 'outbound' },
          orderBy: { createdAt: 'asc' },
          select: { body: true, type: true, content: true },
        }),
      )
    ).map((m) => m.body);
  const runs = () =>
    withTenant(client, { orgId }, (tx) => tx.flowRun.findMany({ orderBy: { startedAt: 'asc' } }));
  const history = (runId: string) =>
    withTenant(client, { orgId }, (tx) =>
      tx.flowRunStep.findMany({ where: { runId }, orderBy: { id: 'asc' } }),
    );
  const contact = (waId = WA) =>
    withTenant(client, { orgId }, (tx) =>
      tx.contact.findFirstOrThrow({ where: { waId }, include: { tags: true } }),
    );
  const tag = (name: string) =>
    withTenant(client, { orgId }, (tx) => tx.tag.create({ data: { orgId, name } }));

  return {
    orgId,
    number,
    get built() {
      return built;
    },
    say,
    tap,
    deliver,
    inbound,
    drain,
    tick,
    passTime,
    restart,
    flow,
    texts,
    runs,
    history,
    contact,
    tag,
  };
}

const edge = (source: string, target: string, sourceHandle = 'next') => ({
  id: `${source}-${sourceHandle}`,
  source,
  sourceHandle,
  target,
});

describe('a 10-node flow with delays and branching, across worker restarts', () => {
  it('runs every branch step exactly once and ends where it should', async () => {
    const t = await setup();
    const vip = await t.tag('vip');
    await t.flow('Order help', {
      trigger: { type: 'keyword', matchType: 'contains', keywords: ['order'] },
      startNodeId: 'greet',
      nodes: [
        { id: 'greet', type: 'send_message', data: { text: 'Hi {{contact.name}}!' } },
        {
          id: 'menu',
          type: 'buttons',
          data: {
            body: 'What do you need?',
            buttons: [
              { id: 'track', title: 'Track an order' },
              { id: 'talk', title: 'Talk to us' },
            ],
            saveAs: 'choice',
          },
        },
        {
          id: 'ask',
          type: 'ask_question',
          data: { question: 'Your order number?', answerType: 'number', saveAs: 'order' },
        },
        {
          id: 'size',
          type: 'condition',
          data: {
            branches: [
              {
                id: 'big',
                conditions: [{ kind: 'value', left: '{{vars.order}}', op: 'gte', right: '1000' }],
              },
            ],
          },
        },
        { id: 'wait1', type: 'delay', data: { amount: 5, unit: 'minutes' } },
        {
          id: 'status',
          type: 'send_message',
          data: { text: 'Order {{vars.order}} is on its way' },
        },
        { id: 'mark', type: 'tag', data: { tagId: vip.id } },
        { id: 'wait2', type: 'delay', data: { amount: 1, unit: 'hours' } },
        {
          id: 'followup',
          type: 'send_message',
          data: { text: 'Anything else, {{contact.name}}?' },
        },
        { id: 'done', type: 'end' },
        { id: 'small', type: 'send_message', data: { text: 'Small orders ship tomorrow' } },
        { id: 'human', type: 'human_handoff', data: { message: 'Connecting you to the team' } },
      ],
      edges: [
        edge('greet', 'menu'),
        edge('menu', 'ask', 'track'),
        edge('menu', 'human', 'talk'),
        edge('ask', 'size'),
        edge('size', 'wait1', 'big'),
        edge('size', 'small', 'else'),
        edge('wait1', 'status'),
        edge('status', 'mark'),
        edge('mark', 'wait2'),
        edge('wait2', 'followup'),
        edge('followup', 'done'),
      ],
    });

    await t.say('where is my order');
    expect(await t.texts()).toEqual(['Hi Ravi!', 'What do you need?']);
    const [run] = await t.runs();
    expect(run).toMatchObject({ status: 'waiting', currentNodeId: 'menu' });

    // The worker restarts while the run waits for a button.
    t.restart();
    await t.tap('track', 'Track an order');
    expect((await t.texts()).at(-1)).toBe('Your order number?');

    // A wrong answer is asked again; a number moves on, into the first delay.
    await t.say('not sure');
    expect((await t.texts()).at(-1)).toBe("Sorry, I didn't understand that.");
    await t.say('10421');
    expect((await t.runs())[0]).toMatchObject({ status: 'waiting', currentNodeId: 'wait1' });

    // Restart during the delay: nothing in memory survives, the schedule still wakes it.
    t.restart();
    await t.tick();
    expect((await t.runs())[0]!.status).toBe('waiting');
    await t.passTime();
    expect((await t.texts()).at(-1)).toBe('Order 10421 is on its way');
    expect((await t.runs())[0]).toMatchObject({ status: 'waiting', currentNodeId: 'wait2' });
    expect((await t.contact()).tags.map((x) => x.tagId)).toEqual([vip.id]);

    // The worker dies after a step commits but before it queues the message. The next worker
    // finds the run left `running`, carries on from the next node, and sends nothing twice.
    t.restart();
    let crash = true;
    const enqueue = t.built.deps.enqueueOutbound;
    t.built.deps.enqueueOutbound = async (job) => {
      if (crash) {
        crash = false;
        throw new Error('worker killed');
      }
      return enqueue(job);
    };
    await owner.flowRun.updateMany({
      where: { orgId: t.orgId, status: 'waiting' },
      data: { wakeAt: new Date(Date.now() - 1000) },
    });
    const due = (await flowDueRuns(t.built.deps)).filter((d) => d.org_id === t.orgId);
    await expect(wakeRun(t.built.deps, t.orgId, due[0]!.id)).rejects.toThrow('worker killed');
    t.restart();
    await owner.flowRun.updateMany({
      where: { orgId: t.orgId },
      data: { updatedAt: new Date(Date.now() - 120_000) },
    });
    await t.tick();

    // The message whose queueing died is still queued with no job. The sweep finds it (the test
    // sends nothing, so every message here is queued; the lost one is among them).
    const stuck = (await stuckOutboundMessages(t.built.deps, new Date(Date.now() + 1000))).filter(
      (m) => m.org_id === t.orgId,
    );
    const followup = await withTenant(client, { orgId: t.orgId }, (tx) =>
      tx.message.findFirstOrThrow({ where: { body: 'Anything else, Ravi?' } }),
    );
    expect(stuck.map((m) => m.id)).toContain(followup.id);

    const finished = (await t.runs())[0]!;
    expect(finished).toMatchObject({ status: 'completed', endReason: 'end' });
    expect(finished.variables).toEqual({ choice: 'Track an order', order: '10421' });
    expect(await t.texts()).toEqual([
      'Hi Ravi!',
      'What do you need?',
      'Your order number?',
      "Sorry, I didn't understand that.",
      'Order 10421 is on its way',
      'Anything else, Ravi?',
    ]);
    const steps = (await t.history(finished.id)).map((s) => `${s.nodeId}:${s.outcome}`);
    expect(steps).toEqual([
      'greet:started',
      'greet:next',
      'menu:waiting',
      'menu:track',
      'ask:waiting',
      'ask:waiting',
      'ask:next',
      'size:big',
      'wait1:delayed',
      'wait1:next',
      'status:next',
      'mark:next',
      'wait2:delayed',
      'wait2:next',
      'followup:next',
      'done:end',
    ]);
  });

  it('the other branch hands the conversation to a person', async () => {
    const t = await setup();
    await t.flow('Menu', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['menu'] },
      startNodeId: 'menu',
      nodes: [
        {
          id: 'menu',
          type: 'buttons',
          data: { body: 'Pick one', buttons: [{ id: 'talk', title: 'Talk to us' }] },
        },
        { id: 'human', type: 'human_handoff', data: { message: 'Connecting you' } },
      ],
      edges: [edge('menu', 'human', 'talk')],
    });
    await t.say('Menu');
    // Typing a button's title counts as tapping it.
    await t.say('talk to us');
    const [run] = await t.runs();
    expect(run).toMatchObject({ status: 'completed', endReason: 'handoff' });
    expect((await t.texts()).at(-1)).toBe('Connecting you');
    const conversation = await withTenant(client, { orgId: t.orgId }, (tx) =>
      tx.conversation.findFirstOrThrow({}),
    );
    expect(conversation.status).toBe('open');
  });
});

describe('the engine', () => {
  it('sends buttons as an interactive message', async () => {
    const t = await setup();
    await t.flow('Buttons', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['ask'] },
      startNodeId: 'b',
      nodes: [
        {
          id: 'b',
          type: 'buttons',
          data: { body: 'Yes or no, {{contact.name}}?', buttons: [{ id: 'y', title: 'Yes' }] },
        },
      ],
      edges: [],
    });
    await t.say('ask');
    const [job] = t.built.outbound;
    expect(await sendOutboundMessage(t.built.deps, job!)).toBe('sent');
    const call = t.built.fake.calls.find((c) => c.method === 'sendInteractive');
    expect(call?.args[1]).toEqual({
      type: 'button',
      body: 'Yes or no, Ravi?',
      buttons: [{ id: 'y', title: 'Yes' }],
    });
  });

  it('a reply delivered twice is answered once', async () => {
    const t = await setup();
    await t.flow('Ask', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['start'] },
      startNodeId: 'q',
      nodes: [
        { id: 'q', type: 'ask_question', data: { question: 'Name?', saveAs: 'name' } },
        { id: 'thanks', type: 'send_message', data: { text: 'Thanks {{vars.name}}' } },
      ],
      edges: [edge('q', 'thanks')],
    });
    await t.say('start');
    const answer = t.inbound({ text: { body: 'Meera' } });
    await t.deliver(answer);
    await t.deliver(answer);
    expect(await t.texts()).toEqual(['Name?', 'Thanks Meera']);
  });

  it('a step that loops without waiting is stopped', async () => {
    const t = await setup();
    const a = await t.tag('a');
    await t.flow('Loop', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['loop'] },
      startNodeId: 'x',
      nodes: [
        { id: 'x', type: 'tag', data: { tagId: a.id, action: 'add' } },
        { id: 'y', type: 'tag', data: { tagId: a.id, action: 'remove' } },
      ],
      edges: [edge('x', 'y'), edge('y', 'x')],
    });
    await t.say('loop');
    const [run] = await t.runs();
    expect(run).toMatchObject({ status: 'failed', endReason: 'loop' });
    expect(run!.steps).toBe(FLOW_MAX_STEPS_WITHOUT_WAIT);
  });

  it('a run that has taken too many steps is stopped', async () => {
    const t = await setup();
    await t.flow('Long', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['long'] },
      startNodeId: 'w',
      nodes: [
        { id: 'w', type: 'delay', data: { amount: 1, unit: 'minutes' } },
        { id: 'x', type: 'send_message', data: { text: 'never' } },
      ],
      edges: [edge('w', 'x')],
    });
    await t.say('long');
    await owner.flowRun.updateMany({ where: { orgId: t.orgId }, data: { steps: 500 } });
    await t.passTime();
    expect((await t.runs())[0]).toMatchObject({ status: 'failed', endReason: 'step_limit' });
    expect(await t.texts()).toEqual([]);
  });

  it('times out a question, and takes the invalid exit after the retries', async () => {
    const t = await setup();
    await t.flow('Email', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['email'] },
      startNodeId: 'q',
      nodes: [
        {
          id: 'q',
          type: 'ask_question',
          data: {
            question: 'Email?',
            answerType: 'email',
            saveAs: 'email',
            retries: 1,
            timeoutMinutes: 30,
          },
        },
        { id: 'bad', type: 'send_message', data: { text: 'Never mind' } },
        { id: 'late', type: 'send_message', data: { text: 'Too slow' } },
      ],
      edges: [edge('q', 'bad', 'invalid'), edge('q', 'late', 'timeout')],
    });
    await t.say('email');
    await t.say('nope');
    await t.say('still no');
    expect((await t.texts()).at(-1)).toBe('Never mind');

    await t.say('email');
    await t.passTime();
    expect((await t.texts()).at(-1)).toBe('Too slow');
    expect((await t.runs()).map((r) => r.status)).toEqual(['completed', 'completed']);
  });

  it('saves a valid answer on the contact too', async () => {
    const t = await setup();
    await withTenant(client, { orgId: t.orgId }, (tx) =>
      tx.contactField.create({
        data: { orgId: t.orgId, key: 'city', label: 'City', type: 'text' },
      }),
    );
    await t.flow('City', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['city'] },
      startNodeId: 'q',
      nodes: [
        {
          id: 'q',
          type: 'ask_question',
          data: { question: 'City?', saveAs: 'city', contactField: 'city' },
        },
      ],
      edges: [],
    });
    await t.say('city');
    await t.say('Kochi');
    expect((await t.contact()).customFields).toEqual({ city: 'Kochi' });
  });

  it('calls an HTTP endpoint and branches on the answer', async () => {
    const t = await setup();
    const calls: { url: string; body?: string; headers: Record<string, string> }[] = [];
    let status = 200;
    t.built.deps.httpRequest = async (req) => {
      calls.push(req);
      return { status, body: JSON.stringify({ order: { state: 'shipped' } }), contentType: null };
    };
    const def = {
      trigger: { type: 'keyword' as const, matchType: 'exact' as const, keywords: ['track'] },
      startNodeId: 'q',
      nodes: [
        { id: 'q', type: 'ask_question' as const, data: { question: 'Order?', saveAs: 'id' } },
        {
          id: 'call',
          type: 'http_request' as const,
          data: {
            method: 'POST' as const,
            url: 'https://shop.example.com/orders/{{vars.id}}',
            headers: [{ name: 'X-Key', value: 'k-{{contact.phone}}' }],
            body: '{"note":"{{vars.id}}"}',
            saveResponse: { state: 'order.state' },
          },
        },
        { id: 'ok', type: 'send_message' as const, data: { text: 'It is {{vars.state}}' } },
        { id: 'bad', type: 'send_message' as const, data: { text: 'Lookup failed' } },
      ],
      edges: [edge('q', 'call'), edge('call', 'ok', 'success'), edge('call', 'bad', 'failure')],
    };
    await t.flow('Track', def);
    await t.say('track');
    await t.say('A/7 "x"');
    expect((await t.texts()).at(-1)).toBe('It is shipped');
    // Values are encoded for the URL and escaped inside JSON.
    expect(calls[0]).toMatchObject({
      url: 'https://shop.example.com/orders/A%2F7%20%22x%22',
      body: '{"note":"A/7 \\"x\\""}',
      headers: { 'x-key': `k-+${WA}`, 'content-type': 'application/json' },
    });

    status = 500;
    await t.say('track');
    await t.say('9');
    expect((await t.texts()).at(-1)).toBe('Lookup failed');
  });

  it('a failing step ends the run, or hands over when the flow says so', async () => {
    const t = await setup();
    const agent = await owner.user.create({
      data: { email: `${randomUUID()}@flows.test`, name: 'Ana', passwordHash: 'x' },
    });
    await owner.membership.create({ data: { orgId: t.orgId, userId: agent.id, role: 'agent' } });
    const missingTemplate = randomUUID();
    await t.flow('Broken', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['broken'] },
      startNodeId: 's',
      nodes: [{ id: 's', type: 'send_template', data: { templateId: missingTemplate } }],
      edges: [],
    });
    await t.say('broken');
    expect((await t.runs())[0]).toMatchObject({
      status: 'failed',
      endReason: 'error',
      error: 'The template is missing or not approved',
    });

    await t.flow('Broken but polite', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['polite'] },
      startNodeId: 's',
      nodes: [{ id: 's', type: 'send_template', data: { templateId: missingTemplate } }],
      edges: [],
      settings: { onError: 'handoff' },
    });
    await t.say('polite');
    expect((await t.runs())[1]).toMatchObject({ status: 'failed', endReason: 'error_handoff' });
    // Nobody is set to assign by default, so the flow names nobody; the thread opens for the team.
    const conversation = await withTenant(client, { orgId: t.orgId }, (tx) =>
      tx.conversation.findFirstOrThrow({}),
    );
    expect(conversation.status).toBe('open');
  });

  it('keeps running a published version after a newer one is published', async () => {
    const t = await setup();
    const { flowId } = await t.flow('V', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['v'] },
      startNodeId: 'w',
      nodes: [
        { id: 'w', type: 'wait_for_reply', data: {} },
        { id: 'say', type: 'send_message', data: { text: 'version one' } },
      ],
      edges: [edge('w', 'say')],
    });
    await t.say('v');
    const v2 = randomUUID();
    await withTenant(client, { orgId: t.orgId }, async (tx) => {
      const definition = flowDefinitionSchema.parse({
        trigger: { type: 'keyword', matchType: 'exact', keywords: ['v'] },
        startNodeId: 'say',
        nodes: [{ id: 'say', type: 'send_message', data: { text: 'version two' } }],
      });
      await tx.flowVersion.create({
        data: { id: v2, orgId: t.orgId, flowId, version: 2, definition: definition as object },
      });
      await tx.flow.update({ where: { id: flowId }, data: { publishedVersionId: v2 } });
    });
    await t.say('anything');
    expect((await t.texts()).at(-1)).toBe('version one');
    await t.say('v');
    expect((await t.texts()).at(-1)).toBe('version two');
  });
});

describe('triggers', () => {
  it('a flow takes the message ahead of keyword auto-replies, and a waiting run keeps it', async () => {
    const t = await setup();
    await withTenant(client, { orgId: t.orgId }, (tx) =>
      tx.autoReplyRule.create({
        data: {
          orgId: t.orgId,
          name: 'price',
          matchType: 'contains',
          keywords: ['price', 'start'],
          reply: 'Prices are on our site',
        },
      }),
    );
    await t.flow('Start', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['start'] },
      startNodeId: 'w',
      nodes: [
        { id: 'w', type: 'wait_for_reply', data: { saveAs: 'said' } },
        { id: 'echo', type: 'send_message', data: { text: 'You said {{vars.said}}' } },
      ],
      edges: [edge('w', 'echo')],
    });
    await t.say('start');
    await t.say('what is the price');
    expect(await t.texts()).toEqual(['You said what is the price']);
    // With no run waiting, the auto-reply answers as before.
    await t.say('price');
    expect((await t.texts()).at(-1)).toBe('Prices are on our site');
  });

  it('new contacts, ads and template buttons start their flows', async () => {
    const t = await setup();
    const reply = (text: string) => ({
      startNodeId: 's',
      nodes: [{ id: 's', type: 'send_message' as const, data: { text } }],
      edges: [],
    });
    await t.flow('Welcome', { trigger: { type: 'new_contact' }, ...reply('Welcome!') });
    await t.flow('Ad', {
      trigger: { type: 'ad_referral', sourceId: 'ad-42' },
      ...reply('From the ad'),
    });
    await t.flow('Button', {
      trigger: { type: 'template_button', templateId: null, buttonText: 'Yes please' },
      ...reply('Great, booked'),
    });

    await t.say('hello');
    await t.say('hello again');
    await t.deliver(
      t.inbound({
        text: { body: 'saw this' },
        referral: { source_id: 'ad-42', source_type: 'ad' },
      }),
    );
    await t.deliver(t.inbound({ type: 'button', button: { text: 'Yes please', payload: 'yes' } }));
    expect(await t.texts()).toEqual(['Welcome!', 'From the ad', 'Great, booked']);
  });

  it('a tag added starts its flow, once per contact when the flow says so', async () => {
    const t = await setup();
    const lead = await t.tag('lead');
    await t.flow('Lead', {
      trigger: { type: 'tag_added', tagId: lead.id },
      startNodeId: 'hi',
      nodes: [{ id: 'hi', type: 'send_message', data: { text: 'Thanks for your interest' } }],
      edges: [],
      settings: { reentry: 'once' },
    });
    await t.say('hello');
    const { id: contactId } = await t.contact();
    const fire = () =>
      processFlowJob(t.built.deps, {
        kind: 'event',
        orgId: t.orgId,
        event: { type: 'tag_added', contactId, tagId: lead.id },
      }).then(() => t.drain());
    await fire();
    await fire();
    expect(await t.texts()).toEqual(['Thanks for your interest']);
  });

  it('an opt-out ends a run, and opted-out contacts start none', async () => {
    const t = await setup();
    await t.flow('Wait', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['go'] },
      startNodeId: 'w',
      nodes: [
        { id: 'w', type: 'delay', data: { amount: 1, unit: 'days' } },
        { id: 'x', type: 'send_message', data: { text: 'later' } },
      ],
      edges: [edge('w', 'x')],
    });
    await t.say('go');
    await t.say('STOP');
    await t.passTime();
    expect((await t.runs())[0]).toMatchObject({ status: 'cancelled', endReason: 'opted_out' });
    await t.say('go');
    expect(await t.runs()).toHaveLength(1);
    expect(await t.texts()).toEqual([]);
  });

  it('runs from a crash or a lost job are found by the tick, and a run advanced twice moves once', async () => {
    const t = await setup();
    await t.flow('Twice', {
      trigger: { type: 'keyword', matchType: 'exact', keywords: ['twice'] },
      startNodeId: 'a',
      nodes: [
        { id: 'a', type: 'send_message', data: { text: 'one' } },
        { id: 'b', type: 'send_message', data: { text: 'two' } },
      ],
      edges: [edge('a', 'b')],
    });
    // The automation job starts the run, then its advance job is lost.
    const before = t.built.automation.length;
    await processMessagesChange(t.built.deps, t.orgId, t.inbound({ text: { body: 'twice' } }));
    for (const job of t.built.automation.slice(before)) await runInboxAutomation(t.built.deps, job);
    t.built.flowJobs.length = 0;
    const [run] = await t.runs();
    await Promise.all([
      advanceRun(t.built.deps, t.orgId, run!.id),
      advanceRun(t.built.deps, t.orgId, run!.id),
    ]);
    expect(await t.texts()).toEqual(['one', 'two']);
  });
});
