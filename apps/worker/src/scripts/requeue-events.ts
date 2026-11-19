/**
 * Recovery after Redis lost its data (infra/runbooks/redis.md). Webhook and billing events are
 * stored in Postgres before they are queued, so nothing is lost, but events whose jobs vanished
 * sit unprocessed. This queues them again:
 *
 *   pnpm events:requeue [hours]      (default 48)
 *
 * Uses the owner connection (DIRECT_URL), like the other operator tools, because these tables are
 * read before any workspace is known. Safe to run more than once: the job id is the event id, so
 * an event already queued is not added twice, and processing an event twice changes nothing.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createPrismaClient } from '@wacrm/db';
import { DEFAULT_JOB_OPTIONS, QueueName } from '@wacrm/shared';
import { redisConnectionFromUrl } from '@wacrm/shared/server';
import { Queue } from 'bullmq';

const rootEnv = path.resolve(__dirname, '../../../../.env');
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function main() {
  const hours = Number(process.argv[2] ?? 48);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30) {
    throw new Error('Usage: requeue-events [hours], 1 to 720');
  }
  const { DIRECT_URL, REDIS_URL } = process.env;
  if (!DIRECT_URL || !REDIS_URL) throw new Error('DIRECT_URL and REDIS_URL are required');
  const since = new Date(Date.now() - hours * 3_600_000);

  const db = createPrismaClient({ connectionString: DIRECT_URL });
  const opts = {
    connection: redisConnectionFromUrl(REDIS_URL),
    prefix: process.env.QUEUE_PREFIX ?? 'wacrm',
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  };
  const webhookQueue = new Queue(QueueName.WEBHOOK_EVENTS, opts);
  const billingQueue = new Queue(QueueName.BILLING_EVENTS, opts);
  try {
    const webhook = await db.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM webhook_events
      WHERE status IN ('received', 'routed') AND received_at >= ${since}
      ORDER BY received_at`;
    const billing = await db.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM billing_events
      WHERE status = 'received' AND received_at >= ${since}
      ORDER BY received_at`;
    for (let i = 0; i < webhook.length; i += 500) {
      await webhookQueue.addBulk(
        webhook.slice(i, i + 500).map(({ id }) => ({
          name: 'route',
          data: { eventId: id },
          opts: { jobId: id },
        })),
      );
    }
    for (let i = 0; i < billing.length; i += 500) {
      await billingQueue.addBulk(
        billing.slice(i, i + 500).map(({ id }) => ({
          name: 'process',
          data: { eventId: id },
          opts: { jobId: id },
        })),
      );
    }
    console.log(
      `Queued ${webhook.length} webhook event(s) and ${billing.length} billing event(s) from the last ${hours} hour(s).`,
    );
  } finally {
    await Promise.allSettled([webhookQueue.close(), billingQueue.close(), db.$disconnect()]);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
