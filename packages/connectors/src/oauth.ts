/**
 * The OAuth 2 authorization-code flow, shared by every OAuth connector. The framework keeps the
 * state and the tokens; a connector only says where its pages are.
 */
import { fillSettings } from './registry';
import type { OAuth2Auth } from './types';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** null: the provider did not say, so the token is treated as long-lived. */
  expiresAt: Date | null;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    /** The grant is gone (revoked, expired): only a person reconnecting can fix it. */
    readonly reconnect: boolean,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export function authorizeUrl(
  auth: OAuth2Auth,
  client: OAuthClient,
  opts: { redirectUri: string; state: string; settings: Record<string, string> },
): string {
  const url = new URL(fillSettings(auth.authorizeUrl, opts.settings));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('state', opts.state);
  if (auth.scopes.length)
    url.searchParams.set('scope', auth.scopes.join(auth.scopeSeparator ?? ' '));
  for (const [k, v] of Object.entries(auth.extraAuthorizeParams ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

async function tokenRequest(
  fetchFn: typeof fetch,
  auth: OAuth2Auth,
  client: OAuthClient,
  settings: Record<string, string>,
  params: Record<string, string>,
): Promise<OAuthTokens> {
  const res = await fetchFn(fillSettings(auth.tokenUrl, settings), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      ...params,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Some providers answer errors in plain text.
  }
  if (!res.ok || typeof json.access_token !== 'string') {
    const error = typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
    // invalid_grant: the refresh token or code is no longer good. Retrying will not help.
    throw new OAuthError(
      `The provider refused: ${error}`,
      error === 'invalid_grant' || res.status === 401,
    );
  }
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
  };
}

export function exchangeCode(
  fetchFn: typeof fetch,
  auth: OAuth2Auth,
  client: OAuthClient,
  opts: { code: string; redirectUri: string; settings: Record<string, string> },
): Promise<OAuthTokens> {
  return tokenRequest(fetchFn, auth, client, opts.settings, {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
}

export async function refreshTokens(
  fetchFn: typeof fetch,
  auth: OAuth2Auth,
  client: OAuthClient,
  opts: { refreshToken: string; settings: Record<string, string> },
): Promise<OAuthTokens> {
  const tokens = await tokenRequest(fetchFn, auth, client, opts.settings, {
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
  });
  // Many providers keep the old refresh token when they do not send a new one.
  return { ...tokens, refreshToken: tokens.refreshToken ?? opts.refreshToken };
}

/** The app's client id and secret, from the environment variables the connector names. */
export function oauthClient(
  auth: OAuth2Auth,
  env: Record<string, string | undefined>,
): OAuthClient | null {
  const clientId = env[auth.clientIdEnv];
  const clientSecret = env[auth.clientSecretEnv];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
