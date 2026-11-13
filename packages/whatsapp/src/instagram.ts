/**
 * Instagram messaging (Instagram API with Instagram Login), straight on Graph: wapi-cloud covers
 * WhatsApp only. Requests and payloads follow Meta's documentation and have not been checked
 * against live traffic yet; `test/instagram.test.ts` pins them.
 */
import { createHash } from 'node:crypto';

export interface InstagramConfig {
  appId: string;
  appSecret: string;
  apiVersion: string;
  /**
   * Local fakes only: one base for login, token exchange and Graph. Unset uses
   * www.instagram.com, api.instagram.com and graph.instagram.com.
   */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class InstagramError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    /** 5xx, 429 or a throttling code: try again later. */
    readonly retryable: boolean,
    /** The token was revoked or expired (Graph code 190): the account must be connected again. */
    readonly tokenInvalid: boolean,
  ) {
    super(message);
    this.name = 'InstagramError';
  }
}

export interface InstagramAccount {
  /** The professional account id that webhooks name in entry.id. */
  userId: string;
  username: string | null;
  name: string | null;
}

export interface InstagramToken {
  accessToken: string;
  expiresAt: Date;
}

export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];

export class InstagramClient {
  private readonly fetch: typeof fetch;

  constructor(private readonly config: InstagramConfig) {
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  private base(kind: 'www' | 'api' | 'graph'): string {
    if (this.config.baseUrl) return this.config.baseUrl.replace(/\/$/, '');
    return `https://${kind === 'www' ? 'www' : kind === 'api' ? 'api' : 'graph'}.instagram.com`;
  }

  private graph(path: string): string {
    return `${this.base('graph')}/${this.config.apiVersion}/${path.replace(/^\//, '')}`;
  }

  authorizeUrl(input: { redirectUri: string; state: string }): string {
    const url = new URL(`${this.base('www')}/oauth/authorize`);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', INSTAGRAM_SCOPES.join(','));
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new InstagramError(
        `Could not reach Instagram: ${err instanceof Error ? err.message : String(err)}`,
        0,
        null,
        true,
        false,
      );
    }
    const text = await res.text();
    const body = parseJson(text);
    if (!res.ok) {
      const err = (body as { error?: { message?: string; code?: number } } | null)?.error;
      const code = typeof err?.code === 'number' ? err.code : null;
      throw new InstagramError(
        err?.message ?? `Instagram answered ${res.status}`,
        res.status,
        code,
        res.status >= 500 || res.status === 429 || code === 4 || code === 613,
        code === 190,
      );
    }
    return body as T;
  }

