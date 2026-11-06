import type { DbClient } from '@wacrm/db';
import type { MediaDownloadJob, RealtimePublisher, TemplateSyncJob } from '@wacrm/shared';
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
}

/** Thrown inside a job so BullMQ retries it with backoff. */
export class RetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableJobError';
  }
}
