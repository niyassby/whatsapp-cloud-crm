/**
 * Phase 3.4 on real Postgres. The acceptance: "Acme Tickets" below is a connector defined in this
 * file only, added to the registry like any other, and it goes through webhooks, syncs, actions in
 * a flow, OAuth refresh and health checks without any change to the framework.
 */
import { randomUUID } from 'node:crypto';
import {
  buildRegistry,
  ConnectorError,
  type ConnectorDefinition,
  hmacSha256,
  verifyHmacSha256,
} from '@wacrm/connectors';
import { type DbClient, type Prisma, withTenant } from '@wacrm/db';
import { flowDefinitionSchema, type FlowDefinitionInput, type FlowJob } from '@wacrm/shared';
import { integrationCredentialsAad } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processFlowJob } from '../src/processors/flows';
import {
  checkConnectionHealth,
  integrationDueWork,
  processIntegrationEvent,
  refreshConnection,
  runConnectorAction,
  syncConnection,
} from '../src/processors/integrations';
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

// ------------------------------------------------------------------ the config-only connector

const httpCalls: { url: string; headers: Record<string, string> }[] = [];
let ticketsAnswer: { status: number; body: unknown } = { status: 200, body: {} };

const acme: ConnectorDefinition = {
  key: 'acme_tickets',
  name: 'Acme Tickets',
  description: 'Event tickets',
  category: 'other',
  auth: {
    type: 'oauth2',
    authorizeUrl: 'https://auth.acme.test/authorize',
    tokenUrl: 'https://auth.acme.test/token',
    scopes: ['tickets'],
    clientIdEnv: 'ACME_CLIENT_ID',
    clientSecretEnv: 'ACME_CLIENT_SECRET',
  },
  triggers: [{ key: 'ticket.sold', name: 'Ticket sold', description: 'Someone bought a ticket' }],
  actions: [
    {
      key: 'seat',
      name: 'Find a seat',
      description: 'Where a ticket sits',
      input: [{ key: 'ticket', label: 'Ticket' }],
      output: ['seat'],
      async run(ctx, input) {
        const res = await ctx.http({
          method: 'GET',
          url: `https://api.acme.test/tickets/${input.ticket}`,
          headers: { authorization: `Bearer ${ctx.credentials.accessToken}` },
        });
        if (res.status === 401) throw new ConnectorError('Signed out', { reconnect: true });
        return { seat: (res.json as { seat?: string }).seat ?? null };
      },
    },
  ],
  webhook: {
    verify: (req, secret) => verifyHmacSha256(req.rawBody, secret, req.headers['x-acme-hmac']),
    deliveryId: (req) => req.headers['x-acme-delivery'] ?? null,
    map(body) {
      const b = body as { ticket?: { id: string; buyer_phone: string; buyer: string } };
      if (!b.ticket) return [];
      return [
        {
          trigger: 'ticket.sold',
          externalId: `ticket:${b.ticket.id}`,
          contact: { phone: b.ticket.buyer_phone, name: b.ticket.buyer },
          data: { ticket: b.ticket },
        },
      ];
    },
  },
  async healthCheck(ctx) {
    const res = await ctx.http({ method: 'GET', url: 'https://api.acme.test/me' });
    if (res.status === 401) throw new ConnectorError('Signed out', { reconnect: true });
    if (!res.ok) throw new ConnectorError(`Acme answered ${res.status}`);
  },
  sync: {
    everyMinutes: 30,
    async run(_ctx, cursor) {
      const page = Number(cursor ?? 0);
      return {
        events:
          page === 0
            ? [
                {
                  trigger: 'ticket.sold',
                  externalId: 'ticket:T2',
                  contact: { phone: '+91 98111 44002', name: 'Lata' },
                  data: { ticket: { id: 'T2' } },
                },
              ]
            : [],
        cursor: page + 1,
      };
    },
  },
};

