import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { createPrismaClient } from '@wacrm/db';
import { buildHealth, type MetaAccountJob, QueueName, type WebhookEventJob } from '@wacrm/shared';
import { redisConnectionFromUrl } from '@wacrm/shared/server';
import { Queue, Worker } from 'bullmq';
import pino from 'pino';
import { loadWorkerEnv } from './env';
import { purgeWebhookEvents } from './processors/maintenance';
import { processMetaAccountJob } from './processors/meta-account';
import { markEventFailed, routeWebhookEvent } from './processors/webhook-events';

const rootEnv = path.resolve(__dirname, '../../../.env');
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const env = loadWorkerEnv();
const log = pino({ level: env.LOG_LEVEL, name: 'worker' });
const db = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
});

const queueOpts = {
  // Workers block on Redis, which BullMQ requires this setting for.
  connection: { ...redisConnectionFromUrl(env.REDIS_URL), maxRetriesPerRequest: null },
  prefix: env.QUEUE_PREFIX,
};

const webhookWorker = new Worker<WebhookEventJob>(
  QueueName.WEBHOOK_EVENTS,
  async (job) => {
    const outcome = await routeWebhookEvent(db, job.data.eventId);
    log.debug({ eventId: job.data.eventId, outcome }, 'webhook event handled');
    return outcome;
  },
  { ...queueOpts, concurrency: env.WORKER_CONCURRENCY },
);

// Out of attempts: record it on the row so it shows in the UI and can be replayed.
webhookWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'webhook event job failed');
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    markEventFailed(db, job.data.eventId, err.message).catch((markErr: unknown) => {
      log.error({ err: String(markErr) }, 'could not mark webhook event failed');
    });
  }
});

const metaWorker = new Worker<MetaAccountJob>(
  QueueName.META_ACCOUNT,
  async (job) => {
    const connections = await processMetaAccountJob(db, job.data);
    log.info({ kind: job.data.kind, connections }, 'meta account job handled');
  },
  queueOpts,
);
metaWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'meta account job failed');
});

const maintenanceQueue = new Queue(QueueName.MAINTENANCE, queueOpts);
const maintenanceWorker = new Worker(
  QueueName.MAINTENANCE,
  async () => {
    const purged = await purgeWebhookEvents(db, env.WEBHOOK_RETENTION_DAYS);
    log.info({ purged, retentionDays: env.WEBHOOK_RETENTION_DAYS }, 'webhook retention ran');
  },
  queueOpts,
);
maintenanceWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'maintenance job failed');
});
// Upsert: restarts and multiple workers keep a single daily schedule.
void maintenanceQueue
  .upsertJobScheduler('webhook-retention', { pattern: '0 3 * * *' }, { name: 'purge' })
  .catch((err: unknown) => log.error({ err: String(err) }, 'could not schedule retention'));

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildHealth('worker')));
    return;
  }
  res.writeHead(404).end();
});

server.listen(env.WORKER_HEALTH_PORT, () =>
  log.info({ port: env.WORKER_HEALTH_PORT }, 'worker started'),
);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  // close() waits for jobs in progress, so a deploy does not abandon work.
  await Promise.allSettled([
    webhookWorker.close(),
    metaWorker.close(),
    maintenanceWorker.close(),
    maintenanceQueue.close(),
  ]);
  await db.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
