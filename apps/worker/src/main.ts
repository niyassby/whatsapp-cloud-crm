import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { createPaymentProviders } from '@wacrm/billing';
import { createPrismaClient, withTenant } from '@wacrm/db';
import {
  buildHealth,
  type AutomationJob,
  type BillingEventJob,
  type CampaignJob,
  type ContactJobQueueData,
  DEFAULT_JOB_OPTIONS,
  type MediaDownloadJob,
  type MetaAccountJob,
  orgRoom,
  type OutboundJob,
  QueueName,
  type RealtimePublisher,
  type TemplateSyncJob,
  type WebhookDeliveryJob,
  type WebhookEventJob,
} from '@wacrm/shared';
import {
  phoneTokenAad,
  redisConnectionFromUrl,
  S3Storage,
  s3ConfigFromEnv,
  SecretBox,
} from '@wacrm/shared/server';
import { WhatsAppClientFactory } from '@wacrm/whatsapp';
import { Emitter } from '@socket.io/redis-emitter';
import { DelayedError, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import type { WorkerDeps } from './deps';
import { loadWorkerEnv } from './env';
import { ensureMessagePartitions, purgeWebhookEvents } from './processors/maintenance';
import { downloadInboundMedia } from './processors/media';
import { processMetaAccountJob } from './processors/meta-account';
import { sendOutboundMessage } from './processors/outbound';
import { markEventFailed, routeWebhookEvent } from './processors/webhook-events';
import { processContactJob } from './processors/contact-jobs';
import { checkSla, runInboxAutomation, slaDueConversations } from './processors/automation';
import { processBillingEvent } from './processors/billing';
import { campaignTickTargets, runCampaignJob } from './processors/campaigns';
import { dripTargets } from './processors/drips';
import { syncTemplates, templateSyncTargets } from './processors/templates';
import {
  createWebhookPoster,
  deliverWebhook,
  dueWebhookDeliveries,
  purgeWebhookDeliveries,
} from './processors/webhook-deliveries';

const rootEnv = path.resolve(__dirname, '../../../.env');
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const env = loadWorkerEnv();
if (env.NODE_ENV === 'production' && env.WEBHOOK_ALLOW_PRIVATE_URLS) {
  throw new Error('WEBHOOK_ALLOW_PRIVATE_URLS must not be set in production');
}
const log = pino({ level: env.LOG_LEVEL, name: 'worker' });
const db = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
});

const redisOptions = redisConnectionFromUrl(env.REDIS_URL);
const queueOpts = {
  // Workers block on Redis, which BullMQ requires this setting for.
  connection: { ...redisOptions, maxRetriesPerRequest: null },
  prefix: env.QUEUE_PREFIX,
};

const redis = new Redis(redisOptions);
const socketEmitter = new Emitter(redis);
const publisher: RealtimePublisher = {
  emit: (orgId, event, payload) => {
    socketEmitter.to(orgRoom(orgId)).emit(event, payload);
  },
};