async function setup() {
  const orgId = await createOrg(client);
  await connectNumber(client, orgId);
  const built = buildDeps(client);
  built.deps.connectors = buildRegistry({ demo: true, extra: [acme] });
  built.deps.env = { ACME_CLIENT_ID: 'id', ACME_CLIENT_SECRET: 'secret' };
  built.deps.allowPrivateHttp = false;
  built.deps.httpRequest = async (req) => {
    httpCalls.push({ url: req.url, headers: req.headers });
    return {
      status: ticketsAnswer.status,
      body: JSON.stringify(ticketsAnswer.body),
      contentType: 'application/json',
    };
  };

  const connect = async (
    connectorKey: string,
    credentials: Record<string, string>,
    over: Partial<Prisma.IntegrationConnectionUncheckedCreateInput> = {},
  ) => {
    const id = randomUUID();
    await withTenant(client, { orgId }, (tx) =>
      tx.integrationConnection.create({
        data: {
          id,
          orgId,
          connectorKey,
          name: connectorKey,
          credentialsEnc: built.deps.secrets.encrypt(
            JSON.stringify(credentials),
            integrationCredentialsAad(id),
          ),
          ...over,
        },
      }),
    );
    return id;
  };

  /** What the API stores for a webhook delivery. */
  const delivered = async (connectionId: string, body: unknown, dedupeKey = randomUUID()) => {
    const id = randomUUID();
    await withTenant(client, { orgId }, (tx) =>
      tx.integrationEvent.create({
        data: {
          id,
          orgId,
          connectionId,
          direction: 'inbound',
          dedupeKey,
          status: 'received',
          payload: { body, headers: {}, via: 'webhook' } as Prisma.InputJsonValue,
        },
      }),
    );
    return id;
  };

  const flow = async (def: FlowDefinitionInput) => {
    const definition = flowDefinitionSchema.parse(def);
    const flowId = randomUUID();
    const versionId = randomUUID();
    await withTenant(client, { orgId }, async (tx) => {
      await tx.flow.create({
        data: {
          id: flowId,
          orgId,
          name: 'f',
          draft: definition as object,
          active: true,
          triggerType: definition.trigger.type,
          trigger: definition.trigger as object,
        },
      });
      await tx.flowVersion.create({
        data: { id: versionId, orgId, flowId, version: 1, definition: definition as object },
      });
      await tx.flow.update({ where: { id: flowId }, data: { publishedVersionId: versionId } });
    });
  };

  const drain = async () => {
    for (let i = 0; i < 50 && built.flowJobs.length; i++) {
      const { job } = built.flowJobs.shift() as { job: FlowJob };
      await processFlowJob(built.deps, job);
    }
  };
  const tag = (name: string) =>
    withTenant(client, { orgId }, (tx) => tx.tag.create({ data: { orgId, name } }));
  const event = (id: string) =>
    withTenant(client, { orgId }, (tx) => tx.integrationEvent.findUniqueOrThrow({ where: { id } }));
  const connection = (id: string) =>
    withTenant(client, { orgId }, (tx) =>
      tx.integrationConnection.findUniqueOrThrow({ where: { id } }),
    );
  const contacts = () =>
    withTenant(client, { orgId }, (tx) => tx.contact.findMany({ include: { tags: true } }));

  return { orgId, ...built, connect, delivered, flow, drain, tag, event, connection, contacts };
}

/** A flow that tags whoever an Acme ticket was sold to: no message, so no window is needed. */
async function ticketFlow(t: Awaited<ReturnType<typeof setup>>) {
  const sold = await t.tag('ticket-buyer');
  await t.flow({
    trigger: { type: 'integration_event', connector: 'acme_tickets', event: 'ticket.sold' },
    startNodeId: 'mark',
    nodes: [{ id: 'mark', type: 'tag', data: { tagId: sold.id } }],
  });
  return sold;
}

