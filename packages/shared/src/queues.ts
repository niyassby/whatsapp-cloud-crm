/** BullMQ queue names and job payloads shared by the API (producer) and worker (consumer). */
export const QueueName = {
  /** One job per webhook_events row. */
  WEBHOOK_EVENTS: 'webhook-events',
  /** Meta deauthorization and data deletion callbacks. */
  META_ACCOUNT: 'meta-account',
  /** Every outbound WhatsApp message. */
  OUTBOUND: 'outbound-messages',
  /** Copy inbound media from Meta to object storage before Meta's URL expires. */
  MEDIA_DOWNLOAD: 'media-download',
  /** Repeatable housekeeping (retention, message partitions). */
  MAINTENANCE: 'maintenance',
  /** Contact imports and exports. Their own queue, so a big file cannot delay the inbox. */
  CONTACT_JOBS: 'contact-jobs',
  /** Compare a WABA's templates with Meta. */
  TEMPLATE_SYNC: 'template-sync',
  /** Campaigns and drips. Separate from OUTBOUND, so a big send cannot delay the inbox. */
  CAMPAIGNS: 'campaigns',
  BILLING_EVENTS: 'billing-events',
  WEBHOOK_DELIVERIES: 'webhook-deliveries',
  AUTOMATION: 'automation',
} as const;

/** One inbound message to run the rules on. */
export interface AutomationJob {
  orgId: string;
  messageId: string;
  createdAt: string;
}

export interface WebhookDeliveryJob {
  orgId: string;
  deliveryId: string;
}

export interface BillingEventJob {
  eventId: string;
}

export type CampaignJob =
  | { kind: 'prepare'; orgId: string; campaignId: string }
  | { kind: 'dispatch'; orgId: string; campaignId: string }
  | { kind: 'drip'; orgId: string; sequenceId: string };

export interface TemplateSyncJob {
  orgId: string;
  wabaAccountId: string;
}

export interface ContactJobQueueData {
  orgId: string;
  jobId: string;
}

export interface WebhookEventJob {
  eventId: string;
}

/** createdAt locates the partition; ISO string. */
export interface OutboundJob {
  orgId: string;
  messageId: string;
  createdAt: string;
}

export interface MediaDownloadJob {
  orgId: string;
  messageId: string;
  createdAt: string;
  metaMediaId: string;
  phoneNumberId: string;
}

export type MetaAccountJob =
  | { kind: 'deauthorize'; metaUserId: string }
  | { kind: 'data_deletion'; metaUserId: string; requestId: string };

/** Retries with exponential backoff; completed jobs are trimmed so Redis stays small. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 86_400 },
} as const;
