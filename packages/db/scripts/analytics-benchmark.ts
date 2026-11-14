/**
 * Phase 4.3 acceptance: report queries stay under 1 second on a seeded dataset of 5 million
 * messages.
 *
 *   pnpm --filter @wacrm/db bench:analytics            # 5,000,000 messages (about 10 minutes)
 *   pnpm --filter @wacrm/db bench:analytics -- 500000  # a smaller run
 *   pnpm --filter @wacrm/db bench:analytics -- --reuse # the data from the last run, re-rolled up
 *
 * Recreates the database `wacrm_bench_test` (never a real one), seeds one large workspace with
 * 80% of the messages and four smaller ones with the rest, over 180 days, then runs the rollup
 * the worker runs and times every report over 30, 90 and 180 days as the app role, under RLS.
 * Exits 1 if any report takes 1 second or more.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { createPrismaClient } from '../src/client';
import { buildReport, rebuildAnalytics, rollupAnalytics } from '../src/analytics';
import { withTenant } from '../src/tenant';
import { prepareTestDatabase, testDbUrls } from '../src/testing';
import { REPORT_KINDS, lastDays } from '@wacrm/shared';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const TOTAL = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 5_000_000);
const PER_CONVERSATION = 20;
const DAYS = 180;
const TZ = 'Asia/Kolkata';
const LIMIT_MS = 1000;

const urls = testDbUrls('wacrm_bench_test');
const elapsed = (start: number) => `${((Date.now() - start) / 1000).toFixed(1)}s`;

async function seedOrg(pg: Client, index: number, messages: number): Promise<string> {
  const conversations = Math.max(1, Math.round(messages / PER_CONVERSATION));
  const { rows } = await pg.query<{
    org_id: string;
    channel_id: string;
    phone_id: string;
    template_id: string;
  }>(
    `
    WITH org AS (
      INSERT INTO organizations (id, name, slug, timezone, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, now()) RETURNING id
    ), waba AS (
      INSERT INTO waba_accounts (id, org_id, waba_id, updated_at)
      SELECT gen_random_uuid(), id, $2, now() FROM org RETURNING id, org_id
    ), phone AS (
      INSERT INTO phone_numbers (id, org_id, waba_account_id, phone_number_id, status,
                                 credential_source, verified_name, updated_at)
      SELECT gen_random_uuid(), org_id, id, $2, 'connected', 'manual', $1, now() FROM waba
      RETURNING id, org_id, waba_account_id
    ), template AS (
      INSERT INTO message_templates (id, org_id, waba_account_id, name, language, category,
                                     status, definition, updated_at)
      SELECT gen_random_uuid(), org_id, waba_account_id, 'order_update', 'en', 'UTILITY',
             'APPROVED', '{}'::jsonb, now() FROM phone
      RETURNING id
    )
    SELECT phone.org_id, phone.id AS phone_id, template.id AS template_id,
           NULL::uuid AS channel_id
    FROM phone, template`,
    [`Bench ${index}`, `bench-${index}-${Date.now()}`, TZ],
  );
  const org = rows[0]!;
  const channel = await pg.query<{ id: string }>(`SELECT id FROM channels WHERE phone_id = $1`, [
    org.phone_id,
  ]);
  const channelId = channel.rows[0]!.id;

  // Ten people, most of them agents.
  await pg.query(
    `
    WITH u AS (
      INSERT INTO users (id, email, name, password_hash, updated_at)
      SELECT gen_random_uuid(), 'agent' || g || '-' || $2 || '@bench.test', 'Agent ' || g, 'x', now()
      FROM generate_series(1, 10) g RETURNING id
    )
    INSERT INTO memberships (id, org_id, user_id, role, updated_at)
    SELECT gen_random_uuid(), $1, id, 'agent', now() FROM u`,
    [org.org_id, `${index}-${Date.now()}`],
  );

  await pg.query(
    `
    INSERT INTO contacts (id, org_id, name, wa_id, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'Customer ' || g, (919000000000 + $2::bigint * 10000000 + g)::text,
           now(), now()
    FROM generate_series(1, $3) g`,
    [org.org_id, index, conversations],
  );
  await pg.query(
    `
    INSERT INTO conversations (id, org_id, channel_id, phone_id, contact_id, status, created_at,
                               opened_at, last_message_at, updated_at)
    SELECT gen_random_uuid(), $1, $2, $3, c.id,
           (CASE WHEN random() < 0.8 THEN 'closed' ELSE 'open' END)::"ConversationStatus",
           t, t, t + interval '140 minutes', now()
    FROM (
      SELECT id, now() - interval '1 day' * $4 * random() - interval '3 hours' AS t
      FROM contacts WHERE org_id = $1
    ) c`,
    [org.org_id, channelId, org.phone_id, DAYS],
  );

  // Messages in batches of conversations, so progress shows and no statement is huge. Each
  // conversation: customer, customer, a person, then software (one in four a template).
  const users = (
    await pg.query<{ user_id: string }>(`SELECT user_id FROM memberships WHERE org_id = $1`, [
      org.org_id,
    ])
  ).rows.map((r) => r.user_id);
  const ids = (
    await pg.query<{ id: string }>(`SELECT id FROM conversations WHERE org_id = $1 ORDER BY id`, [
      org.org_id,
    ])
  ).rows.map((r) => r.id);
  const batch = 20_000;
  for (let i = 0; i < ids.length; i += batch) {
    await pg.query(
      `
      INSERT INTO messages (id, created_at, org_id, conversation_id, direction, type, status,
                            body, content, sender_user_id, updated_at)
      SELECT gen_random_uuid(),
             c.created_at + j * interval '7 minutes' + random() * interval '5 minutes',
             c.org_id, c.id,
             (CASE WHEN j % 4 IN (0, 1) THEN 'inbound' ELSE 'outbound' END)::"MessageDirection",
             CASE WHEN j % 4 = 3 AND j % 8 = 3 THEN 'template' ELSE 'text' END,
             (CASE WHEN j % 4 IN (0, 1) THEN 'received'
                   WHEN random() < 0.05 THEN 'failed'
                   WHEN random() < 0.6 THEN 'read' ELSE 'delivered' END)::"MessageStatus",
             'Message ' || j,
             CASE WHEN j % 4 = 3 AND j % 8 = 3 THEN jsonb_build_object('templateId', $3::text) END,
             CASE WHEN j % 4 = 2 THEN ($2::uuid[])[1 + abs(hashtext(c.id::text)) % 10] END,
             now()
      FROM conversations c CROSS JOIN generate_series(0, $4 - 1) j
      WHERE c.id = ANY($1::uuid[])`,
      [ids.slice(i, i + batch), users, org.template_id, PER_CONVERSATION],
    );
  }

  // Closures, ad clicks, campaigns and sales, at proportional sizes.
  await pg.query(
    `
    INSERT INTO conversation_resolutions (id, org_id, conversation_id, channel_id, assignee_id,
                                          opened_at, closed_at, seconds)
    SELECT gen_random_uuid(), org_id, id, channel_id, ($2::uuid[])[1 + abs(hashtext(id::text)) % 10],
           created_at, last_message_at + interval '30 minutes', 10200
    FROM conversations WHERE org_id = $1 AND status = 'closed'`,
    [org.org_id, users],
  );
  await pg.query(
    `
    INSERT INTO ad_referrals (id, org_id, conversation_id, contact_id, channel_kind, source_type,
                              source_id, headline, new_contact, message_id, message_created_at)
    SELECT gen_random_uuid(), org_id, id, contact_id, 'whatsapp', 'ad',
           'ad-' || (abs(hashtext(id::text)) % 20), 'Ad ' || (abs(hashtext(id::text)) % 20), true,
           gen_random_uuid(), created_at
    FROM conversations WHERE org_id = $1 AND random() < 0.05`,
    [org.org_id],
  );
  const campaigns = Math.max(1, Math.round(30 * (messages / (TOTAL * 0.8))));
  await pg.query(
    `
    WITH c AS (
      INSERT INTO campaigns (id, org_id, name, status, phone_id, template_id, audience, started_at,
                             created_at, updated_at)
      SELECT gen_random_uuid(), $1, 'Campaign ' || g, 'completed', $2, $3, '{}'::jsonb,
             now() - interval '1 day' * $4 * g / $5, now(), now()
      FROM generate_series(1, $5) g RETURNING id, started_at
    )
    INSERT INTO campaign_recipients (id, org_id, campaign_id, contact_id, phone_id, status, sent_at,
                                     created_at, updated_at)
    SELECT gen_random_uuid(), $1, c.id, k.id, $2,
           (ARRAY['sent','delivered','read','replied','failed','skipped'])[1 + abs(hashtext(k.id::text || c.id::text)) % 6]::"CampaignRecipientStatus",
           c.started_at, now(), now()
    FROM c CROSS JOIN LATERAL (
      SELECT id FROM contacts WHERE org_id = $1 ORDER BY hashtext(id::text || c.id::text) LIMIT 10000
    ) k`,
    [org.org_id, org.phone_id, org.template_id, DAYS, campaigns],
  );
  await pg.query(
    `
    INSERT INTO conversions (id, org_id, contact_id, source, reference, amount_micros, currency,
                             occurred_at, campaign_id, ad_source_id)
    SELECT gen_random_uuid(), r.org_id, r.contact_id, 'store_order', 'order-' || r.id,
           499000000, 'INR', r.sent_at + interval '1 hour', r.campaign_id, NULL
    FROM campaign_recipients r WHERE r.org_id = $1 AND r.status = 'replied'`,
    [org.org_id],
  );
  await pg.query(
    `INSERT INTO wallets (id, org_id, currency, updated_at) VALUES (gen_random_uuid(), $1, 'INR', now())`,
    [org.org_id],
  );
  return org.org_id;
}

async function main() {
  const started = Date.now();
  // --reuse keeps the data from an earlier run: newer migrations are applied, the seed is
  // skipped, and the rollup and timings run again.
  const reuse = process.argv.includes('--reuse');
  let orgs: string[] = [];
  let pg: Client;
  if (reuse) {
    console.log('Reusing wacrm_bench_test…');
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, DIRECT_URL: urls.directUrl },
        stdio: 'pipe',
      },
    );
    pg = new Client({ connectionString: urls.directUrl });
    await pg.connect();
    orgs = (
      await pg.query<{ org_id: string }>(
        'SELECT org_id FROM conversations GROUP BY 1 ORDER BY count(*) DESC',
      )
    ).rows.map((r) => r.org_id);
  } else {
    console.log(`Preparing wacrm_bench_test for ${TOTAL.toLocaleString()} messages…`);
    await prepareTestDatabase(urls);
    pg = new Client({ connectionString: urls.directUrl });
    await pg.connect();
    await pg.query(`SELECT ensure_message_partitions((current_date - ${DAYS + 31})::date, 9)`);

    const big = Math.round(TOTAL * 0.8);
    const small = Math.round((TOTAL - big) / 4);
    for (const [i, n] of [big, small, small, small, small].entries()) {
      const t = Date.now();
      orgs.push(await seedOrg(pg, i, n));
      console.log(`  workspace ${i}: ${n.toLocaleString()} messages seeded in ${elapsed(t)}`);
    }
  }
  await pg.query('ANALYZE');
  const count = await pg.query<{ n: string }>('SELECT count(*) AS n FROM messages');
  console.log(
    `${Number(count.rows[0]!.n).toLocaleString()} messages ${reuse ? 'in the database' : 'seeded'} (${elapsed(started)})`,
  );

  const app = createPrismaClient({ connectionString: urls.appUrl });
  const rollupStart = Date.now();
  const since = new Date(Date.now() - (DAYS + 1) * 86_400_000);
  for (const orgId of orgs) {
    await rebuildAnalytics(
      (fn) => withTenant(app, { orgId }, fn, { timeout: 300_000 }),
      orgId,
      since,
    );
  }
  await pg.query('ANALYZE');
  console.log(`Rollup of ${DAYS} days for every workspace: ${elapsed(rollupStart)}`);

  // A five-minute rollup pass on the large workspace, as the worker runs it.
  const tick = Date.now();
  await withTenant(
    app,
    { orgId: orgs[0]! },
    (tx) => rollupAnalytics(tx, orgs[0]!, new Date(Date.now() - 3 * 3_600_000), new Date()),
    { timeout: 120_000 },
  );
  console.log(`One recent-hours rollup pass on the large workspace: ${Date.now() - tick} ms`);

  const results: { report: string; days: number; ms: number }[] = [];
  for (const days of [30, 90, 180]) {
    for (const kind of REPORT_KINDS) {
      const range = lastDays(days, TZ);
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        await withTenant(app, { orgId: orgs[0]! }, (tx) => buildReport(tx, orgs[0]!, kind, range));
        times.push(performance.now() - t);
      }
      // The first run warms the cache; report the slower of the other two.
      results.push({ report: kind, days, ms: Math.round(Math.max(times[1]!, times[2]!)) });
    }
  }
  console.table(results);
  const slow = results.filter((r) => r.ms >= LIMIT_MS);
  await app.$disconnect();
  await pg.end();
  if (slow.length) {
    console.error(`FAIL: ${slow.length} report(s) at or over ${LIMIT_MS} ms`);
    process.exit(1);
  }
  console.log(`PASS: every report under ${LIMIT_MS} ms. Total ${elapsed(started)}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
