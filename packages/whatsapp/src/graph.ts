/**
 * Direct Graph API calls for what project rules keep outside wapi-cloud: Embedded Signup code
 * exchange, WABA webhook subscription, and account details with fields the SDK does not request.
 */
import { type GatewayResult, mapError, result } from './errors';
import type {
  DeleteTemplateInput,
  ListTemplatesInput,
  PhoneInfo,
  TemplatePage,
  UploadMediaInput,
  WabaInfo,
} from './gateway';

export interface GraphConfig {
  /** Pinned, e.g. v25.0 (META_GRAPH_API_VERSION). */
  apiVersion: string;
  baseUrl?: string;
  appId?: string;
  appSecret?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const PHONE_FIELDS = [
  'id',
  'display_phone_number',
  'verified_name',
  'quality_rating',
  'code_verification_status',
  'name_status',
  'platform_type',
  'status',
];
/** Requested separately: Meta has been migrating messaging limits to newer fields. */
const TIER_FIELD = 'messaging_limit_tier';
const WABA_FIELDS = 'id,name,currency,timezone_id,message_template_namespace';
const TEMPLATE_FIELDS =
  'id,name,language,category,status,components,rejected_reason,quality_score,parameter_format';
/** A video sample can be 16 MB, which is slow over a poor connection. */
const UPLOAD_TIMEOUT_MS = 120_000;

interface RawTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components?: Record<string, unknown>[];
  rejected_reason?: string;
  quality_score?: { score?: string };
  parameter_format?: string;
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; fbtrace_id?: string };
}

type RawPhone = Record<string, string | undefined>;

function toPhoneInfo(p: RawPhone): PhoneInfo {
  return {
    id: String(p.id),
    displayPhoneNumber: p.display_phone_number ?? null,
    verifiedName: p.verified_name ?? null,
    qualityRating: p.quality_rating ?? null,
    messagingTier: p.messaging_limit_tier ?? null,
    codeVerificationStatus: p.code_verification_status ?? null,
    nameStatus: p.name_status ?? null,
    platformType: p.platform_type ?? null,
    status: p.status ?? null,
  };
}

