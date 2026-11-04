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
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Send the access token and retry once after a silent refresh on 401. Default true. */
  auth?: boolean;
}

let refreshing: Promise<boolean> | null = null;

/**
 * Exchange the refresh cookie for a new access token. Single-flight: concurrent callers share
 * one request, because rotating the same refresh token twice would trigger reuse detection.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
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
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
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

/** Store tokens returned by login/signup/switch-org/accept-invite. */
export function setSession(tokens: AuthTokensResponse): void {
  useAuthStore.getState().setAccessToken(tokens.accessToken);
}

/** Only allow same-site relative redirects (prevents open redirects via ?next=). */
export function safeNext(next: string | null | undefined, fallback = '/inbox'): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}