describe('a connector added with configuration only', () => {
  it('its webhook starts a flow for a new contact, once per ticket however often it arrives', async () => {
    const t = await setup();
    const sold = await ticketFlow(t);
    const conn = await t.connect('acme_tickets', { accessToken: 'a', webhookSecret: 's' });
    const body = { ticket: { id: 'T1', buyer_phone: '+91 98111 44001', buyer: 'Kiran' } };

    const first = await t.delivered(conn, body);
    expect(await processIntegrationEvent(t.deps, t.orgId, first)).toBe('processed');
    await t.drain();
    const [contact] = await t.contacts();
    expect(contact).toMatchObject({ waId: '919811144001', name: 'Kiran' });
    expect(contact!.tags.map((x) => x.tagId)).toEqual([sold.id]);
    expect((await t.event(first)).result).toMatchObject({
      events: [{ trigger: 'ticket.sold', contactId: contact!.id, flowsStarted: 1 }],
    });

    // The same ticket again under another delivery id: claimed already, nothing starts.
    const again = await t.delivered(conn, body);
    expect(await processIntegrationEvent(t.deps, t.orgId, again)).toBe('processed');
    expect((await t.event(again)).result).toMatchObject({
      events: [{ skipped: 'Already handled' }],
    });
    // A job run twice for one event does nothing the second time.
    expect(await processIntegrationEvent(t.deps, t.orgId, first)).toBe('skipped');
    expect(t.flowJobs).toHaveLength(0);
  });

  it('ignores deliveries it cannot use, and events with no usable customer', async () => {
    const t = await setup();
    const conn = await t.connect('acme_tickets', { accessToken: 'a', webhookSecret: 's' });
    const nothing = await t.delivered(conn, { hello: 'world' });
    expect(await processIntegrationEvent(t.deps, t.orgId, nothing)).toBe('ignored');
    const noPhone = await t.delivered(conn, {
      ticket: { id: 'T9', buyer_phone: 'n/a', buyer: 'X' },
    });
    expect(await processIntegrationEvent(t.deps, t.orgId, noPhone)).toBe('processed');
    expect((await t.event(noPhone)).result).toMatchObject({
      events: [{ skipped: 'The customer has no phone number the app can use' }],
    });
    expect(await t.contacts()).toHaveLength(0);
  });

  it('its sync feeds the same pipeline, keeps its cursor, and dedupes with webhooks', async () => {
    const t = await setup();
    const sold = await ticketFlow(t);
    const conn = await t.connect('acme_tickets', { accessToken: 'a' }, { syncEveryMinutes: 30 });
    expect(await syncConnection(t.deps, t.orgId, conn)).toEqual({ events: 1 });
    expect((await t.connection(conn)).syncCursor).toBe(1);
    const [job] = t.integrationJobs;
    expect(job?.job).toMatchObject({ kind: 'event' });
    if (job?.job.kind !== 'event') throw new Error('expected an event job');
    expect(await processIntegrationEvent(t.deps, t.orgId, job.job.eventId)).toBe('processed');
    await t.drain();
    expect((await t.contacts())[0]!.tags.map((x) => x.tagId)).toEqual([sold.id]);

    // The webhook for the same ticket, arriving late, is already handled.
    const late = await t.delivered(conn, {
      ticket: { id: 'T2', buyer_phone: '+91 98111 44002', buyer: 'Lata' },
    });
    await processIntegrationEvent(t.deps, t.orgId, late);
    expect((await t.event(late)).result).toMatchObject({
      events: [{ skipped: 'Already handled' }],
    });
  });

  it('its action runs from a flow step, logs itself, and saves the result', async () => {
    const t = await setup();
    const conn = await t.connect('acme_tickets', { accessToken: 'tok' });
    ticketsAnswer = { status: 200, body: { seat: 'B12' } };
    const direct = await runConnectorAction(t.deps, t.orgId, {
      connector: 'acme_tickets',
      action: 'seat',
      input: { ticket: 'T1' },
      connectionId: null,
    });
    expect(direct).toMatchObject({ ok: true, data: { seat: 'B12' } });
    expect(httpCalls.at(-1)).toMatchObject({
      url: 'https://api.acme.test/tickets/T1',
      headers: { authorization: 'Bearer tok' },
    });
    const logged = await t.event(direct.eventId!);
    expect(logged).toMatchObject({
      direction: 'outbound',
      type: 'seat',
      status: 'succeeded',
      connectionId: conn,
    });

    const missing = await runConnectorAction(t.deps, t.orgId, {
      connector: 'acme_tickets',
      action: 'seat',
      input: {},
      connectionId: conn,
    });
    expect(missing).toMatchObject({ ok: false, error: 'Ticket is empty' });
    expect(
      await runConnectorAction(t.deps, t.orgId, {
        connector: 'nobody',
        action: 'x',
        input: {},
        connectionId: null,
      }),
    ).toMatchObject({ ok: false, error: 'No nobody connection is set up', eventId: null });
  });

  it('refreshes its OAuth token before it expires, and asks for a reconnect when refused', async () => {
    const t = await setup();
    const conn = await t.connect(
      'acme_tickets',
      { accessToken: 'old', refreshToken: 'r1' },
      { tokenExpiresAt: new Date(Date.now() + 60_000) },
    );
    expect(
      (await integrationDueWork(t.deps)).filter((d) => d.id === conn).map((d) => d.kind),
    ).toContain('refresh');
    const answers: Response[] = [
      new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }), { status: 200 }),
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ];
    t.deps.fetch = (async () => answers.shift()!) as unknown as typeof fetch;

    expect(await refreshConnection(t.deps, t.orgId, conn)).toBe('refreshed');
    const row = await t.connection(conn);
    const creds = JSON.parse(
      t.deps.secrets.decrypt(row.credentialsEnc!, integrationCredentialsAad(conn)),
    ) as Record<string, string>;
    expect(creds).toEqual({ accessToken: 'new', refreshToken: 'r1' });
    expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await refreshConnection(t.deps, t.orgId, conn)).toBe('fresh');

    const manager = await owner.user.create({
      data: { email: `${randomUUID()}@int.test`, name: 'M', passwordHash: 'x' },
    });
    await owner.membership.create({ data: { orgId: t.orgId, userId: manager.id, role: 'admin' } });
    expect(await refreshConnection(t.deps, t.orgId, conn, { force: true })).toBe('reconnect');
    expect((await t.connection(conn)).status).toBe('needs_reconnect');
    const notes = await owner.notification.findMany({
      where: { orgId: t.orgId, userId: manager.id },
    });
    expect(notes).toMatchObject([
      { kind: 'integration_needs_reconnect', title: 'Reconnect acme_tickets' },
    ]);

    // Actions on a connection that needs a person fail clearly instead of trying.
    expect(
      await runConnectorAction(t.deps, t.orgId, {
        connector: 'acme_tickets',
        action: 'seat',
        input: { ticket: 'T1' },
        connectionId: conn,
      }),
    ).toMatchObject({ ok: false, error: 'The connection needs to be reconnected' });
  });

  it('its health check marks the connection working, broken, or needing a reconnect', async () => {
    const t = await setup();
    const conn = await t.connect('acme_tickets', { accessToken: 'a' });
    ticketsAnswer = { status: 200, body: {} };
    expect(await checkConnectionHealth(t.deps, t.orgId, conn)).toBe('ok');
    expect(await t.connection(conn)).toMatchObject({ status: 'connected', lastError: null });
    ticketsAnswer = { status: 503, body: {} };
    expect(await checkConnectionHealth(t.deps, t.orgId, conn)).toBe('error');
    expect(await t.connection(conn)).toMatchObject({
      status: 'error',
      lastError: 'Acme answered 503',
    });
    ticketsAnswer = { status: 401, body: {} };
    expect(await checkConnectionHealth(t.deps, t.orgId, conn)).toBe('reconnect');
    expect((await t.connection(conn)).status).toBe('needs_reconnect');
  });
});

