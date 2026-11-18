/**
 * Phase 4.4: erasing a contact leaves nothing personal anywhere (including append-only history),
 * keeps the opt-out and the counts, and cannot be aimed at another workspace; exports hold the
 * person's data and nobody else's, and never a credential; message retention blanks old content.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import {
  contactExport,
  ERASED_NAME,
  eraseContact,
  erasedAmong,
  expireOldMessages,
  exportOrgTables,
} from '../src/privacy';
import { withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;
let contactId: string;
let duplicateId: string;
let conversationId: string;
let phoneId: string;
const hash = (v: string) => `h:${v}`;

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: a.orgId, userId: a.userId }, fn);
const asB = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: b.orgId, userId: b.userId }, fn);

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  await asA(async (tx) => {
    const waba = await tx.wabaAccount.create({ data: { orgId: a.orgId, wabaId: randomUUID() } });
    const phone = await tx.phoneNumber.create({
      data: {
        orgId: a.orgId,
        wabaAccountId: waba.id,
        phoneNumberId: randomUUID(),
        status: 'connected',
        credentialSource: 'manual',
        accessTokenEnc: 'v1.secret-token-ciphertext',
      },
    });
    phoneId = phone.id;
    const channel = await tx.channel.findUniqueOrThrow({ where: { phoneId: phone.id } });
    const contact = await tx.contact.create({
      data: {
        orgId: a.orgId,
        name: 'Priya Sharma',
        waId: '919800011122',
        email: 'priya@example.com',
        customFields: { city: 'Kochi' },
        optInStatus: 'opted_in',
        optInSource: 'website form',
        optInProof: 'Ticked the box on 1 Nov, IP 10.0.0.1',
      },
    });
    contactId = contact.id;
    const dup = await tx.contact.create({
      data: { orgId: a.orgId, name: 'Priya S', waId: '919800099999', mergedIntoId: contact.id },
    });
    duplicateId = dup.id;
    await tx.contactConsentEvent.create({
      data: {
        orgId: a.orgId,
        contactId: contact.id,
        status: 'opted_in',
        source: 'website form',
        proof: 'Ticked the box on 1 Nov, IP 10.0.0.1',
      },
    });
    await tx.contactNote.create({
      data: { orgId: a.orgId, contactId: contact.id, authorId: a.userId, body: 'Allergic to nuts' },
    });
    const tag = await tx.tag.create({ data: { orgId: a.orgId, name: 'VIP' } });
    await tx.contactTag.create({ data: { orgId: a.orgId, contactId: contact.id, tagId: tag.id } });
    const conversation = await tx.conversation.create({
      data: {
        orgId: a.orgId,
        channelId: channel.id,
        phoneId: phone.id,
        contactId: contact.id,
        lastMessagePreview: 'My address is 12 MG Road',
      },
    });
    conversationId = conversation.id;
    const old = new Date(Date.now() - 400 * 86_400_000);
    await tx.message.createMany({
      data: [
        {
          id: randomUUID(),
          orgId: a.orgId,
          conversationId: conversation.id,
          direction: 'inbound',
          type: 'text',
          status: 'received',
          body: 'My address is 12 MG Road',
        },
        {
          id: randomUUID(),
          orgId: a.orgId,
          conversationId: conversation.id,
          direction: 'inbound',
          type: 'image',
          status: 'received',
          mediaKey: `orgs/${a.orgId}/messages/photo`,
          mediaFilename: 'passport.jpg',
        },
        {
          id: randomUUID(),
          orgId: a.orgId,
          conversationId: conversation.id,
          direction: 'outbound',
          type: 'template',
          status: 'read',
          body: 'Your order 1001 ships today',
          content: { templateId: randomUUID(), components: [{ text: 'Priya' }] },
        },
        {
          id: randomUUID(),
          createdAt: old,
          orgId: a.orgId,
          conversationId: conversation.id,
          direction: 'inbound',
          type: 'text',
          status: 'received',
          body: 'An old message',
        },
      ],
    });
    const flow = await tx.flow.create({ data: { orgId: a.orgId, name: 'F', draft: {} } });
    const version = await tx.flowVersion.create({
      data: { orgId: a.orgId, flowId: flow.id, version: 1, definition: {} },
    });
    const run = await tx.flowRun.create({
      data: {
        orgId: a.orgId,
        flowId: flow.id,
        versionId: version.id,
        contactId: contact.id,
        conversationId: conversation.id,
        variables: { address: '12 MG Road' },
      },
    });
    await tx.flowRunStep.create({
      data: {
        orgId: a.orgId,
        runId: run.id,
        nodeId: 'ask',
        nodeType: 'question',
        outcome: 'answered',
        detail: { answer: '12 MG Road' },
      },
    });
    await tx.aiLog.create({
      data: {
        orgId: a.orgId,
        kind: 'suggest',
        status: 'ok',
        model: 'm',
        conversationId: conversation.id,
        input: 'Customer: my address is 12 MG Road',
        output: 'We deliver there',
        inputTokens: 1,
        outputTokens: 1,
      },
    });
  });
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('export', () => {
  it('a contact export holds their details, history and messages', async () => {
    const doc = await asA((tx) => contactExport(tx, contactId));
    expect(doc.contact).toMatchObject({
      name: 'Priya Sharma',
      phone: '+919800011122',
      email: 'priya@example.com',
      tags: ['VIP'],
    });
    expect(doc.consentHistory[0]).toMatchObject({ status: 'opted_in', source: 'website form' });
    expect(doc.notes).toEqual([expect.objectContaining({ body: 'Allergic to nuts' })]);
    expect(doc.conversations[0]!.messages.map((m) => m.body)).toContain('My address is 12 MG Road');
  });

  it('a workspace export holds its own rows only, and no credential', async () => {
    let text = '';
    const counts = await exportOrgTables(
      (fn) => withTenant(app, { orgId: a.orgId }, fn),
      async (lines) => {
        text += lines;
      },
    );
    expect(counts.contacts).toBe(2);
    expect(counts.messages).toBe(4);
    const rows = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { table: string; row: Record<string, unknown> });
    expect(rows.every((r) => r.row.org_id === a.orgId)).toBe(true);
    expect(text).not.toContain('secret-token-ciphertext');
    const phone = rows.find((r) => r.table === 'phone_numbers')!.row;
    expect(phone.id).toBe(phoneId);
    expect(phone).not.toHaveProperty('access_token_enc');
  });
});

describe('erasure', () => {
  it('another workspace cannot erase this one’s contact', async () => {
    await expect(
      asB((tx) => eraseContact(tx, { orgId: b.orgId, contactId, hash })),
    ).rejects.toThrow(/not found/);
  });

  it('the history function refuses a contact that is not erased', async () => {
    await expect(
      asA((tx) => tx.$executeRaw`SELECT privacy_erase_contact_history(${contactId}::uuid)`),
    ).rejects.toThrow(/No erased contact/);
  });

  it('erases the person and their duplicate, everywhere, and keeps the opt-out', async () => {
    const result = await asA((tx) => eraseContact(tx, { orgId: a.orgId, contactId, hash }));
    expect(result).toEqual({ mediaKeys: [`orgs/${a.orgId}/messages/photo`], contacts: 2 });

    const seen = await asA(async (tx) => ({
      contacts: await tx.contact.findMany({ where: { id: { in: [contactId, duplicateId] } } }),
      messages: await tx.message.findMany({ where: { conversationId } }),
      conversation: await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } }),
      notes: await tx.contactNote.count({ where: { contactId } }),
      tags: await tx.contactTag.count({ where: { contactId } }),
      consent: await tx.contactConsentEvent.findMany({ where: { contactId } }),
      runs: await tx.flowRun.findMany({ where: { contactId } }),
      steps: await tx.flowRunStep.findMany(),
      ai: await tx.aiLog.findMany(),
      erased: await erasedAmong(tx, a.orgId, [
        hash('919800011122'),
        hash('priya@example.com'),
        hash('919800099999'),
      ]),
    }));
    for (const c of seen.contacts) {
      expect(c).toMatchObject({
        name: ERASED_NAME,
        waId: null,
        email: null,
        customFields: {},
        optInStatus: 'opted_out',
        optInProof: null,
      });
      expect(c.erasedAt).not.toBeNull();
    }
    // Every message is still there to count, with nothing it said.
    expect(seen.messages).toHaveLength(4);
    for (const m of seen.messages) {
      expect(m.body).toBeNull();
      expect(m.mediaKey).toBeNull();
      expect(m.mediaFilename).toBeNull();
    }
    const template = seen.messages.find((m) => m.type === 'template')!;
    expect(Object.keys(template.content as object).sort()).toEqual(['erased', 'templateId']);
    expect(seen.conversation.lastMessagePreview).toBeNull();
    expect([seen.notes, seen.tags]).toEqual([0, 0]);
    expect(seen.consent[0]).toMatchObject({ status: 'opted_in', source: 'erased', proof: null });
    expect(seen.runs[0]!.variables).toEqual({});
    expect(seen.steps[0]!.detail).toBeNull();
    expect(seen.ai[0]).toMatchObject({ input: '[erased]', output: '[erased]' });
    expect(seen.erased.size).toBe(3);
  });

  it('running it again changes nothing', async () => {
    expect(await asA((tx) => eraseContact(tx, { orgId: a.orgId, contactId, hash }))).toEqual({
      mediaKeys: [],
      contacts: 0,
    });
  });

  it('erased numbers cannot be read back or removed by the app', async () => {
    const rows = await asA((tx) => tx.erasedIdentity.findMany());
    expect(rows.every((r) => r.hash.startsWith('h:'))).toBe(true);
    await expect(asA((tx) => tx.erasedIdentity.deleteMany())).rejects.toThrow(/permission denied/);
    expect(await asB((tx) => tx.erasedIdentity.count())).toBe(0);
  });
});

describe('retention', () => {
  it('blanks message content older than the period, and only that', async () => {
    const other = await createTenant(owner);
    await withTenant(app, { orgId: other.orgId }, async (tx) => {
      const waba = await tx.wabaAccount.create({
        data: { orgId: other.orgId, wabaId: randomUUID() },
      });
      const phone = await tx.phoneNumber.create({
        data: {
          orgId: other.orgId,
          wabaAccountId: waba.id,
          phoneNumberId: randomUUID(),
          status: 'connected',
          credentialSource: 'manual',
        },
      });
      const channel = await tx.channel.findUniqueOrThrow({ where: { phoneId: phone.id } });
      const contact = await tx.contact.create({ data: { orgId: other.orgId, waId: '15550001' } });
      const conv = await tx.conversation.create({
        data: {
          orgId: other.orgId,
          channelId: channel.id,
          phoneId: phone.id,
          contactId: contact.id,
        },
      });
      const base = {
        orgId: other.orgId,
        conversationId: conv.id,
        direction: 'inbound' as const,
        type: 'text',
        status: 'received' as const,
      };
      await tx.message.createMany({
        data: [
          { ...base, id: randomUUID(), body: 'recent' },
          {
            ...base,
            id: randomUUID(),
            body: 'ancient',
            createdAt: new Date(Date.now() - 100 * 86_400_000),
          },
        ],
      });
      const result = await expireOldMessages(tx, 90);
      expect(result.messages).toBe(1);
      const bodies = (await tx.message.findMany({ orderBy: { createdAt: 'asc' } })).map(
        (m) => m.body,
      );
      expect(bodies).toEqual([null, 'recent']);
      expect((await expireOldMessages(tx, 90)).messages).toBe(0);
    });
  });

  it('the cross-workspace retention function refuses a cutoff under a week old', async () => {
    await expect(
      app.$queryRaw`SELECT * FROM retention_blank_old(now() - interval '1 day', 10)`,
    ).rejects.toThrow(/at least 7 days/);
    const [counts] = await app.$queryRaw<{ ai_logs: number; flow_steps: number }[]>`
      SELECT * FROM retention_blank_old(now() - interval '30 days', 10)`;
    expect(counts).toEqual({ ai_logs: 0, flow_steps: 0 });
  });
});

describe('purge', () => {
  beforeAll(async () => {
    // Fill in the kinds of rows the earlier tests did not make, including a drip step whose
    // template is held by a RESTRICT key.
    await asA(async (tx) => {
      const waba = await tx.wabaAccount.findFirstOrThrow();
      const template = await tx.messageTemplate.create({
        data: {
          orgId: a.orgId,
          wabaAccountId: waba.id,
          name: 'promo',
          language: 'en',
          category: 'MARKETING',
          status: 'APPROVED',
          definition: {},
        },
      });
      const campaign = await tx.campaign.create({
        data: {
          orgId: a.orgId,
          name: 'C',
          phoneId,
          templateId: template.id,
          audience: { type: 'segment', filter: {} },
        },
      });
      await tx.campaignRecipient.create({
        data: { orgId: a.orgId, campaignId: campaign.id, contactId, phoneId, status: 'sent' },
      });
      const seq = await tx.dripSequence.create({ data: { orgId: a.orgId, name: 'D', phoneId } });
      await tx.dripStep.create({
        data: {
          orgId: a.orgId,
          sequenceId: seq.id,
          position: 0,
          delayMinutes: 0,
          templateId: template.id,
        },
      });
      await tx.messageRef.create({
        data: {
          orgId: a.orgId,
          kind: 'wamid',
          ref: `wamid.${randomUUID()}`,
          messageId: randomUUID(),
          messageCreatedAt: new Date(),
        },
      });
      await tx.privacyRequest.create({ data: { orgId: a.orgId, kind: 'org_export' } });
      await tx.analyticsHourly.create({
        data: { orgId: a.orgId, hour: new Date('2026-11-01T10:00:00Z'), channelId: randomUUID() },
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { status: 'closed' } });
    });
  });

  const deleteOrg = (orgId: string, as: typeof asA) =>
    as((tx) => tx.$executeRaw`DELETE FROM organizations WHERE id = ${orgId}::uuid`);

  it('refuses a workspace nobody asked to delete, or one still in its waiting period', async () => {
    expect(await deleteOrg(a.orgId, asA)).toBe(0);
    await owner.organization.update({
      where: { id: a.orgId },
      data: { purgeAfter: new Date(), deletedAt: new Date() },
    });
    // Soft-deleted today: the 7 days after it have not passed.
    expect(await deleteOrg(a.orgId, asA)).toBe(0);
  });

  it('refuses another workspace’s purge', async () => {
    await owner.organization.update({
      where: { id: a.orgId },
      data: { deletedAt: new Date(Date.now() - 8 * 86_400_000) },
    });
    expect(await deleteOrg(a.orgId, asB)).toBe(0);
    const due = await app.$queryRaw<{ org_id: string }[]>`
      SELECT org_id FROM privacy_due_org_purges(now())`;
    expect(due.map((d) => d.org_id)).toContain(a.orgId);
  });

  it('removes every row of the workspace, in every tenant table, and nothing of another', async () => {
    const before = await owner.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM contacts WHERE org_id = ${b.orgId}::uuid`;
    expect(await deleteOrg(a.orgId, asA)).toBe(1);

    const tables = await owner.$queryRaw<{ table_name: string }[]>`
      SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE'
        AND c.table_name <> 'partner_ledger'`;
    const left: string[] = [];
    for (const { table_name } of tables) {
      const [row] = await owner.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${table_name}" WHERE org_id = $1::uuid`,
        a.orgId,
      );
      if (Number(row?.n ?? 0) > 0) left.push(`${table_name}: ${row?.n}`);
    }
    expect(left).toEqual([]);
    const after = await owner.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM contacts WHERE org_id = ${b.orgId}::uuid`;
    expect(after).toEqual(before);
  });
});
