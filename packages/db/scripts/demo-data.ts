/**
 * Demo data for the "demo" workspace (Phase 4.5): a bakery with a month of WhatsApp conversations,
 * contacts with tags and consent, templates, a finished campaign with sales, and report data, so
 * every screen has something to show in a demo, a screenshot or a sales call.
 *
 *   pnpm db:seed        (first: the demo workspace and its two logins)
 *   pnpm db:demo
 *
 * Development and staging only: it refuses NODE_ENV=production. The WhatsApp number is not real
 * (no token), so replies typed in the demo fail visibly unless the number is reconnected to a
 * real or fake Meta. Runs once: a second run finds the demo number and stops.
 *
 * Everything goes through the tenant context (RLS applies) and the same helpers the app uses for
 * consent, conversions and report rollups.
 */
import path from 'node:path';
import { fromMetaComponents } from '@wacrm/shared';
import { config as loadDotenv } from 'dotenv';
import { rebuildAnalytics, recordConversion } from '../src/analytics';
import { whatsappChannelId } from '../src/channels';
import { createPrismaClient } from '../src/client';
import { setContactConsent } from '../src/contacts';
import { type TenantTx, withTenant } from '../src/tenant';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const ORG = '01900000-0000-7000-8000-000000000001';
const OWNER = '01900000-0000-7000-8000-000000000101';
const AGENT = '01900000-0000-7000-8000-000000000102';
const WABA = '109900000000001';
const PHONE = '209900000000001';
const DAY = 86_400_000;

/** A small seeded generator, so every run makes the same workspace. */
let seed = 20261118;
const rand = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;

const FIRST = [
  'Aarav',
  'Ananya',
  'Arjun',
  'Diya',
  'Farah',
  'Gaurav',
  'Ishaan',
  'Kavya',
  'Lakshmi',
  'Meera',
  'Nikhil',
  'Pooja',
  'Rahul',
  'Riya',
  'Sana',
  'Siddharth',
  'Tara',
  'Varun',
  'Zoya',
  'Joseph',
] as const;
const LAST = [
  'Nair',
  'Sharma',
  'Iyer',
  'Khan',
  'Menon',
  'Reddy',
  'Das',
  'Pillai',
  'Gupta',
  'Thomas',
] as const;

const CHATS: readonly (readonly [string, string])[] = [
  [
    'Hi, do you have eggless chocolate cake today?',
    'Yes! 500 g and 1 kg are both available. Shall I keep one aside?',
  ],
  [
    'Can I order a birthday cake for Saturday?',
    'Of course. Which flavour, size and the name to write on it?',
  ],
  ['What time do you close on Sunday?', 'We are open 8 am to 1 pm on Sundays.'],
  ['Do you deliver to Kakkanad?', 'Yes, delivery to Kakkanad is free above ₹500.'],
  [
    'My order has not arrived yet',
    'Sorry about that! Checking with the rider now, one minute please.',
  ],
  ['Is the sourdough fresh today?', 'Baked this morning at 6. We have 8 loaves left.'],
  ['Can I pay by UPI on delivery?', 'Yes, the rider carries a QR code for UPI.'],
  ['Thank you, the cake was lovely!', 'So glad you liked it! Thank you for ordering with us.'],
];

