import { randomUUID } from 'node:crypto';
import { type DbClient, withTenant } from '@wacrm/db';
import type { ContactImportOptionsInput } from '@wacrm/shared';
import { contactJobKey, normalizePhone } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processContactJob } from '../src/processors/contact-jobs';
import { processMessagesChange } from '../src/processors/inbound';
import { sendOutboundMessage } from '../src/processors/outbound';
import { buildDeps, connectNumber, createOrg, db, metaId } from './support';

let client: DbClient;

beforeAll(() => {
  client = db();
});
afterAll(async () => {
  await client.$disconnect();
});

const options = (over: Partial<ContactImportOptionsInput> = {}): ContactImportOptionsInput => ({
  columns: { phone: 'Phone', name: 'Name', email: 'Email', tags: 'Tags', fields: {} },
  ...over,
});

async function runImport(orgId: string, csv: string, opts = options()) {
  const built = buildDeps(client);
  const jobId = randomUUID();
  await built.storage.put(contactJobKey(orgId, jobId, 'source'), Buffer.from(csv), 'text/csv');
  await withTenant(client, { orgId }, (tx) =>
    tx.contactJob.create({
      data: {
        id: jobId,
        orgId,
        kind: 'import',
        options: opts as object,
      },
    }),
  );
  await processContactJob(built.deps, { orgId, jobId }, { finalAttempt: true });
  const job = await withTenant(client, { orgId }, (tx) =>
    tx.contactJob.findUniqueOrThrow({ where: { id: jobId } }),
  );
  const report = job.resultKey ? (await built.storage.get(job.resultKey)).toString() : null;
  return { job, report, ...built };
}

const contactByNumber = (orgId: string, waId: string) =>
  withTenant(client, { orgId }, (tx) =>
    tx.contact.findUniqueOrThrow({
      where: { orgId_waId: { orgId, waId } },
      include: { tags: { include: { tag: true } }, consentEvents: true },
    }),
  );

