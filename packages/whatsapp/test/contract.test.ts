/**
 * Contract for WhatsAppGateway, independent of how it is implemented. If wapi-cloud is ever
 * swapped or forked, this file must pass unchanged: it pins the HTTP requests sent to Graph,
 * the shape returned to the app, and the shape of parsed webhook events.
 */
import { createHmac } from 'node:crypto';
import { WhatsAppErrorCode as C } from '@wacrm/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GraphClient,
  InvalidSignedRequestError,
  parseSignedRequest,
  parseWebhookEvents,
  splitWebhookPayload,
  verifyWebhookChallenge,
  verifyWebhookSignature,
  WapiCloudGateway,
} from '../src';
import {
  graphError,
  inboundImage,
  inboundText,
  multiTenantDelivery,
  PHONE_ID,
  statusFailed,
  templateStatus,
  WABA_ID,
} from './fixtures';

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  auth: string | null;
}
type Reply = { status?: number; body: unknown };

/** Fake Graph API: records requests and answers from a queue. */
function fakeGraph() {
  const calls: Call[] = [];
  const replies: Reply[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: typeof raw === 'string' ? JSON.parse(raw) : (raw ?? null),
      auth: headers.get('authorization'),
    });
    const reply = replies.shift() ?? { body: {} };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, replies, fetchImpl };
}

const VERSION = 'v25.0';
const TOKEN = 'token-for-tests-1234567890';
const sentReply = {
  body: {
    messaging_product: 'whatsapp',
    contacts: [{ input: '919800000001', wa_id: '919800000001' }],
    messages: [{ id: 'wamid.OUT1' }],
  },
};

let graph: ReturnType<typeof fakeGraph>;
let gateway: WapiCloudGateway;

beforeEach(() => {
  graph = fakeGraph();
  gateway = new WapiCloudGateway({
    phoneNumberId: PHONE_ID,
    credentials: { accessToken: TOKEN, wabaId: WABA_ID },
    graph: { apiVersion: VERSION, fetch: graph.fetchImpl },
  });
});

describe('sending', () => {
  it('sendText posts to the pinned version with the bearer token', async () => {
    graph.replies.push(sentReply);
    const res = await gateway.sendText(
      '919800000001',
      { body: 'Hi' },
      { replyToMessageId: 'wamid.X', callbackData: 'msg-1' },
    );
    expect(res).toEqual({ data: { messageId: 'wamid.OUT1', waId: '919800000001' }, error: null });
    const call = graph.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe(`/${VERSION}/${PHONE_ID}/messages`);
    expect(call.auth).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '919800000001',
      type: 'text',
      text: { body: 'Hi' },
      context: { message_id: 'wamid.X' },
      biz_opaque_callback_data: 'msg-1',
    });
  });

  it('sendTemplate maps parameters', async () => {
    graph.replies.push(sentReply);
    const res = await gateway.sendTemplate('919800000001', {
      name: 'welcome',
      language: 'en_US',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }] }],
    });
    expect(res.error).toBeNull();
    expect(graph.calls[0]!.body).toMatchObject({
      type: 'template',
      template: {
        name: 'welcome',
        language: { code: 'en_US' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }] }],
      },
    });
  });

  it.each(['image', 'video', 'audio', 'document', 'sticker'] as const)(
    'sendMedia sends %s by media id',
    async (kind) => {
      graph.replies.push(sentReply);
      const res = await gateway.sendMedia('919800000001', { kind, mediaId: 'media-9' });
      expect(res.error).toBeNull();
      expect(graph.calls[0]!.body).toMatchObject({ type: kind, [kind]: { id: 'media-9' } });
    },
  );

  it('sendInteractive sends reply buttons', async () => {
    graph.replies.push(sentReply);
    const res = await gateway.sendInteractive('919800000001', {
      type: 'button',
      body: 'Pick one',
      buttons: [{ id: 'a', title: 'A' }],
    });
    expect(res.error).toBeNull();
    expect(graph.calls[0]!.body).toMatchObject({
      type: 'interactive',
      interactive: { type: 'button', body: { text: 'Pick one' } },
    });
  });
});

