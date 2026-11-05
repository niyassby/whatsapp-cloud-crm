/** BullMQ queue names and job payloads shared by the API (producer) and worker (consumer). */
export const QueueName = {
  /** One job per webhook_events row. */
  WEBHOOK_EVENTS: 'webhook-events',
  /** Meta deauthorization and data deletion callbacks. */
  META_ACCOUNT: 'meta-account',
  /** Repeatable housekeeping (webhook_events retention). */
  MAINTENANCE: 'maintenance',
} as const;

export interface WebhookEventJob {
  eventId: string;
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