describe('flows use connector actions', () => {
  it('an integration step saves the result, and takes the failure exit when it fails', async () => {
    const t = await setup();
    await t.connect('acme_tickets', { accessToken: 'tok' });
    const vip = await t.tag('vip');
    const lost = await t.tag('lookup-failed');
    await t.flow({
      trigger: { type: 'integration_event', connector: 'acme_tickets', event: 'ticket.sold' },
      startNodeId: 'seat',
      nodes: [
        {
          id: 'seat',
          type: 'integration_action',
          data: {
            connector: 'acme_tickets',
            action: 'seat',
            input: { ticket: '{{trigger.data.ticket.id}}' },
            saveResponse: { seat: 'seat' },
          },
        },
        {
          id: 'front',
          type: 'condition',
          data: {
            branches: [
              {
                id: 'a',
                conditions: [
                  { kind: 'value', left: '{{vars.seat}}', op: 'starts_with', right: 'A' },
                ],
              },
            ],
          },
        },
        { id: 'tag_vip', type: 'tag', data: { tagId: vip.id } },
        { id: 'tag_lost', type: 'tag', data: { tagId: lost.id } },
      ],
      edges: [
        { id: 'e1', source: 'seat', sourceHandle: 'success', target: 'front' },
        { id: 'e2', source: 'seat', sourceHandle: 'failure', target: 'tag_lost' },
        { id: 'e3', source: 'front', sourceHandle: 'a', target: 'tag_vip' },
      ],
    });
    const conn = (
      await withTenant(client, { orgId: t.orgId }, (tx) =>
        tx.integrationConnection.findFirstOrThrow({}),
      )
    ).id;

    ticketsAnswer = { status: 200, body: { seat: 'A1' } };
    const e1 = await t.delivered(conn, {
      ticket: { id: 'T7', buyer_phone: '+91 98111 44007', buyer: 'Om' },
    });
    await processIntegrationEvent(t.deps, t.orgId, e1);
    await t.drain();
    expect(httpCalls.at(-1)!.url).toBe('https://api.acme.test/tickets/T7');

    ticketsAnswer = { status: 500, body: {} };
    t.deps.httpRequest = async () => {
      throw new Error('connection reset');
    };
    const e2 = await t.delivered(conn, {
      ticket: { id: 'T8', buyer_phone: '+91 98111 44008', buyer: 'Pia' },
    });
    await processIntegrationEvent(t.deps, t.orgId, e2);
    await t.drain();

    const byPhone = Object.fromEntries(
      (await t.contacts()).map((c) => [c.waId, c.tags.map((x) => x.tagId)]),
    );
    expect(byPhone['919811144007']).toEqual([vip.id]);
    expect(byPhone['919811144008']).toEqual([lost.id]);
  });
});

describe('the demo connector', () => {
  it('verifies the signature on the exact body', () => {
    const raw = Buffer.from('{"type":"order.created","order":{"id":"1"}}');
    const verify = buildRegistry({ demo: true }).get('demo_store')!.webhook!.verify;
    expect(
      verify(
        { rawBody: raw, headers: { 'x-demo-signature': `sha256=${hmacSha256('k', raw, 'hex')}` } },
        'k',
        {},
      ),
    ).toBe(true);
  });
});
