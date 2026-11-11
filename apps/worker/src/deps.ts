import type { PaymentProviders } from '@wacrm/billing';
import type { ConnectorRegistry } from '@wacrm/connectors';
import type { DbClient } from '@wacrm/db';
import type {
  AutomationJob,
  CampaignJob,
  FlowJob,
  IntegrationJob,
  OutboundJob,
  MediaDownloadJob,
  RealtimePublisher,
  TemplateSyncJob,
} from '@wacrm/shared';
import type { ObjectStorage, SecretBox } from '@wacrm/shared/server';
import type { WhatsAppClientFactory } from '@wacrm/whatsapp';
import type { WebhookPoster } from './processors/webhook-deliveries';
import type { SafeHttp } from './safe-http';

/** What the processors need. Injected, so tests run them without Redis or Meta. */
export interface WorkerDeps {
  db: DbClient;
  publisher: RealtimePublisher;
  storage: ObjectStorage;
  whatsapp: WhatsAppClientFactory;
  enqueueMediaDownload: (job: MediaDownloadJob) => Promise<void>;
  enqueueTemplateSync: (job: TemplateSyncJob) => Promise<void>;
  enqueueCampaignJob: (job: CampaignJob, delayMs?: number) => Promise<void>;
  enqueueOutbound: (job: OutboundJob) => Promise<void>;
  enqueueAutomation: (job: AutomationJob) => Promise<void>;
  /** delayMs: run no earlier than this from now. */
  enqueueFlowJob: (job: FlowJob, delayMs?: number) => Promise<void>;
  /**
   * Ask to send up to `wanted` messages on this number this second. Answers how many are allowed.
   * Shares its counter with the inbox's limit, so campaigns only use what the inbox leaves.
   */
  acquireCampaignSlots: (phoneNumberId: string, wanted: number) => Promise<number>;
  payments: PaymentProviders;
  secrets: SecretBox;
  postWebhook: WebhookPoster;
  /** Flow HTTP steps and connectors. Same address checks as webhooks. */
  httpRequest: SafeHttp;
  /** Plain http and private addresses allowed: local tests only, refused in production. */
  allowPrivateHttp: boolean;
  /** The connectors this installation offers (packages/connectors). */
  connectors: ConnectorRegistry;
  /** For OAuth token requests to the provider a connector names. */
  fetch: typeof fetch;
  /** Where connectors' OAuth app credentials are read from. */
  env: Record<string, string | undefined>;
  enqueueIntegrationJob: (job: IntegrationJob, delayMs?: number) => Promise<void>;
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