  /** Short-lived token from the login code, then a 60-day token. */
  async exchangeCode(input: { code: string; redirectUri: string }): Promise<InstagramToken> {
    const form = new URLSearchParams({
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
      code: input.code,
    });
    const short = await this.call<{ access_token: string }>(
      `${this.base('api')}/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      },
    );
    const url = new URL(`${this.base('graph')}/access_token`);
    url.searchParams.set('grant_type', 'ig_exchange_token');
    url.searchParams.set('client_secret', this.config.appSecret);
    url.searchParams.set('access_token', short.access_token);
    const long = await this.call<{ access_token: string; expires_in: number }>(url.toString());
    return { accessToken: long.access_token, expiresAt: expiresIn(long.expires_in) };
  }

  /** A long-lived token can be refreshed once it is a day old, for another 60 days. */
  async refreshToken(accessToken: string): Promise<InstagramToken> {
    const url = new URL(`${this.base('graph')}/refresh_access_token`);
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', accessToken);
    const res = await this.call<{ access_token: string; expires_in: number }>(url.toString());
    return { accessToken: res.access_token, expiresAt: expiresIn(res.expires_in) };
  }

  async me(accessToken: string): Promise<InstagramAccount> {
    const url = new URL(this.graph('me'));
    url.searchParams.set('fields', 'user_id,username,name');
    const res = await this.call<{ user_id?: string; id: string; username?: string; name?: string }>(
      url.toString(),
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    return {
      userId: res.user_id ?? res.id,
      username: res.username ?? null,
      name: res.name ?? null,
    };
  }

  /** Ask Meta to send this account's messages to the app's webhook. */
  async subscribe(accessToken: string): Promise<void> {
    const url = new URL(this.graph('me/subscribed_apps'));
    url.searchParams.set('subscribed_fields', 'messages');
    await this.call(url.toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  /** Name and username of someone who wrote in, by their Instagram-scoped id. */
  async profile(
    accessToken: string,
    igsid: string,
  ): Promise<{ name: string | null; username: string | null }> {
    const url = new URL(this.graph(igsid));
    url.searchParams.set('fields', 'name,username');
    const res = await this.call<{ name?: string; username?: string }>(url.toString(), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return { name: res.name ?? null, username: res.username ?? null };
  }

  /** Text, with up to 13 quick-reply buttons. Returns the message id. */
  async sendText(
    accessToken: string,
    input: {
      accountId: string;
      recipientId: string;
      text: string;
      quickReplies?: { id: string; title: string }[];
    },
  ): Promise<{ messageId: string }> {
    const message: Record<string, unknown> = { text: input.text };
    if (input.quickReplies?.length) {
      message.quick_replies = input.quickReplies.slice(0, 13).map((q) => ({
        content_type: 'text',
        title: q.title.slice(0, 20),
        payload: q.id,
      }));
    }
    const res = await this.call<{ message_id: string }>(this.graph(`${input.accountId}/messages`), {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: { id: input.recipientId }, message }),
    });
    return { messageId: res.message_id };
  }
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const expiresIn = (seconds: number) =>
  new Date(Date.now() + (Number.isFinite(seconds) ? seconds : 60 * 86_400) * 1000);

// ------------------------------------------------------------------ webhooks

export interface InstagramMessageEvent {
  /** The business account the message is for (entry.id). */
  accountId: string;
  senderId: string;
  recipientId: string;
  timestamp: Date;
  mid: string;
  text: string | null;
  /** Sent by the business itself (from the Instagram app, or by us). Not a customer message. */
  isEcho: boolean;
  /** The payload of a tapped quick reply. */
  quickReply: string | null;
  attachments: { type: string; url: string | null }[];
  referral: Record<string, unknown> | null;
}

interface RawMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    quick_reply?: { payload?: string };
    attachments?: { type?: string; payload?: { url?: string } }[];
    referral?: Record<string, unknown>;
  };
  referral?: Record<string, unknown>;
}

/** Customer messages in an Instagram webhook body. Reads, reactions and deletions are skipped. */
export function parseInstagramWebhook(payload: unknown): InstagramMessageEvent[] {
  const entries = (payload as { entry?: unknown } | null)?.entry;
  if (!Array.isArray(entries)) return [];
  const events: InstagramMessageEvent[] = [];
  for (const entry of entries as { id?: string; messaging?: RawMessaging[] }[]) {
    for (const m of Array.isArray(entry?.messaging) ? entry.messaging : []) {
      const msg = m.message;
      if (!msg?.mid || !m.sender?.id || !m.recipient?.id || msg.is_deleted) continue;
      events.push({
        accountId: String(entry.id ?? m.recipient.id),
        senderId: m.sender.id,
        recipientId: m.recipient.id,
        timestamp: new Date(typeof m.timestamp === 'number' ? m.timestamp : Date.now()),
        mid: msg.mid,
        text: msg.text ?? null,
        isEcho: msg.is_echo === true,
        quickReply: msg.quick_reply?.payload ?? null,
        attachments: (msg.attachments ?? []).map((a) => ({
          type: a.type ?? 'unknown',
          url: a.payload?.url ?? null,
        })),
        referral: msg.referral ?? m.referral ?? null,
      });
    }
  }
  return events;
}

export interface SplitInstagramEvent {
  payload: { object: unknown; entry: [Record<string, unknown>] };
  dedupeKey: string;
  accountId: string | null;
}

/** One stored event per entry: an entry belongs to one account, so to one workspace. */
export function splitInstagramPayload(body: unknown): SplitInstagramEvent[] {
  if (!body || typeof body !== 'object') return [];
  const { object, entry } = body as { object?: unknown; entry?: unknown };
  if (!Array.isArray(entry)) return [];
  return (entry as Record<string, unknown>[]).map((e) => {
    const payload: SplitInstagramEvent['payload'] = { object, entry: [e] };
    return {
      payload,
      dedupeKey: `ig:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
      accountId: typeof e.id === 'string' || typeof e.id === 'number' ? String(e.id) : null,
    };
  });
}