describe('error mapping', () => {
  it.each([
    [131047, 400, C.WINDOW_CLOSED, false],
    [190, 401, C.TOKEN_INVALID, false],
    [130429, 429, C.RATE_LIMITED, true],
    [131048, 400, C.RATE_LIMITED, true],
    [132001, 400, C.TEMPLATE_INVALID, false],
    [131026, 400, C.RECIPIENT_UNAVAILABLE, false],
    [131030, 400, C.RECIPIENT_NOT_ALLOWED, false],
    [133010, 400, C.NOT_REGISTERED, false],
    [131042, 400, C.PAYMENT_REQUIRED, false],
    [1, 500, C.META_UNAVAILABLE, true],
    [999999, 400, C.UNKNOWN, false],
  ])('Meta %i (HTTP %i) -> %s, retryable=%s', async (code, status, internal, retryable) => {
    graph.replies.push(graphError(code, status));
    const res = await gateway.sendText('919800000001', { body: 'Hi' });
    expect(res.data).toBeNull();
    expect(res.error).toMatchObject({
      code: internal,
      retryable,
      metaCode: code,
      httpStatus: status,
    });
  });

  it('network failures are retryable and never throw', async () => {
    const down = new WapiCloudGateway({
      phoneNumberId: PHONE_ID,
      credentials: { accessToken: TOKEN, wabaId: WABA_ID },
      graph: {
        apiVersion: VERSION,
        fetch: (async () => {
          throw new TypeError('fetch failed');
        }) as typeof fetch,
      },
    });
    const res = await down.sendText('919800000001', { body: 'Hi' });
    expect(res.error).toMatchObject({ code: C.NETWORK, retryable: true });
  });

  it('does not retry inside the client: BullMQ owns retries', async () => {
    graph.replies.push(graphError(130429, 429), sentReply);
    await gateway.sendText('919800000001', { body: 'Hi' });
    expect(graph.calls).toHaveLength(1);
  });
});

describe('templates', () => {
  it('lists under the WABA and normalises rows', async () => {
    graph.replies.push({
      body: {
        data: [
          {
            id: '1',
            name: 'welcome',
            language: 'en_US',
            category: 'UTILITY',
            status: 'APPROVED',
            components: [{ type: 'BODY', text: 'Hi' }],
          },
        ],
        paging: { cursors: { after: 'CUR' }, next: 'https://next' },
      },
    });
    const res = await gateway.listTemplates({ limit: 10 });
    expect(graph.calls[0]!.path).toBe(`/${VERSION}/${WABA_ID}/message_templates`);
    expect(res.data?.items[0]).toMatchObject({ id: '1', name: 'welcome', status: 'APPROVED' });
    expect(res.data?.nextCursor).toBe('CUR');
  });

  it('creates under the WABA', async () => {
    graph.replies.push({ body: { id: '9', status: 'PENDING', category: 'UTILITY' } });
    const res = await gateway.createTemplate({
      name: 'welcome',
      language: 'en_US',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Hi' }],
    });
    expect(graph.calls[0]).toMatchObject({
      method: 'POST',
      path: `/${VERSION}/${WABA_ID}/message_templates`,
    });
    expect(res.data).toEqual({ id: '9', status: 'PENDING', category: 'UTILITY' });
  });
});

describe('media', () => {
  it('returns metadata without leaking the expiring URL', async () => {
    graph.replies.push({
      body: {
        id: 'media-1',
        url: 'https://lookaside.example/secret',
        mime_type: 'image/jpeg',
        sha256: 'abc',
        file_size: 12,
        messaging_product: 'whatsapp',
      },
    });
    const res = await gateway.getMediaInfo('media-1');
    expect(res.data).toEqual({
      id: 'media-1',
      mimeType: 'image/jpeg',
      sha256: 'abc',
      fileSize: 12,
    });
  });
});

