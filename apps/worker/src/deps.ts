import type { PaymentProviders } from '@wacrm/billing';
import type { DbClient } from '@wacrm/db';
import type {
  CampaignJob,
  MediaDownloadJob,
  RealtimePublisher,
  TemplateSyncJob,
} from '@wacrm/shared';
import type { ObjectStorage } from '@wacrm/shared/server';
import type { WhatsAppClientFactory } from '@wacrm/whatsapp';

/** What the processors need. Injected, so tests run them without Redis or Meta. */
export interface WorkerDeps {
  db: DbClient;
  publisher: RealtimePublisher;
  storage: ObjectStorage;
  whatsapp: WhatsAppClientFactory;
  enqueueMediaDownload: (job: MediaDownloadJob) => Promise<void>;
  enqueueTemplateSync: (job: TemplateSyncJob) => Promise<void>;
  enqueueCampaignJob: (job: CampaignJob, delayMs?: number) => Promise<void>;
  /**
   * Ask to send up to `wanted` messages on this number this second. Answers how many are allowed.
   * Shares its counter with the inbox's limit, so campaigns only use what the inbox leaves.
   */
  acquireCampaignSlots: (phoneNumberId: string, wanted: number) => Promise<number>;
  payments: PaymentProviders;
  /** For a workspace whose first paid send comes from a drip. */
  defaultCurrency: string;
}

/** Thrown inside a job so BullMQ retries it with backoff. */
export class RetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableJobError';
  }
}
