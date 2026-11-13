/**
 * Pins the Instagram requests and webhook parsing. Shapes follow Meta's documentation for the
 * Instagram API with Instagram Login; they have not been checked against live traffic yet.
 */
import { describe, expect, it } from 'vitest';
import {
  InstagramClient,
  InstagramError,
  parseInstagramWebhook,
  splitInstagramPayload,
} from '../src/instagram';

function recorder(answer: (url: string) => { status?: number; body: unknown }) {
  const calls: { url: string; method: string; body: string | null; auth: string | null }[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? String(init.body) : null,
      auth: new Headers(init?.headers).get('authorization'),
    });
    const { status = 200, body } = answer(url);
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const make = (fetch: typeof globalThis.fetch) =>
  new InstagramClient({ appId: 'app-1', appSecret: 'secret-1', apiVersion: 'v25.0', fetch });

describe('login', () => {
  it('asks for messaging scopes on Instagram’s own login page', () => {
    const url = new URL(
      make(globalThis.fetch).authorizeUrl({ redirectUri: 'https://api.test/cb', state: 's1' }),
    );
    expect(url.origin).toBe('https://www.instagram.com');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'app-1',
      redirect_uri: 'https://api.test/cb',
      response_type: 'code',
      scope: 'instagram_business_basic,instagram_business_manage_messages',
      state: 's1',
    });
  });

  it('exchanges the code, then trades it for a 60-day token', async () => {
    const r = recorder((url) =>
      url.includes('oauth/access_token')
        ? { body: { access_token: 'short', user_id: 1 } }
        : { body: { access_token: 'long', expires_in: 5_184_000 } },
    );
    const token = await make(r.fetch).exchangeCode({
      code: 'c1',
      redirectUri: 'https://api.test/cb',
    });
    expect(r.calls[0]).toMatchObject({
      url: 'https://api.instagram.com/oauth/access_token',
      method: 'POST',
    });
    expect(new URLSearchParams(r.calls[0]!.body!).get('grant_type')).toBe('authorization_code');
    expect(r.calls[1]?.url).toContain(
      'https://graph.instagram.com/access_token?grant_type=ig_exchange_token',
    );
    expect(token.accessToken).toBe('long');
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now() + 59 * 86_400_000);
  });
});

describe('sending', () => {
  it('posts text with quick replies to the account’s messages edge', async () => {
    const r = recorder(() => ({ body: { recipient_id: 'u1', message_id: 'm1' } }));
    const sent = await make(r.fetch).sendText('tok', {
      accountId: '1784',
      recipientId: 'u1',
      text: 'Pick one',
      quickReplies: [{ id: 'a', title: 'A very long button title indeed' }],
    });
    expect(sent).toEqual({ messageId: 'm1' });
    expect(r.calls[0]).toMatchObject({
      url: 'https://graph.instagram.com/v25.0/1784/messages',
      auth: 'Bearer tok',
    });
    expect(JSON.parse(r.calls[0]!.body!)).toEqual({
      recipient: { id: 'u1' },
      message: {
        text: 'Pick one',
        quick_replies: [{ content_type: 'text', title: 'A very long button t', payload: 'a' }],
      },
    });
  });

  it('marks an expired token, and rate limits as retryable', async () => {
    const expired = make(
      recorder(() => ({ status: 400, body: { error: { message: 'expired', code: 190 } } })).fetch,
    );
    await expect(expired.me('tok')).rejects.toMatchObject({ tokenInvalid: true, retryable: false });
    const busy = make(
      recorder(() => ({ status: 429, body: { error: { message: 'slow down', code: 4 } } })).fetch,
    );
    const err = await busy.me('tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstagramError);
    expect(err).toMatchObject({ retryable: true });
  });
});

describe('webhooks', () => {
  const body = {
    object: 'instagram',
    entry: [
      {
        id: '1784',
        time: 1,
        messaging: [
          {
            sender: { id: 'u1' },
            recipient: { id: '1784' },
            timestamp: 1700000000000,
            message: { mid: 'm1', text: 'Hi' },
          },
          {
            sender: { id: '1784' },
            recipient: { id: 'u1' },
            timestamp: 1,
            message: { mid: 'm2', text: 'Echo', is_echo: true },
          },
          {
            sender: { id: 'u1' },
            recipient: { id: '1784' },
            timestamp: 2,
            message: { mid: 'm3', is_deleted: true },
          },
          { sender: { id: 'u1' }, recipient: { id: '1784' }, timestamp: 3, read: { mid: 'm1' } },
          {
            sender: { id: 'u2' },
            recipient: { id: '1784' },
            timestamp: 4,
            message: {
              mid: 'm4',
              text: 'From the ad',
              referral: { ad_id: 'ad-9', source: 'ADS', ads_context_data: { ad_title: 'Sale' } },
            },
          },
        ],
      },
    ],
  };

  it('keeps messages and echoes, and skips reads and deletions', () => {
    const events = parseInstagramWebhook(body);
    expect(events.map((e) => [e.mid, e.isEcho])).toEqual([
      ['m1', false],
      ['m2', true],
      ['m4', false],
    ]);
    expect(events[0]).toMatchObject({
      accountId: '1784',
      senderId: 'u1',
      text: 'Hi',
      timestamp: new Date(1700000000000),
    });
    expect(events[2]?.referral).toMatchObject({ ad_id: 'ad-9' });
  });

  it('stores one event per account entry, with a stable key', () => {
    const [first] = splitInstagramPayload(body);
    const [again] = splitInstagramPayload(JSON.parse(JSON.stringify(body)));
    expect(first?.accountId).toBe('1784');
    expect(first?.dedupeKey).toBe(again?.dedupeKey);
    expect(first?.dedupeKey).toMatch(/^ig:[0-9a-f]{64}$/);
  });
});