describe('GraphClient (not covered by the SDK contract)', () => {
  const client = () =>
    new GraphClient({
      apiVersion: VERSION,
      appId: 'app-1',
      appSecret: 'secret-1',
      fetch: graph.fetchImpl,
    });

  it('exchanges the signup code', async () => {
    graph.replies.push({ body: { access_token: 'biz-token', token_type: 'bearer' } });
    const res = await client().exchangeCode('code-1');
    expect(res.data).toEqual({ accessToken: 'biz-token' });
    expect(graph.calls[0]).toMatchObject({
      method: 'GET',
      path: `/${VERSION}/oauth/access_token`,
      query: { client_id: 'app-1', client_secret: 'secret-1', code: 'code-1' },
    });
  });

  it('refuses to exchange without app credentials', async () => {
    const res = await new GraphClient({ apiVersion: VERSION, fetch: graph.fetchImpl }).exchangeCode(
      'code',
    );
    expect(res.error?.retryable).toBe(false);
    expect(graph.calls).toHaveLength(0);
  });

  it('never exposes the app secret in failure messages', async () => {
    const failing = new GraphClient({
      apiVersion: VERSION,
      appId: 'app-1',
      appSecret: 'secret-1',
      fetch: (async () => {
        throw new TypeError('fetch failed for ...client_secret=secret-1');
      }) as typeof fetch,
    });
    const res = await failing.exchangeCode('code');
    expect(res.error?.message).not.toContain('secret-1');
  });

  it('subscribes the app to the WABA with the customer token', async () => {
    graph.replies.push({ body: { success: true } });
    const res = await client().subscribeApp(WABA_ID, TOKEN);
    expect(res.data).toEqual({ success: true });
    expect(graph.calls[0]).toMatchObject({
      method: 'POST',
      path: `/${VERSION}/${WABA_ID}/subscribed_apps`,
      auth: `Bearer ${TOKEN}`,
    });
  });

  it('reads phone details including the messaging tier', async () => {
    graph.replies.push({
      body: {
        id: PHONE_ID,
        display_phone_number: '+1 555 000 1111',
        verified_name: 'Acme',
        quality_rating: 'GREEN',
        messaging_limit_tier: 'TIER_250',
      },
    });
    const res = await client().getPhoneNumber(PHONE_ID, TOKEN);
    expect(res.data).toMatchObject({ qualityRating: 'GREEN', messagingTier: 'TIER_250' });
    expect(graph.calls[0]!.query.fields).toContain('messaging_limit_tier');
  });

  it('falls back when the tier field is rejected', async () => {
    graph.replies.push(graphError(100), {
      body: { id: PHONE_ID, quality_rating: 'GREEN' },
    });
    const res = await client().getPhoneNumber(PHONE_ID, TOKEN);
    expect(res.data).toMatchObject({ qualityRating: 'GREEN', messagingTier: null });
    expect(graph.calls[1]!.query.fields).not.toContain('messaging_limit_tier');
  });

  it('does not fall back on token errors', async () => {
    graph.replies.push(graphError(190, 401));
    const res = await client().getPhoneNumber(PHONE_ID, TOKEN);
    expect(res.error?.code).toBe(C.TOKEN_INVALID);
    expect(graph.calls).toHaveLength(1);
  });
});

