import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { AppShell } from '@/components/app/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { RealtimeProvider } from '@/components/realtime-provider';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense>
      <AuthGuard>
        <RealtimeProvider>
          <AppShell>{children}</AppShell>
        </RealtimeProvider>
      </AuthGuard>
    </Suspense>
  );
}