export class GraphClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GraphConfig) {
    this.base = `${config.baseUrl ?? 'https://graph.facebook.com'}/${config.apiVersion}`;
    this.fetchImpl = config.fetch ?? fetch;
  }

  /** Exchange the code from FB.login for a business token scoped to the customer's assets. */
  async exchangeCode(code: string): Promise<GatewayResult<{ accessToken: string }>> {
    if (!this.config.appId || !this.config.appSecret) {
      return result.fail({
        code: 'WA_INVALID_REQUEST',
        message: 'META_APP_ID and META_APP_SECRET are not configured',
        retryable: false,
        metaCode: 0,
        httpStatus: 0,
      });
    }
    const res = await this.call<{ access_token: string }>('GET', '/oauth/access_token', {
      query: {
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        code,
      },
    });
    if (res.error) return res;
    return result.ok({ accessToken: res.data.access_token });
  }

  /** Start receiving this WABA's webhooks on our app. */
  subscribeApp(wabaId: string, token: string): Promise<GatewayResult<{ success: boolean }>> {
    return this.call('POST', `/${wabaId}/subscribed_apps`, { token });
  }

  unsubscribeApp(wabaId: string, token: string): Promise<GatewayResult<{ success: boolean }>> {
    return this.call('DELETE', `/${wabaId}/subscribed_apps`, { token });
  }

  async getWaba(wabaId: string, token: string): Promise<GatewayResult<WabaInfo>> {
    const res = await this.call<Record<string, string | undefined>>('GET', `/${wabaId}`, {
      token,
      query: { fields: WABA_FIELDS },
    });
    if (res.error) return res;
    return result.ok({
      id: String(res.data.id),
      name: res.data.name ?? null,
      currency: res.data.currency ?? null,
      timezoneId: res.data.timezone_id ?? null,
      templateNamespace: res.data.message_template_namespace ?? null,
    });
  }

  /** Numbers under a WABA. A success also proves the token can access this WABA. */
  async listPhoneNumbers(wabaId: string, token: string): Promise<GatewayResult<PhoneInfo[]>> {
    const res = await this.call<{ data: RawPhone[] }>('GET', `/${wabaId}/phone_numbers`, {
      token,
      query: { fields: PHONE_FIELDS.join(',') },
    });
    if (res.error) return res;
    return result.ok(res.data.data.map(toPhoneInfo));
  }

  /** Phone details, tolerating the tier field being unavailable for this version or number. */
  async getPhoneNumber(phoneNumberId: string, token: string): Promise<GatewayResult<PhoneInfo>> {
    const withTier = await this.call<RawPhone>('GET', `/${phoneNumberId}`, {
      token,
      query: { fields: [...PHONE_FIELDS, TIER_FIELD].join(',') },
    });
    if (!withTier.error) return result.ok(toPhoneInfo(withTier.data));
    if (withTier.error.metaCode !== 100) return withTier;

    const basic = await this.call<RawPhone>('GET', `/${phoneNumberId}`, {
      token,
      query: { fields: PHONE_FIELDS.join(',') },
    });
    if (basic.error) return basic;
    return result.ok(toPhoneInfo(basic.data));
  }

  async listTemplates(
    wabaId: string,
    token: string,
    params: ListTemplatesInput = {},
  ): Promise<GatewayResult<TemplatePage>> {
    const res = await this.call<{
      data: RawTemplate[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>('GET', `/${wabaId}/message_templates`, {
      token,
      query: {
        fields: TEMPLATE_FIELDS,
        limit: String(params.limit ?? 100),
        ...(params.after ? { after: params.after } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.name ? { name: params.name } : {}),
      },
    });
    if (res.error) return res;
    return result.ok({
      items: res.data.data.map((t) => ({
        id: String(t.id),
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        components: t.components ?? [],
        rejectedReason: t.rejected_reason,
        qualityScore: t.quality_score?.score,
        parameterFormat: t.parameter_format,
      })),
      // Meta keeps sending a cursor on the last page. Only `next` means there is more.
      nextCursor: res.data.paging?.next ? res.data.paging.cursors?.after : undefined,
    });
  }

  deleteTemplate(
    wabaId: string,
    input: DeleteTemplateInput,
    token: string,
  ): Promise<GatewayResult<{ success: boolean }>> {
    return this.call('DELETE', `/${wabaId}/message_templates`, {
      token,
      query: { name: input.name, hsm_id: input.templateId },
    });
  }

  /** Meta's Resumable Upload API, in one go: open a session, then send the bytes. */
  async uploadTemplateSample(
    input: UploadMediaInput,
    token: string,
  ): Promise<GatewayResult<{ handle: string }>> {
    if (!this.config.appId) {
      return result.fail({
        code: 'WA_INVALID_REQUEST',
        message: 'META_APP_ID is not configured',
        retryable: false,
        metaCode: 0,
        httpStatus: 0,
      });
    }
    const session = await this.call<{ id: string }>('POST', `/${this.config.appId}/uploads`, {
      token,
      query: {
        file_name: input.filename ?? 'sample',
        file_length: String(input.bytes.length),
        file_type: input.mimeType,
      },
    });
    if (session.error) return session;
    const sent = await this.call<{ h: string }>('POST', `/${session.data.id}`, {
      // This endpoint documents OAuth, not Bearer.
      headers: { authorization: `OAuth ${token}`, file_offset: '0' },
      body: input.bytes,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (sent.error) return sent;
    return result.ok({ handle: sent.data.h });
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: {
      token?: string;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: Buffer;
      timeoutMs?: number;
    },
  ): Promise<GatewayResult<T>> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...opts.headers,
        },
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.config.timeoutMs ?? 15_000),
      });
      const body = (await res.json().catch(() => null)) as (T & GraphErrorBody) | null;
      if (!res.ok || !body || body.error) {
        return result.fail(
          mapError({
            message: body?.error?.message ?? `Graph API returned HTTP ${res.status}`,
            code: body?.error?.code,
            httpStatus: res.status,
            fbtraceId: body?.error?.fbtrace_id,
          }),
        );
      }
      return result.ok(body);
    } catch (err) {
      // Never echo the URL: the code exchange carries the app secret in its query string.
      const reason = err instanceof Error ? err.name : 'Error';
      return result.fail(mapError({ message: `Graph API request failed (${reason})` }));
    }
  }
}
