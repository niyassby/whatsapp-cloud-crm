'use client';

import { create } from 'zustand';

/** Where "Exit" goes: the console the impersonation was started from. */
export type ConsolePath = '/partner' | '/admin';

/**
 * The access token lives only in memory (never localStorage), so XSS cannot read a stored
 * token. The refresh token is an httpOnly cookie the browser sends to /auth/refresh.
 *
 * While a partner's staff or a platform admin is viewing a client workspace, a second token is
 * held beside their own and sent instead. It is never refreshed: when it ends, or the page is
 * reloaded, the person is themselves again.
 */
interface AuthState {
  accessToken: string | null;
  impersonation: { token: string; returnTo: ConsolePath } | null;
  setAccessToken: (token: string | null) => void;
  setImpersonation: (impersonation: AuthState['impersonation']) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  impersonation: null,
  setAccessToken: (accessToken) =>
    // Logging out also leaves any workspace being viewed.
    set(accessToken ? { accessToken } : { accessToken, impersonation: null }),
  setImpersonation: (impersonation) => set({ impersonation }),
}));

/** The token to send: the impersonation one while viewing a workspace, otherwise the person's own. */
export const activeToken = (): string | null => {
  const { impersonation, accessToken } = useAuthStore.getState();
  return impersonation?.token ?? accessToken;
};
