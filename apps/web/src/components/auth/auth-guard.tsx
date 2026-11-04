'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { refreshSession } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';

/**
 * Protects the (app) routes. On a fresh page load the in-memory access token is empty, so we
 * silently exchange the refresh cookie for one; if that fails the user goes to /login.
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.accessToken);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (token) {
      setChecked(true);
      return;
    }
    let cancelled = false;
    void refreshSession().then((ok) => {
      if (cancelled) return;
      if (ok) setChecked(true);
      else {
        const query = search.toString();
        const next = `${pathname}${query ? `?${query}` : ''}`;
        router.replace(`/login?next=${encodeURIComponent(next)}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token, pathname, router, search]);

  if (!checked || !token) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  return <>{children}</>;
}
