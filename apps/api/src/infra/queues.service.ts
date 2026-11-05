import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  DEFAULT_JOB_OPTIONS,
  type MetaAccountJob,
  QueueName,
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
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([this.webhookEvents.waitUntilReady(), this.metaAccount.waitUntilReady()]);
  }

  /** Job id = event id: a redelivery or retry cannot queue the same event twice. */
  async enqueueWebhookEvent(eventId: string): Promise<void> {
    await this.webhookEvents.add('route', { eventId }, { jobId: eventId });
  }

  /** Replays need a fresh job id, since the original job may still exist. */
  async enqueueReplay(eventId: string): Promise<void> {
    await this.webhookEvents.add('route', { eventId }, { jobId: `${eventId}-r${Date.now()}` });
  }

  async enqueueMetaAccount(job: MetaAccountJob): Promise<void> {
    await this.metaAccount.add(job.kind, job);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.webhookEvents.close(), this.metaAccount.close()]);
  }
}