const COMPONENTS = {
  order_update: [
    {
      type: 'BODY',
      text: 'Hi {{1}}, your order {{2}} is ready for pickup.',
      example: { body_text: [['Asha', '#1042']] },
    },
  ],
  weekend_offer: [
    { type: 'HEADER', format: 'TEXT', text: 'Weekend treats' },
    {
      type: 'BODY',
      text: 'Hi {{1}}, 20% off all cakes this Saturday and Sunday. Reply YES to reserve yours.',
      example: { body_text: [['Asha']] },
    },
    { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
  ],
  feedback_request: [
    {
      type: 'BODY',
      text: 'Hi {{1}}, how was your order? Reply with a number from 1 to 5.',
      example: { body_text: [['Asha']] },
    },
  ],
} as const;

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo data is not for production.');
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('DIRECT_URL is required');
  const prisma = createPrismaClient({ connectionString: url });
  const inOrg = <T>(fn: (tx: TenantTx) => Promise<T>) =>
    withTenant(prisma, { orgId: ORG, userId: OWNER }, fn, { timeout: 120_000 });

  try {
    const org = await inOrg((tx) => tx.organization.findUnique({ where: { id: ORG } }));
    if (!org) throw new Error('Run `pnpm db:seed` first: the demo workspace does not exist.');
    if (await inOrg((tx) => tx.wabaAccount.findFirst({ where: { orgId: ORG, wabaId: WABA } }))) {
      console.log('Demo data is already loaded.');
      return;
    }
    const now = Date.now();

    // Messages go back about a month; make sure those months have partitions.
    await prisma.$queryRaw`SELECT ensure_message_partitions((current_date - 40)::date, 3)`.catch(
      (err: unknown) =>
        console.warn(`Partitions not created (${String(err)}); rows use the default.`),
    );

    const { phoneId, channelId, templates, tagIds, labelIds } = await inOrg(async (tx) => {
      await tx.organization.update({
        where: { id: ORG },
        data: { name: 'Demo Bakery', timezone: 'Asia/Kolkata' },
      });
      const waba = await tx.wabaAccount.create({
        data: {
          orgId: ORG,
          wabaId: WABA,
          name: 'Demo Bakery',
          currency: 'INR',
          connectedById: OWNER,
          templatesSyncedAt: new Date(),
        },
      });
      const phone = await tx.phoneNumber.create({
        data: {
          orgId: ORG,
          wabaAccountId: waba.id,
          phoneNumberId: PHONE,
          displayPhoneNumber: '+91 98000 00001',
          verifiedName: 'Demo Bakery',
          qualityRating: 'GREEN',
          messagingTier: 'TIER_1K',
          status: 'connected',
          credentialSource: 'manual',
          registeredAt: new Date(now - 40 * DAY),
        },
      });
      const channelId = await whatsappChannelId(tx, phone.id);

      const templates: Record<string, string> = {};
      for (const [name, components] of Object.entries(COMPONENTS)) {
        const category = name === 'weekend_offer' ? 'MARKETING' : 'UTILITY';
        const parsed = fromMetaComponents(components, category);
        const t = await tx.messageTemplate.create({
          data: {
            orgId: ORG,
            wabaAccountId: waba.id,
            metaTemplateId: `demo-${name}`,
            name,
            language: 'en',
            category,
            status: name === 'feedback_request' ? 'PENDING' : 'APPROVED',
            definition: parsed.definition ?? undefined,
            samples: parsed.samples,
            variableMapping: { 'body.1': { source: 'contact', field: 'first_name' } },
            submittedAt: new Date(now - 35 * DAY),
            createdById: OWNER,
          },
        });
        templates[name] = t.id;
      }

      const tagIds: string[] = [];
      for (const [name, color] of [
        ['VIP', '#b45309'],
        ['Wholesale', '#0369a1'],
        ['New customer', '#15803d'],
        ['Birthday cakes', '#be185d'],
      ] as const) {
        tagIds.push((await tx.tag.create({ data: { orgId: ORG, name, color } })).id);
      }
      const labelIds: string[] = [];
      for (const [name, color] of [
        ['Order', '#15803d'],
        ['Delivery', '#0369a1'],
        ['Complaint', '#b91c1c'],
        ['Payment', '#7c3aed'],
      ] as const) {
        labelIds.push((await tx.label.create({ data: { orgId: ORG, name, color } })).id);
      }
      await tx.cannedReply.createMany({
        data: [
          {
            orgId: ORG,
            shortcut: 'hours',
            body: 'We are open 8 am to 9 pm, and 8 am to 1 pm on Sundays.',
            createdById: OWNER,
          },
          {
            orgId: ORG,
            shortcut: 'delivery',
            body: 'Delivery is free above ₹500 within 8 km of the shop.',
            createdById: OWNER,
          },
          {
            orgId: ORG,
            shortcut: 'thanks',
            body: 'Thank you for ordering with Demo Bakery!',
            createdById: OWNER,
          },
        ],
      });
      await tx.automationSettings.upsert({
        where: { orgId: ORG },
        update: {},
        create: {
          orgId: ORG,
          welcomeEnabled: true,
          welcomeMessage:
            'Hi! Thanks for messaging Demo Bakery. Someone will reply in a few minutes.',
          defaultAssignment: 'round_robin',
        },
      });
      return { phoneId: phone.id, channelId, templates, tagIds, labelIds };
    });

    // 60 customers over the last month.
    const contacts: { id: string; name: string; consent: string }[] = [];
    for (let i = 0; i < 60; i++) {
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const created = new Date(now - (5 + rand() * 30) * DAY);
      const consent = rand() < 0.65 ? 'opted_in' : rand() < 0.3 ? 'opted_out' : 'unknown';
      const id = await inOrg(async (tx) => {
        const c = await tx.contact.create({
          data: {
            orgId: ORG,
            waId: `9198000${String(10000 + i).padStart(5, '0')}`,
            name,
            email: rand() < 0.4 ? `${name.toLowerCase().replace(' ', '.')}${i}@example.com` : null,
            createdAt: created,
            lastActivityAt: created,
          },
        });
        if (consent !== 'unknown') {
          await setContactConsent(tx, {
            orgId: ORG,
            contactId: c.id,
            status: consent as 'opted_in' | 'opted_out',
            source: consent === 'opted_in' ? 'Website checkout' : 'WhatsApp keyword',
            proof:
              consent === 'opted_in'
                ? 'Ticked "Send me offers on WhatsApp" at checkout'
                : 'Sent STOP',
          });
        }
        const tags = tagIds.filter(() => rand() < 0.25);
        if (tags.length) {
          await tx.contactTag.createMany({
            data: tags.map((tagId) => ({ orgId: ORG, contactId: c.id, tagId })),
          });
        }
        return c.id;
      });
      contacts.push({ id, name, consent });
    }

    // Conversations: most customers wrote in; a few threads are recent and still open.
    let messages = 0;
    for (const [i, contact] of contacts.entries()) {
      if (i >= 48) break;
      const threadStart = now - (i < 8 ? rand() * 0.8 * DAY : (1 + rand() * 28) * DAY);
      const turns = 1 + Math.floor(rand() * 3);
      await inOrg(async (tx) => {
        const conv = await tx.conversation.create({
          data: {
            orgId: ORG,
            channelId,
            phoneId,
            contactId: contact.id,
            status: i < 8 ? 'open' : 'closed',
            assigneeId: i < 8 ? (i % 3 === 0 ? null : pick([OWNER, AGENT])) : pick([OWNER, AGENT]),
            createdAt: new Date(threadStart),
            openedAt: new Date(threadStart),
          },
        });
        let at = threadStart;
        let last = '';
        let lastAt = at;
        for (let t = 0; t < turns; t++) {
          const [ask, answer] = pick(CHATS);
          await tx.message.create({
            data: {
              orgId: ORG,
              conversationId: conv.id,
              direction: 'inbound',
              type: 'text',
              status: 'received',
              body: ask,
              waMessageId: `wamid.DEMO.${conv.id}.${t}`,
              createdAt: new Date(at),
            },
          });
          messages++;
          last = ask;
          lastAt = at;
          // The newest open threads are still waiting for an answer.
          if (i < 3 && t === turns - 1) break;
          at += (2 + rand() * 25) * 60_000;
          const read = at + 5 * 60_000;
          await tx.message.create({
            data: {
              orgId: ORG,
              conversationId: conv.id,
              direction: 'outbound',
              type: 'text',
              status: read < now ? 'read' : 'delivered',
              body: answer,
              senderUserId: pick([OWNER, AGENT]),
              waMessageId: `wamid.DEMO.${conv.id}.${t}.r`,
              createdAt: new Date(at),
              sentAt: new Date(at + 1000),
              deliveredAt: new Date(at + 3000),
              readAt: read < now ? new Date(read) : null,
            },
          });
          messages++;
          last = answer;
          lastAt = at;
          at += (30 + rand() * 600) * 60_000;
        }
        await tx.conversation.update({
          where: { id: conv.id },
          data: {
            lastMessageAt: new Date(lastAt),
            lastMessagePreview: last.slice(0, 120),
            unreadCount: i < 3 ? 1 : 0,
            windowExpiresAt: new Date(threadStart + DAY),
            awaitingReplySince: i < 3 ? new Date(lastAt) : null,
          },
        });
        await tx.contact.update({
          where: { id: contact.id },
          data: { lastActivityAt: new Date(lastAt) },
        });
        if (rand() < 0.6) {
          await tx.conversationLabel.create({
            data: { orgId: ORG, conversationId: conv.id, labelId: pick(labelIds) },
          });
        }
        // Closed threads get the resolution record the close trigger would have written then.
        if (i >= 8) {
          const closedAt = lastAt + (10 + rand() * 120) * 60_000;
          await tx.conversationResolution.create({
            data: {
              orgId: ORG,
              conversationId: conv.id,
              channelId,
              assigneeId: conv.assigneeId,
              openedAt: new Date(threadStart),
              closedAt: new Date(closedAt),
              seconds: Math.round((closedAt - threadStart) / 1000),
            },
          });
        }
      });
    }

    // A weekend offer sent ten days ago to everyone who agreed to marketing.
    const sentAt = now - 10 * DAY;
    const audience = contacts.filter((c) => c.consent === 'opted_in');
    await inOrg(async (tx) => {
      const campaign = await tx.campaign.create({
        data: {
          orgId: ORG,
          name: 'Weekend treats',
          status: 'completed',
          phoneId,
          templateId: templates.weekend_offer!,
          audience: { type: 'segment' },
          variableMapping: { 'body.1': { source: 'contact', field: 'first_name' } },
          startedAt: new Date(sentAt),
          finishedAt: new Date(sentAt + 4 * 60_000),
          createdById: OWNER,
          createdAt: new Date(sentAt - 3_600_000),
        },
      });
      for (const [i, c] of audience.entries()) {
        const status = i % 7 === 0 ? 'replied' : i % 3 === 0 ? 'delivered' : 'read';
        await tx.campaignRecipient.create({
          data: {
            orgId: ORG,
            campaignId: campaign.id,
            contactId: c.id,
            phoneId,
            status,
            attempts: 1,
            variables: { 'body.1': c.name.split(' ')[0] },
            sentAt: new Date(sentAt + i * 1000),
            repliedAt: status === 'replied' ? new Date(sentAt + 2 * 3_600_000) : null,
          },
        });
      }
      // Some of them ordered from the catalog afterwards: sales credited to the campaign.
      for (const [i, c] of audience.slice(0, 9).entries()) {
        await recordConversion(tx, {
          orgId: ORG,
          contactId: c.id,
          source: 'whatsapp_order',
          reference: `wamid.DEMO.order.${i}`,
          amount: String(450 + i * 120),
          currency: 'INR',
          occurredAt: new Date(sentAt + (3 + i) * 3_600_000),
        });
      }
    });

    // Report tables, as the worker's rollup would build them.
    const days = await rebuildAnalytics(inOrg, ORG, new Date(now - 35 * DAY));
    console.log(
      `Demo data loaded: ${contacts.length} contacts, 48 conversations, ${messages} messages, ` +
        `a campaign to ${audience.length} people, reports rebuilt for ${days} days.`,
    );
    console.log('Log in as owner@demo.test or agent@demo.test (see packages/db/prisma/seed.ts).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