const secrets = new SecretBox(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
const mediaQueue = new Queue<MediaDownloadJob>(QueueName.MEDIA_DOWNLOAD, {
  ...queueOpts,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

const templateSyncQueue = new Queue<TemplateSyncJob>(QueueName.TEMPLATE_SYNC, {
  ...queueOpts,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

const outboundQueue = new Queue<OutboundJob>(QueueName.OUTBOUND, {
  ...queueOpts,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});
const automationQueue = new Queue<AutomationJob>(QueueName.AUTOMATION, {
  ...queueOpts,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

const webhookDeliveryQueue = new Queue<WebhookDeliveryJob>(QueueName.WEBHOOK_DELIVERIES, {
  ...queueOpts,
  // One try per job. Retries are on the delivery row, which the schedule picks up.
  defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
});

const campaignQueue = new Queue<CampaignJob>(QueueName.CAMPAIGNS, {
  ...queueOpts,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

const deps: WorkerDeps = {
  db,
  publisher,
  storage: new S3Storage(s3ConfigFromEnv(env)),
  whatsapp: new WhatsAppClientFactory({
    graph: { apiVersion: env.META_GRAPH_API_VERSION, baseUrl: env.META_GRAPH_BASE_URL },
    // Under the org's RLS context: another tenant's number is simply not found.
    loadCredentials: async ({ orgId, phoneNumberId }) => {
      const row = await withTenant(db, { orgId }, (tx) =>
        tx.phoneNumber.findFirst({
          where: { phoneNumberId, status: { not: 'disconnected' } },
          select: {
            id: true,
            accessTokenEnc: true,
            wabaAccount: { select: { wabaId: true } },
          },
        }),
      );
      if (!row?.accessTokenEnc) throw new Error('This WhatsApp number is not connected');
      return {
        accessToken: secrets.decrypt(row.accessTokenEnc, phoneTokenAad(row.id)),
        wabaId: row.wabaAccount.wabaId,
      };
    },
  }),
  enqueueMediaDownload: async (job) => {
    await mediaQueue.add('download', job, { jobId: job.messageId });
  },
  enqueueTemplateSync: async (job) => {
    await templateSyncQueue.add('sync', job);
  },
  enqueueCampaignJob: async (job, delay) => {
    await campaignQueue.add(job.kind, job, delay ? { delay } : undefined);
  },
  acquireCampaignSlots: async (phoneNumberId, wanted) => {
    const second = Math.floor(Date.now() / 1000);
    const key = `${env.QUEUE_PREFIX}:rate:send:${phoneNumberId}:${second}`;
    const result = await redis.multi().incrby(key, wanted).expire(key, 5).exec();
    const count = result?.[0]?.[1];
    if (typeof count !== 'number') return 0;
    const over = Math.max(0, count - env.CAMPAIGN_MPS_PER_NUMBER);
    const allowed = Math.max(0, wanted - over);
    // Give back what was not used, so it stays available to the inbox.
    if (allowed < wanted) await redis.decrby(key, wanted - allowed);
    return allowed;
  },
  payments: createPaymentProviders(env),
  enqueueOutbound: async (job) => {
    await outboundQueue.add('send', job, { jobId: job.messageId });
  },
  enqueueAutomation: async (job) => {
    // Keyed by message: a redelivered webhook queues it again, and the claim inside stops a rerun.
    await automationQueue.add('run', job, { jobId: `auto-${job.messageId}` });
  },
  secrets,
  postWebhook: createWebhookPoster({ allowPrivate: env.WEBHOOK_ALLOW_PRIVATE_URLS }),
  defaultCurrency: env.WALLET_DEFAULT_CURRENCY,
};

const isFinalAttempt = (job: { attemptsMade: number; opts: { attempts?: number } }) =>
  job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

const webhookWorker = new Worker<WebhookEventJob>(
  QueueName.WEBHOOK_EVENTS,
  async (job) => {
    const outcome = await routeWebhookEvent(deps, job.data.eventId);
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

/**
 * Per-number throughput: a shared one-second counter in Redis. Over the limit, the job is parked
 * and comes back later without using up an attempt.
 */
async function msUntilSendSlot(phoneNumberId: string): Promise<number> {
  const second = Math.floor(Date.now() / 1000);
  const key = `${env.QUEUE_PREFIX}:rate:send:${phoneNumberId}:${second}`;
  const result = await redis.multi().incr(key).expire(key, 5).exec();
  const count = result?.[0]?.[1];
  if (typeof count !== 'number' || count <= env.OUTBOUND_MPS_PER_NUMBER) return 0;
  return 1000 - (Date.now() % 1000) + Math.floor(Math.random() * 200);
}

const outboundWorker = new Worker<OutboundJob>(
  QueueName.OUTBOUND,
  async (job, token) => {
    const phone = await withTenant(db, { orgId: job.data.orgId }, (tx) =>
      tx.message.findUnique({
        where: {
          id_createdAt: { id: job.data.messageId, createdAt: new Date(job.data.createdAt) },
        },
        select: { conversation: { select: { phone: { select: { phoneNumberId: true } } } } },
      }),
    );
    if (phone) {
      const wait = await msUntilSendSlot(phone.conversation.phone.phoneNumberId);
      if (wait > 0) {
        await job.moveToDelayed(Date.now() + wait, token);
        throw new DelayedError();
      }
    }
    return sendOutboundMessage(deps, job.data, { finalAttempt: isFinalAttempt(job) });
  },
  { ...queueOpts, concurrency: env.WORKER_CONCURRENCY },
);
outboundWorker.on('failed', (job, err) => {
  log.warn({ jobId: job?.id, err: err.message }, 'outbound job attempt failed');
});

const mediaWorker = new Worker<MediaDownloadJob>(
  QueueName.MEDIA_DOWNLOAD,
  (job) => downloadInboundMedia(deps, job.data, { finalAttempt: isFinalAttempt(job) }),
  { ...queueOpts, concurrency: 5 },
);
mediaWorker.on('failed', (job, err) => {
  log.warn({ jobId: job?.id, err: err.message }, 'media download attempt failed');
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

// Low concurrency on its own queue: a big import uses spare capacity, never the inbox's.
const contactJobsWorker = new Worker<ContactJobQueueData>(
  QueueName.CONTACT_JOBS,
  (job) => processContactJob(deps, job.data, { finalAttempt: isFinalAttempt(job) }),
  // A 50 MB file can hold the job for minutes; a long lock stops it being taken for stalled.
  { ...queueOpts, concurrency: 2, lockDuration: 120_000 },
);
contactJobsWorker.on('failed', (job, err) => {
  log.warn({ jobId: job?.id, err: err.message }, 'contact job attempt failed');
});

const templateSyncWorker = new Worker<TemplateSyncJob>(
  QueueName.TEMPLATE_SYNC,
  async (job) => {
    const changed = await syncTemplates(deps, job.data);
    log.debug({ wabaAccountId: job.data.wabaAccountId, changed }, 'templates synced');
  },
  { ...queueOpts, concurrency: 2 },
);
templateSyncWorker.on('failed', (job, err) => {
  log.warn({ jobId: job?.id, err: err.message }, 'template sync attempt failed');
});

// Its own queue and workers: a large campaign cannot hold up webhooks or inbox sends.
const campaignWorker = new Worker<CampaignJob>(
  QueueName.CAMPAIGNS,
  (job) =>
    runCampaignJob(
      deps,
      {
        mpsPerNumber: env.CAMPAIGN_MPS_PER_NUMBER,
        maxFailureRate: env.CAMPAIGN_MAX_FAILURE_RATE,
      },
      job.data,
    ),
  { ...queueOpts, concurrency: 4, lockDuration: 120_000 },
);
campaignWorker.on('failed', (job, err) => {
  log.warn({ jobId: job?.id, err: err.message }, 'campaign job attempt failed');
});

const billingWorker = new Worker<BillingEventJob>(
  QueueName.BILLING_EVENTS,
  (job) => processBillingEvent(deps, job.data.eventId, { finalAttempt: isFinalAttempt(job) }),
  { ...queueOpts, concurrency: 5 },
);
billingWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'billing event attempt failed');
});

// Rules run in their own queue, after a message is saved, so they never slow the inbound pipeline.
const automationWorker = new Worker<AutomationJob>(
  QueueName.AUTOMATION,
  (job) => runInboxAutomation(deps, job.data),
  { ...queueOpts, concurrency: 10 },
);
automationWorker.on('failed', (job, err) => {
  log.warn({ jobId: job?.id, err: err.message }, 'automation job attempt failed');
});

// Its own queue: a customer's slow endpoint cannot hold up anything else.
const webhookDeliveryWorker = new Worker<WebhookDeliveryJob>(
  QueueName.WEBHOOK_DELIVERIES,
  (job) => deliverWebhook(deps, job.data),
  { ...queueOpts, concurrency: 10 },
);
webhookDeliveryWorker.on('failed', (job, err) => {
  log.warn({ jobId: job?.id, err: err.message }, 'webhook delivery job failed');
});

const maintenanceQueue = new Queue(QueueName.MAINTENANCE, queueOpts);
const maintenanceWorker = new Worker(
  QueueName.MAINTENANCE,
  async (job) => {
    if (job.name === 'sla-check') {
      const due = await slaDueConversations(deps);
      for (const d of due) {
        await checkSla(deps, d.org_id, d.id).catch((err: unknown) =>
          log.warn({ err: String(err), conversationId: d.id }, 'SLA check failed'),
        );
      }
      return;
    }
    if (job.name === 'webhook-dispatch') {
      const due = await dueWebhookDeliveries(deps);
      await Promise.all(
        due.map((d) =>
          webhookDeliveryQueue.add(
            'deliver',
            { orgId: d.org_id, deliveryId: d.id },
            // Unique per attempt, and the same while one waits, so this cannot queue it twice.
            { jobId: `${d.id}-${d.next_attempt_at.getTime()}` },
          ),
        ),
      );
      return;
    }
    if (job.name === 'campaign-tick') {
      // Starts scheduled campaigns and drips, and recovers any that lost their job chain.
      const targets = await campaignTickTargets(deps);
      const drips = await dripTargets(deps);
      await Promise.all([
        ...targets.map((t) =>
          deps.enqueueCampaignJob({
            kind: t.kind as 'prepare' | 'dispatch',
            orgId: t.org_id,
            campaignId: t.campaign_id,
          }),
        ),
        ...drips.map((d) =>
          deps.enqueueCampaignJob({ kind: 'drip', orgId: d.org_id, sequenceId: d.sequence_id }),
        ),
      ]);
      return;
    }
    if (job.name === 'template-reconcile') {
      const targets = await templateSyncTargets(deps);
      await Promise.all(
        targets.map((t) =>
          deps.enqueueTemplateSync({ orgId: t.org_id, wabaAccountId: t.waba_account_id }),
        ),
      );
      log.info({ wabas: targets.length }, 'template reconciliation queued');
      return;
    }
    if (job.name === 'partitions') {
      const created = await ensureMessagePartitions(db);
      log.info({ created }, 'message partitions checked');
      return;
    }
    await purgeWebhookDeliveries(deps, env.WEBHOOK_RETENTION_DAYS);
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
void maintenanceQueue
  .upsertJobScheduler('message-partitions', { pattern: '0 2 * * *' }, { name: 'partitions' })
  .catch((err: unknown) => log.error({ err: String(err) }, 'could not schedule partitions'));
void maintenanceQueue
  .upsertJobScheduler('sla-check', { every: 60_000 }, { name: 'sla-check' })
  .catch((err: unknown) => log.error({ err: String(err) }, 'could not schedule SLA checks'));
void maintenanceQueue
  .upsertJobScheduler('webhook-dispatch', { every: 5_000 }, { name: 'webhook-dispatch' })
  .catch((err: unknown) => log.error({ err: String(err) }, 'could not schedule webhooks'));
void maintenanceQueue
  .upsertJobScheduler('campaign-tick', { every: 30_000 }, { name: 'campaign-tick' })
  .catch((err: unknown) => log.error({ err: String(err) }, 'could not schedule campaign tick'));
void maintenanceQueue
  .upsertJobScheduler(
    'template-reconcile',
    { pattern: '17 * * * *' },
    { name: 'template-reconcile' },
  )
  .catch((err: unknown) => log.error({ err: String(err) }, 'could not schedule reconciliation'));
// Also at startup, so a worker that was down over a month boundary catches up immediately.
ensureMessagePartitions(db).catch((err: unknown) =>
  log.error({ err: String(err) }, 'could not ensure message partitions'),
);

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
    outboundWorker.close(),
    mediaWorker.close(),
    metaWorker.close(),
    contactJobsWorker.close(),
    templateSyncWorker.close(),
    campaignWorker.close(),
    billingWorker.close(),
    webhookDeliveryWorker.close(),
    automationWorker.close(),
    automationQueue.close(),
    outboundQueue.close(),
    webhookDeliveryQueue.close(),
    campaignQueue.close(),
    maintenanceWorker.close(),
    maintenanceQueue.close(),
    mediaQueue.close(),
    templateSyncQueue.close(),
  ]);
  redis.disconnect();
  await db.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
