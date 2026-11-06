'use client';

import type { AuthTokensResponse, ErrorCode, ErrorResponse } from '@wacrm/shared';
import { useAuthStore } from './auth-store';
import { env } from './env';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field errors from VALIDATION_FAILED responses, keyed by field path. */
  get fieldErrors(): Record<string, string> {
    const issues = (this.details?.issues ?? []) as { path: string; message: string }[];
    return Object.fromEntries(issues.map((i) => [i.path, i.message]));
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Send the access token and retry once after a silent refresh on 401. Default true. */
  auth?: boolean;
}

let refreshing: Promise<boolean> | null = null;

/**
 * Exchange the refresh cookie for a new access token. Rotating the same refresh token twice
 * looks like theft and ends the session, so this is single-flight within a tab, and a Web Lock
 * queues other tabs. Each tab then rotates in turn, with the cookie the previous one received.
 */
export function refreshSession(): Promise<boolean> {
  const run = async () => {
    try {
      const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        useAuthStore.getState().setAccessToken(null);
        return false;
      }
      const data = (await res.json()) as AuthTokensResponse;
      useAuthStore.getState().setAccessToken(data.accessToken);
      return true;
    } catch {
      return false;
    }
  };
  if (refreshing) return refreshing;
  const pending = (
    navigator.locks
      ? (navigator.locks.request('wacrm-refresh', run) as unknown as Promise<boolean>)
      : run()
  ).finally(() => {
    refreshing = null;
  });
  refreshing = pending;
  return pending;
}

/** POST multipart form data, with the same token handling and errors as `api`. */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const send = () => {
    const token = useAuthStore.getState().accessToken;
    return fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: form,
    });
  };
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  return parse<T>(res);
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ErrorResponse>;
    throw new ApiError(
      res.status,
      err.code ?? ('INTERNAL' as ErrorCode),
      err.message ?? 'Something went wrong',
      err.details,
    );
  }
  return data as T;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = options;

  const send = () => {
    const token = auth ? useAuthStore.getState().accessToken : null;
    return fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res = await send();
  if (res.status === 401 && auth && (await refreshSession())) res = await send();
  return parse<T>(res);
}

/** Fetch a file that needs the access token, so a plain link cannot be used. */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const send = () => {
    const token = useAuthStore.getState().accessToken;
    return fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
      credentials: 'include',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  };
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  if (!res.ok) {
    await parse(res);
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Store tokens returned by login/signup/switch-org/accept-invite. */
export function setSession(tokens: AuthTokensResponse): void {
  useAuthStore.getState().setAccessToken(tokens.accessToken);
}

/** Only allow same-site relative redirects (prevents open redirects via ?next=). */
export function safeNext(next: string | null | undefined, fallback = '/inbox'): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}
