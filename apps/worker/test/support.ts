import { randomBytes, randomUUID } from 'node:crypto';
import { createPrismaClient, type DbClient, withTenant } from '@wacrm/db';
import { testDbUrls } from '@wacrm/db/testing';
import type {
  CampaignJob,
  MediaDownloadJob,
  RealtimePublisher,
  TemplateSyncJob,
  TenantEventMap,
} from '@wacrm/shared';
import { MemoryStorage, SecretBox } from '@wacrm/shared/server';
import { WhatsAppClientFactory, type WhatsAppError, type WhatsAppGateway } from '@wacrm/whatsapp';
import type { WorkerDeps } from '../src/deps';

export const urls = testDbUrls('wacrm_worker_test');
export const metaId = () => String(Math.floor(Math.random() * 1e15) + 1e15);

export const db = (): DbClient => createPrismaClient({ connectionString: urls.appUrl });
export const ownerDb = (): DbClient => createPrismaClient({ connectionString: urls.directUrl });

export class RecordingPublisher implements RealtimePublisher {
  events: { orgId: string; event: string; payload: unknown }[] = [];
  emit<E extends keyof TenantEventMap>(orgId: string, event: E, payload: TenantEventMap[E]) {
    this.events.push({ orgId, event, payload });
  }
  of(event: keyof TenantEventMap) {
    return this.events.filter((e) => e.event === event);
  }
}

export const metaError = (over: Partial<WhatsAppError> = {}): WhatsAppError => ({
  code: 'WA_UNKNOWN',
  message: 'Meta said no',
  retryable: false,
  metaCode: 1,
  httpStatus: 400,
  ...over,
});

/** A gateway whose responses each test scripts. Records every call. */
export function fakeGateway(phoneNumberId = 'p') {
  const calls: { method: string; args: unknown[] }[] = [];
  const templates: unknown[] = [];
  let templateError: unknown = null;
  let sendResult: () => unknown = () => ({
    data: { messageId: `wamid.OUT.${randomUUID()}`, waId: '919800000001' },
    error: null,
  });
  const send =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return sendResult();
    };
  const gateway = {
    phoneNumberId,
    wabaId: 'w',
    sendText: send('sendText'),
    sendTemplate: send('sendTemplate'),
    listTemplates: async (input: unknown) => {
      calls.push({ method: 'listTemplates', args: [input] });
      return { data: { items: templates }, error: templateError };
    },
    sendMedia: send('sendMedia'),
    uploadMedia: async (input: unknown) => {
      calls.push({ method: 'uploadMedia', args: [input] });
      return { data: { mediaId: 'uploaded-media-1' }, error: null };
    },
    downloadMedia: async (id: string) => {
      calls.push({ method: 'downloadMedia', args: [id] });
      return sendResult();
    },
  } as unknown as WhatsAppGateway;
  return {
    gateway,
    calls,
    /** What listTemplates answers with. */
    templates,
    failListing: (error: unknown) => {
      templateError = error;
    },
    respondWith: (fn: () => unknown) => {
      sendResult = fn;
    },
  };
}

export function buildDeps(client: DbClient) {
  const publisher = new RecordingPublisher();
  const storage = new MemoryStorage();
  const media: MediaDownloadJob[] = [];
  const syncs: TemplateSyncJob[] = [];
  const campaignJobs: { job: CampaignJob; delayMs?: number }[] = [];
  const webhooks: { url: string; headers: Record<string, string>; body: string }[] = [];
  let webhookResponse: () => { status: number; body: string } = () => ({ status: 200, body: 'ok' });
  const fake = fakeGateway();
  const deps: WorkerDeps = {
    db: client,
    publisher,
    storage,
    whatsapp: new WhatsAppClientFactory({
      graph: { apiVersion: 'v25.0' },
      loadCredentials: async () => ({ accessToken: 't', wabaId: 'w' }),
      createGateway: () => fake.gateway,
    }),
    enqueueMediaDownload: async (job) => {
      media.push(job);
    },
    enqueueTemplateSync: async (job) => {
      syncs.push(job);
    },
    enqueueCampaignJob: async (job, delayMs) => {
      campaignJobs.push({ job, delayMs });
    },
    acquireCampaignSlots: async (_phoneNumberId, wanted) => wanted,
    payments: {},
    secrets: new SecretBox(randomBytes(32).toString('base64')),
    postWebhook: async (url, headers, body) => {
      webhooks.push({ url, headers, body });
      return webhookResponse();
    },
    defaultCurrency: 'INR',
  };
  return {
    deps,
    publisher,
    storage,
    media,
    syncs,
    campaignJobs,
    fake,
    webhooks,
    respondToWebhooks: (fn: () => { status: number; body: string }) => {
      webhookResponse = fn;
    },
  };
}

export async function createOrg(client: DbClient) {
  const orgId = randomUUID();
  await withTenant(client, { orgId }, (tx) =>
    tx.organization.create({ data: { id: orgId, name: 'Org', slug: orgId } }),
  );
  return orgId;
}

export async function connectNumber(client: DbClient, orgId: string) {
  const wabaId = metaId();
  const phoneNumberId = metaId();
  const id = randomUUID();
  await withTenant(client, { orgId }, async (tx) => {
    const waba = await tx.wabaAccount.create({ data: { orgId, wabaId } });
    await tx.phoneNumber.create({
      data: {
        id,
        orgId,
        wabaAccountId: waba.id,
        phoneNumberId,
        status: 'connected',
        credentialSource: 'manual',
        displayPhoneNumber: '+1 555 000 1111',
      },
    });
  });
  return { id, wabaId, phoneNumberId };
}

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

/** A webhook body as Meta sends it. */
export function inboundPayload(
  phoneNumberId: string,
  message: Record<string, unknown>,
  opts: { from?: string; name?: string } = {},
) {
  const from = opts.from ?? '919800000001';
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: opts.name ?? 'Asha' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: `wamid.${randomUUID()}`,
                  timestamp: nowSeconds(),
                  type: 'text',
                  text: { body: 'Hello' },
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function statusPayload(phoneNumberId: string, status: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
              statuses: [{ timestamp: nowSeconds(), recipient_id: '919800000001', ...status }],
            },
          },
        ],
      },
    ],
  };
}