const inbound = (
  number: { wabaId: string; phoneNumberId: string },
  from: string,
  text: string,
  type: 'text' | 'image' = 'text',
) => ({
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
            contacts: [{ profile: { name: 'From WhatsApp' }, wa_id: from }],
            messages: [
              {
                from,
                id: `wamid.${randomUUID()}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type,
                ...(type === 'text'
                  ? { text: { body: text } }
                  : {
                      image: { id: metaId(), mime_type: 'image/jpeg', sha256: 'x', caption: text },
                    }),
              },
            ],
          },
        },
      ],
    },
  ],
});

describe('contact import', () => {
  it('normalizes numbers, dedupes, and reports each bad row', async () => {
    const orgId = await createOrg(client);
    const csv = [
      'Phone,Name,Email,Tags',
      '+91 98765 43210,Asha,asha@example.com,vip;lead',
      '98765 43211,Ben,,lead',
      '919876543210,Asha Again,,', // the same number as row 2
      'not-a-number,Cam,,',
      ',NoPhone,,',
      '9876543212,Dee,not-an-email,',
      '',
    ].join('\n');

    const { job, report } = await runImport(orgId, csv, options({ defaultCountry: 'IN' }));

    expect(job).toMatchObject({
      status: 'completed',
      processedRows: 6,
      createdCount: 2,
      updatedCount: 0,
      errorCount: 4,
    });
    expect(report).toContain('row,phone,error');
    expect(report).toContain('4,919876543210,Same number as row 2');
    expect(report).toContain('5,not-a-number,Not a valid phone number');
    expect(report).toContain('6,,Phone number is empty');
    expect(report).toContain('7,9876543212,Not a valid email address');

    const asha = await contactByNumber(orgId, '919876543210');
    expect(asha).toMatchObject({ name: 'Asha', email: 'asha@example.com', optInStatus: 'unknown' });
    expect(asha.tags.map((t) => t.tag.name).sort()).toEqual(['lead', 'vip']);
    expect(asha.consentEvents).toEqual([]);
  });

  it('handles a BOM, quoted commas and a malformed row', async () => {
    const orgId = await createOrg(client);
    const csv = '﻿Phone,Name\n+919876543210,"Rao, Asha"\n+919876543211,"broken\n';
    const { job } = await runImport(
      orgId,
      csv,
      options({ columns: { phone: 'Phone', name: 'Name', fields: {} } }),
    );
    expect(job.status).toBe('completed');
    expect(job.createdCount).toBe(1);
    expect((await contactByNumber(orgId, '919876543210')).name).toBe('Rao, Asha');
  });

  it('checks custom fields against their definitions', async () => {
    const orgId = await createOrg(client);
    await withTenant(client, { orgId }, (tx) =>
      tx.contactField.create({ data: { orgId, key: 'age', label: 'Age', type: 'number' } }),
    );
    const csv = 'Phone,Age\n+919876543210,41\n+919876543211,old\n';
    const { job, report } = await runImport(orgId, csv, {
      columns: { phone: 'Phone', fields: { age: 'Age' } },
    });
    expect(job).toMatchObject({ createdCount: 1, errorCount: 1 });
    expect(report).toContain('Age: must be a number');
    expect((await contactByNumber(orgId, '919876543210')).customFields).toEqual({ age: 41 });
  });

  it('updates existing contacts without blanking them, and is safe to repeat', async () => {
    const orgId = await createOrg(client);
    const first = 'Phone,Name,Email\n+919876543210,Asha,asha@example.com\n';
    await runImport(
      orgId,
      first,
      options({ columns: { phone: 'Phone', name: 'Name', email: 'Email', fields: {} } }),
    );
    const second = 'Phone,Name,Email\n+919876543210,,new@example.com\n';
    const { job } = await runImport(
      orgId,
      second,
      options({ columns: { phone: 'Phone', name: 'Name', email: 'Email', fields: {} } }),
    );
    expect(job).toMatchObject({ createdCount: 0, updatedCount: 1 });
    expect(await contactByNumber(orgId, '919876543210')).toMatchObject({
      name: 'Asha',
      email: 'new@example.com',
    });
  });

  it('records attested consent once, with proof', async () => {
    const orgId = await createOrg(client);
    const csv = 'Phone\n+919876543210\n';
    const opts = options({
      columns: { phone: 'Phone', fields: {} },
      consent: { source: 'Website form', proof: 'Signed up at example.com/join' },
    });
    await runImport(orgId, csv, opts);
    await runImport(orgId, csv, opts);
    const c = await contactByNumber(orgId, '919876543210');
    expect(c).toMatchObject({ optInStatus: 'opted_in', optInSource: 'Website form' });
    expect(c.optInAt).toBeInstanceOf(Date);
    expect(c.consentEvents).toHaveLength(1);
    expect(c.consentEvents[0]).toMatchObject({
      status: 'opted_in',
      proof: 'Signed up at example.com/join',
    });
  });

  it('never turns an opt-out back on', async () => {
    const orgId = await createOrg(client);
    await withTenant(client, { orgId }, (tx) =>
      tx.contact.create({
        data: { orgId, waId: '919876543210', optInStatus: 'opted_out', optOutAt: new Date() },
      }),
    );
    await runImport(
      orgId,
      'Phone\n+919876543210\n',
      options({
        columns: { phone: 'Phone', fields: {} },
        consent: { source: 'List', proof: 'Bought list' },
      }),
    );
    const c = await contactByNumber(orgId, '919876543210');
    expect(c.optInStatus).toBe('opted_out');
    expect(c.optInSource).toBeNull();
    expect(c.consentEvents).toEqual([]);
  });

  it('restores a deleted contact with its opt-out, and refuses a merged one', async () => {
    const orgId = await createOrg(client);
    await withTenant(client, { orgId }, async (tx) => {
      const primary = await tx.contact.create({ data: { orgId, waId: '919876543299' } });
      await tx.contact.create({
        data: {
          orgId,
          waId: '919876543210',
          optInStatus: 'opted_out',
          deletedAt: new Date(),
        },
      });
      await tx.contact.create({
        data: { orgId, waId: '919876543211', mergedIntoId: primary.id },
      });
    });
    const { job, report } = await runImport(
      orgId,
      'Phone\n+919876543210\n+919876543211\n',
      options({ columns: { phone: 'Phone', fields: {} } }),
    );
    expect(job).toMatchObject({ updatedCount: 1, errorCount: 1 });
    expect(report).toContain('merged into another contact');
    expect(await contactByNumber(orgId, '919876543210')).toMatchObject({
      deletedAt: null,
      optInStatus: 'opted_out',
    });
  });

  it('marks the job failed only on the last attempt', async () => {
    const orgId = await createOrg(client);
    const built = buildDeps(client);
    const jobId = randomUUID();
    await withTenant(client, { orgId }, (tx) =>
      tx.contactJob.create({
        data: { id: jobId, orgId, kind: 'import', options: options() as object },
      }),
    );
    // No uploaded file, so reading it fails.
    await expect(
      processContactJob(built.deps, { orgId, jobId }, { finalAttempt: false }),
    ).rejects.toThrow();
    const status = () =>
      withTenant(client, { orgId }, (tx) =>
        tx.contactJob.findUniqueOrThrow({ where: { id: jobId } }),
      );
    expect((await status()).status).toBe('processing');
    await expect(
      processContactJob(built.deps, { orgId, jobId }, { finalAttempt: true }),
    ).rejects.toThrow();
    expect(await status()).toMatchObject({ status: 'failed' });
    expect((await status()).error).toBeTruthy();
  });

  it('imports 50,000 rows without holding up other database work', async () => {
    const orgId = await createOrg(client);
    const lines = ['Phone,Name,Tags'];
    const expected = new Set<string>();
    for (let i = 0; i < 50_000; i++) {
      // Valid Indian mobile numbers: 90000 00000 and up.
      const national = String(9_000_000_000 + i);
      lines.push(`+91${national},Person ${i},${i % 2 ? 'odd' : 'even'}`);
      expected.add(`91${national}`);
    }
    expect(normalizePhone(`+91${9_000_000_000}`)).toBe('919000000000');

    // Runs while the import does. If imports held long locks or one huge transaction, these
    // small queries, standing in for inbox traffic, would stall.
    let probes = 0;
    let worstProbeMs = 0;
    let running = true;
    const probe = (async () => {
      while (running) {
        const start = Date.now();
        await withTenant(client, { orgId }, (tx) =>
          tx.contact.findFirst({ where: { waId: '919000000000' } }),
        );
        worstProbeMs = Math.max(worstProbeMs, Date.now() - start);
        probes++;
        await new Promise((r) => setTimeout(r, 25));
      }
    })();

    const { job, publisher } = await runImport(
      orgId,
      `${lines.join('\n')}\n`,
      options({ columns: { phone: 'Phone', name: 'Name', tags: 'Tags', fields: {} } }),
    );
    running = false;
    await probe;

    expect(job).toMatchObject({
      status: 'completed',
      processedRows: 50_000,
      createdCount: 50_000,
      errorCount: 0,
    });
    const counts = await withTenant(client, { orgId }, async (tx) => ({
      contacts: await tx.contact.count(),
      even: await tx.contactTag.count({ where: { tag: { name: 'even' } } }),
      odd: await tx.contactTag.count({ where: { tag: { name: 'odd' } } }),
    }));
    expect(counts).toEqual({ contacts: 50_000, even: 25_000, odd: 25_000 });
    // Progress reaches the screen batch by batch: 50 batches, plus the start and the finish.
    expect(publisher.of('contact-job:updated').length).toBeGreaterThanOrEqual(50);
    expect(probes).toBeGreaterThan(10);
    expect(worstProbeMs).toBeLessThan(5_000);
    console.info(
      `50k import: ${job.finishedAt!.getTime() - job.startedAt!.getTime()} ms; ` +
        `${probes} concurrent queries, slowest ${worstProbeMs} ms`,
    );
  }, 300_000);
});

describe('contact export', () => {
  it('writes the filtered contacts and neutralises formulas', async () => {
    const orgId = await createOrg(client);
    await withTenant(client, { orgId }, async (tx) => {
      await tx.contactField.create({ data: { orgId, key: 'plan', label: 'Plan', type: 'text' } });
      await tx.contact.create({
        data: {
          orgId,
          waId: '919876543210',
          name: '=HYPERLINK("http://evil")',
          optInStatus: 'opted_in',
          customFields: { plan: 'gold' },
        },
      });
      await tx.contact.create({ data: { orgId, waId: '919876543211', name: 'Other' } });
      await tx.contact.create({
        data: { orgId, waId: '919876543212', name: 'Gone', deletedAt: new Date() },
      });
    });
    const built = buildDeps(client);
    const jobId = randomUUID();
    await withTenant(client, { orgId }, (tx) =>
      tx.contactJob.create({
        data: { id: jobId, orgId, kind: 'export', options: { optIn: 'opted_in' } },
      }),
    );
    await processContactJob(built.deps, { orgId, jobId }, { finalAttempt: true });
    const job = await withTenant(client, { orgId }, (tx) =>
      tx.contactJob.findUniqueOrThrow({ where: { id: jobId } }),
    );
    expect(job).toMatchObject({ status: 'completed', processedRows: 1 });
    const csv = (await built.storage.get(job.resultKey!)).toString();
    const [header, row, end] = csv.split('\r\n');
    expect(header).toContain('phone,name,email,opt_in_status');
    expect(header?.endsWith(',plan')).toBe(true);
    expect(row).toContain('+919876543210');
    expect(row).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(row).toContain(',gold');
    expect(end).toBe('');
  });
});

describe('opt-out keywords', () => {
  async function setup() {
    const orgId = await createOrg(client);
    const number = await connectNumber(client, orgId);
    const built = buildDeps(client);
    return { orgId, number, ...built };
  }

  it('opts the contact out on a keyword, with proof, once', async () => {
    const { orgId, number, deps, publisher } = await setup();
    const from = '919876543210';
    await withTenant(client, { orgId }, (tx) =>
      tx.contact.create({ data: { orgId, waId: from, optInStatus: 'opted_in' } }),
    );
    const stop = inbound(number, from, ' STOP! ');
    await processMessagesChange(deps, orgId, stop);
    await processMessagesChange(deps, orgId, stop); // Meta redelivery
    await processMessagesChange(deps, orgId, inbound(number, from, 'stop')); // said it again

    const c = await contactByNumber(orgId, from);
    expect(c.optInStatus).toBe('opted_out');
    expect(c.optOutAt).toBeInstanceOf(Date);
    expect(c.consentEvents).toHaveLength(1);
    expect(c.consentEvents[0]).toMatchObject({ status: 'opted_out', source: 'keyword' });
    expect(c.consentEvents[0]?.proof).toContain('STOP');
    expect(publisher.of('contact:updated')).toHaveLength(1);
    // The message still reaches the team.
    const messages = await withTenant(client, { orgId }, (tx) => tx.message.count());
    expect(messages).toBe(2);
  });

  it('keeps consent for ordinary messages and media captions', async () => {
    const { orgId, number, deps } = await setup();
    const from = '919876543210';
    await withTenant(client, { orgId }, (tx) =>
      tx.contact.create({ data: { orgId, waId: from, optInStatus: 'opted_in' } }),
    );
    await processMessagesChange(deps, orgId, inbound(number, from, 'please stop by tomorrow'));
    await processMessagesChange(deps, orgId, inbound(number, from, 'stop', 'image'));
    expect((await contactByNumber(orgId, from)).optInStatus).toBe('opted_in');
  });

  it('uses the workspace list when it has one', async () => {
    const { orgId, number, deps } = await setup();
    await withTenant(client, { orgId }, (tx) =>
      tx.organization.update({ where: { id: orgId }, data: { optOutKeywords: ['band karo'] } }),
    );
    await processMessagesChange(deps, orgId, inbound(number, '919876543210', 'stop'));
    expect((await contactByNumber(orgId, '919876543210')).optInStatus).toBe('unknown');
    await processMessagesChange(deps, orgId, inbound(number, '919876543210', 'Band Karo'));
    expect((await contactByNumber(orgId, '919876543210')).optInStatus).toBe('opted_out');
  });
});

describe('inbound messages and contact records', () => {
  it('records activity and keeps a name someone entered', async () => {
    const orgId = await createOrg(client);
    const number = await connectNumber(client, orgId);
    const { deps } = buildDeps(client);
    await withTenant(client, { orgId }, (tx) =>
      tx.contact.create({ data: { orgId, waId: '919876543210', name: 'Entered Name' } }),
    );
    await processMessagesChange(deps, orgId, inbound(number, '919876543210', 'hi'));
    const c = await contactByNumber(orgId, '919876543210');
    expect(c.name).toBe('Entered Name');
    expect(c.lastActivityAt).toBeInstanceOf(Date);
  });

  it('fills in a missing name, and brings a deleted contact back', async () => {
    const orgId = await createOrg(client);
    const number = await connectNumber(client, orgId);
    const { deps } = buildDeps(client);
    await withTenant(client, { orgId }, (tx) =>
      tx.contact.create({
        data: { orgId, waId: '919876543210', deletedAt: new Date(), optInStatus: 'opted_out' },
      }),
    );
    await processMessagesChange(deps, orgId, inbound(number, '919876543210', 'hi'));
    expect(await contactByNumber(orgId, '919876543210')).toMatchObject({
      name: 'From WhatsApp',
      deletedAt: null,
      optInStatus: 'opted_out',
    });
  });

  it('routes messages from a merged number to the primary contact, including STOP', async () => {
    const orgId = await createOrg(client);
    const number = await connectNumber(client, orgId);
    const { deps } = buildDeps(client);
    const primaryId = await withTenant(client, { orgId }, async (tx) => {
      const primary = await tx.contact.create({
        data: { orgId, waId: '919876543299', optInStatus: 'opted_in' },
      });
      await tx.contact.create({
        data: { orgId, waId: '919876543210', mergedIntoId: primary.id },
      });
      return primary.id;
    });
    await processMessagesChange(deps, orgId, inbound(number, '919876543210', 'STOP'));
    const conversations = await withTenant(client, { orgId }, (tx) =>
      tx.conversation.findMany({ select: { contactId: true } }),
    );
    expect(conversations).toEqual([{ contactId: primaryId }]);
    expect((await contactByNumber(orgId, '919876543299')).optInStatus).toBe('opted_out');
  });
});

describe('marketing at send time', () => {
  async function queuedTemplate(status: 'unknown' | 'opted_in' | 'opted_out', category: string) {
    const orgId = await createOrg(client);
    const number = await connectNumber(client, orgId);
    const built = buildDeps(client);
    const messageId = randomUUID();
    const createdAt = new Date();
    await withTenant(client, { orgId }, async (tx) => {
      const contact = await tx.contact.create({
        data: { orgId, waId: '919876543210', optInStatus: status },
      });
      const conversation = await tx.conversation.create({
        data: { orgId, phoneId: number.id, contactId: contact.id },
      });
      await tx.message.create({
        data: {
          id: messageId,
          createdAt,
          orgId,
          conversationId: conversation.id,
          direction: 'outbound',
          type: 'template',
          status: 'queued',
          content: { templateName: 'promo', language: 'en', bodyParams: [], category },
        },
      });
    });
    const outcome = await sendOutboundMessage(
      built.deps,
      { orgId, messageId, createdAt: createdAt.toISOString() },
      { finalAttempt: true },
    );
    const message = await withTenant(client, { orgId }, (tx) =>
      tx.message.findFirstOrThrow({ where: { id: messageId } }),
    );
    return { outcome, message, calls: built.fake.calls };
  }

  it.each(['unknown', 'opted_out'] as const)('does not send marketing to %s', async (status) => {
    const { outcome, message, calls } = await queuedTemplate(status, 'MARKETING');
    expect(outcome).toBe('failed');
    expect(message.errorCode).toBe('CONTACT_NOT_OPTED_IN');
    expect(calls).toEqual([]);
  });

  it('sends marketing to an opted-in contact, and utility to anyone', async () => {
    expect((await queuedTemplate('opted_in', 'MARKETING')).outcome).toBe('sent');
    expect((await queuedTemplate('opted_out', 'UTILITY')).outcome).toBe('sent');
  });
});
