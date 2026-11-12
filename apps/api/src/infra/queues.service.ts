import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  type AiJob,
  type BillingEventJob,
  type FlowJob,
  type IntegrationJob,
  type CampaignJob,
  type ContactJobQueueData,
  DEFAULT_JOB_OPTIONS,
  type MetaAccountJob,
  type OutboundJob,
  QueueName,
  type TemplateSyncJob,
  type WebhookEventJob,
} from '@wacrm/shared';
import { redisConnectionFromUrl } from '@wacrm/shared/server';
import { Queue } from 'bullmq';
import { API_ENV, type ApiEnv } from '../env';

/**
 * Producer side of BullMQ. The offline queue is off so a Redis outage fails fast: the webhook
 * answers 5xx and Meta redelivers, rather than the request hanging until Meta times out.
 */
@Injectable()
export class QueuesService implements OnModuleInit, OnModuleDestroy {
  readonly webhookEvents: Queue<WebhookEventJob>;
  readonly metaAccount: Queue<MetaAccountJob>;
  readonly outbound: Queue<OutboundJob>;
  readonly contactJobs: Queue<ContactJobQueueData>;
  readonly templateSync: Queue<TemplateSyncJob>;
  readonly campaigns: Queue<CampaignJob>;
  readonly billingEvents: Queue<BillingEventJob>;
  readonly flows: Queue<FlowJob>;
  readonly integrations: Queue<IntegrationJob>;
  readonly ai: Queue<AiJob>;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    const opts = {
      connection: {
        ...redisConnectionFromUrl(env.REDIS_URL),
        enableOfflineQueue: false,
        maxRetriesPerRequest: 2,
      },
      prefix: env.QUEUE_PREFIX,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    };
    this.webhookEvents = new Queue(QueueName.WEBHOOK_EVENTS, opts);
    this.metaAccount = new Queue(QueueName.META_ACCOUNT, opts);
    this.outbound = new Queue(QueueName.OUTBOUND, opts);
    this.templateSync = new Queue(QueueName.TEMPLATE_SYNC, opts);
    this.campaigns = new Queue(QueueName.CAMPAIGNS, opts);
    this.billingEvents = new Queue(QueueName.BILLING_EVENTS, opts);
    this.flows = new Queue(QueueName.FLOWS, opts);
    this.integrations = new Queue(QueueName.INTEGRATIONS, opts);
    this.ai = new Queue(QueueName.AI, opts);
    this.contactJobs = new Queue(QueueName.CONTACT_JOBS, {
      ...opts,
      defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 3 },
    });
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([
      this.webhookEvents.waitUntilReady(),
      this.metaAccount.waitUntilReady(),
      this.outbound.waitUntilReady(),
      this.contactJobs.waitUntilReady(),
      this.templateSync.waitUntilReady(),
      this.campaigns.waitUntilReady(),
      this.billingEvents.waitUntilReady(),
      this.flows.waitUntilReady(),
      this.integrations.waitUntilReady(),
      this.ai.waitUntilReady(),
    ]);
  }

  /** Compare a WABA's templates with Meta, for example after connecting a number. */
  async enqueueTemplateSync(job: TemplateSyncJob): Promise<void> {
    await this.templateSync.add('sync', job);
  }

  /** Job id = event id: a redelivery cannot queue the same event twice. */
  async enqueueBillingEvent(eventId: string): Promise<void> {
    await this.billingEvents.add('process', { eventId }, { jobId: eventId });
  }

  /** Integration work for the worker. An event's job id is its row id, so it is queued once. */
  async enqueueIntegrationJob(job: IntegrationJob): Promise<void> {
    const jobId = job.kind === 'event' ? `integration-event-${job.eventId}` : undefined;
    await this.integrations.add(job.kind, job, { jobId });
  }

  /** Index a knowledge document (also after an edit or a reindex request). */
  async enqueueAiJob(job: AiJob): Promise<void> {
    await this.ai.add(job.kind, job, { jobId: `ai-${job.kind}-${job.documentId}-${Date.now()}` });
  }

  /** Events that start flows: a tag added, a flow started by hand. */
  async enqueueFlowJob(job: FlowJob): Promise<void> {
    await this.flows.add(job.kind, job);
  }

  async enqueueCampaignJob(job: CampaignJob): Promise<void> {
    await this.campaigns.add(job.kind, job);
  }

  /** Job id = contact job id, so one import cannot be queued twice. */
  async enqueueContactJob(job: ContactJobQueueData): Promise<void> {
    await this.contactJobs.add('run', job, { jobId: job.jobId });
  }

  /** Job id = event id: a redelivery or retry cannot queue the same event twice. */
  async enqueueWebhookEvent(eventId: string): Promise<void> {
    await this.webhookEvents.add('route', { eventId }, { jobId: eventId });
  }

  /** Replays need a fresh job id, since the original job may still exist. */
  async enqueueReplay(eventId: string): Promise<void> {
    await this.webhookEvents.add('route', { eventId }, { jobId: `${eventId}-r${Date.now()}` });
  }

  /** Job id = message id: a retried request cannot queue the same message twice. */
  async enqueueOutbound(job: OutboundJob): Promise<void> {
    await this.outbound.add('send', job, { jobId: job.messageId });
  }

  async enqueueMetaAccount(job: MetaAccountJob): Promise<void> {
    await this.metaAccount.add(job.kind, job);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      this.webhookEvents.close(),
      this.metaAccount.close(),
      this.outbound.close(),
      this.contactJobs.close(),
      this.templateSync.close(),
      this.campaigns.close(),
      this.billingEvents.close(),
      this.flows.close(),
      this.integrations.close(),
      this.ai.close(),
    ]);
  }
}