describe('webhook signature', () => {
  const secret = 'app-secret';
  const raw = Buffer.from(JSON.stringify(inboundText));
  const sign = (b: Buffer, s = secret) =>
    `sha256=${createHmac('sha256', s).update(b).digest('hex')}`;

  it('accepts the exact bytes', () => {
    expect(verifyWebhookSignature(raw, sign(raw), secret)).toBe(true);
  });

  it('rejects changed bytes, a wrong secret, and a missing header', () => {
    expect(verifyWebhookSignature(Buffer.from(`${raw} `), sign(raw), secret)).toBe(false);
    expect(verifyWebhookSignature(raw, sign(raw, 'other'), secret)).toBe(false);
    expect(verifyWebhookSignature(raw, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(raw, 'sha256=zz', secret)).toBe(false);
  });
});

describe('webhook challenge', () => {
  const base = {
    mode: 'subscribe',
    token: 'verify-me',
    challenge: '123',
    expectedToken: 'verify-me',
  };

  it('echoes the challenge only for the right token', () => {
    expect(verifyWebhookChallenge(base)).toBe('123');
    expect(verifyWebhookChallenge({ ...base, token: 'nope' })).toBeNull();
    expect(verifyWebhookChallenge({ ...base, mode: 'other' })).toBeNull();
    expect(verifyWebhookChallenge({ ...base, token: undefined })).toBeNull();
  });
});

describe('parsed webhook events (shape the app relies on)', () => {
  it('inbound text', () => {
    expect(parseWebhookEvents(inboundText)).toMatchObject([
      {
        type: 'message',
        messageType: 'text',
        id: 'wamid.INBOUND1',
        from: '919800000001',
        sender: '919800000001',
        profileName: 'Asha',
        phoneNumberId: PHONE_ID,
        timestamp: '1793800000',
        text: { body: 'Hello there' },
      },
    ]);
  });

  it('inbound image exposes the media id', () => {
    expect(parseWebhookEvents(inboundImage)).toMatchObject([
      {
        type: 'message',
        messageType: 'image',
        image: { id: 'media-1', mimeType: 'image/jpeg', caption: 'Pic' },
      },
    ]);
  });

  it('failed status keeps errors and callback data', () => {
    expect(parseWebhookEvents(statusFailed)).toMatchObject([
      {
        type: 'status',
        messageId: 'wamid.OUT1',
        status: 'failed',
        phoneNumberId: PHONE_ID,
        bizOpaqueCallbackData: 'msg-123',
        errors: [{ code: 131047 }],
      },
    ]);
  });

  it('template status update', () => {
    expect(parseWebhookEvents(templateStatus)).toMatchObject([
      { type: 'template_status_update', messageTemplateName: 'welcome', event: 'APPROVED' },
    ]);
  });
});

describe('splitWebhookPayload', () => {
  it('produces one routable event per change', () => {
    const events = splitWebhookPayload(multiTenantDelivery);
    expect(events.map((e) => [e.wabaId, e.phoneNumberId, e.field])).toEqual([
      [WABA_ID, PHONE_ID, 'messages'],
      [WABA_ID, PHONE_ID, 'messages'],
      ['100000000000002', '200000000000002', 'messages'],
    ]);
    expect(new Set(events.map((e) => e.dedupeKey)).size).toBe(3);
  });

  it('each split payload still parses as a webhook body', () => {
    const [event] = splitWebhookPayload(inboundText);
    expect(parseWebhookEvents(event!.payload)).toMatchObject([{ id: 'wamid.INBOUND1' }]);
  });

  it('is deterministic, so redeliveries dedupe', () => {
    const a = splitWebhookPayload(JSON.parse(JSON.stringify(inboundText)));
    const b = splitWebhookPayload(JSON.parse(JSON.stringify(inboundText)));
    expect(a[0]!.dedupeKey).toBe(b[0]!.dedupeKey);
  });

  it('tolerates junk', () => {
    for (const junk of [null, 'x', {}, { entry: 'x' }, { entry: [{}] }, { entry: [null] }]) {
      expect(splitWebhookPayload(junk)).toEqual([]);
    }
  });
});

describe('parseSignedRequest', () => {
  const secret = 'app-secret';
  const make = (payload: object, s = secret) => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', s).update(encoded).digest('base64url');
    return `${sig}.${encoded}`;
  };

  it('returns the payload when the signature is valid', () => {
    const res = parseSignedRequest(make({ algorithm: 'HMAC-SHA256', user_id: '42' }), secret);
    expect(res.user_id).toBe('42');
  });

  it.each([
    ['wrong secret', () => make({ algorithm: 'HMAC-SHA256', user_id: '42' }, 'other')],
    ['wrong algorithm', () => make({ algorithm: 'none', user_id: '42' })],
    ['malformed', () => 'not-a-signed-request'],
    ['too many parts', () => 'a.b.c'],
  ])('rejects %s', (_, build) => {
    expect(() => parseSignedRequest(build(), secret)).toThrow(InvalidSignedRequestError);
  });
});
