import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { AuthGuard } from '@/components/auth/auth-guard';
import { ConsoleShell } from '@/components/reseller/console-shell';

/**
 * The partner and platform consoles. They sit outside the workspace shell on purpose: they act
 * across workspaces and need none selected, so there is no inbox, wallet or realtime socket here.
 */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense>
      <AuthGuard>
        <ConsoleShell>{children}</ConsoleShell>
      </AuthGuard>
    </Suspense>
  );
}
