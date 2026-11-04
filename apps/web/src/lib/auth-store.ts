'use client';

import { create } from 'zustand';

/**
 * The access token lives only in memory (never localStorage), so XSS cannot read a stored
 * token. The refresh token is an httpOnly cookie the browser sends to /auth/refresh.
 */
interface AuthState {
  accessToken: string | null;
  setAccessToken: (token: string | null) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  setAccessToken: (accessToken) => set({ accessToken }),
}));
