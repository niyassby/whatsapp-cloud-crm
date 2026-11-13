'use client';

import { ArrowLeft, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { UserMenu } from '@/components/app/user-menu';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { endImpersonation } from '@/lib/reseller';
import { useMe } from '@/lib/queries';
import { cn } from '@/lib/utils';

export function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const me = useMe();
  const links = [
    ...(me.data?.partner ? [{ href: '/partner', label: me.data.partner.name }] : []),
    ...(me.data?.platformAdmin ? [{ href: '/admin', label: 'Platform admin' }] : []),
  ];
  const allowed = pathname.startsWith('/admin')
    ? me.data?.platformAdmin
    : Boolean(me.data?.partner);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center gap-4 border-b px-4">
        {/* TODO(branding): partner logo/name plugs in here. */}
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <MessageCircle className="size-4" aria-hidden />
        </span>
        <nav className="flex min-w-0 items-center gap-1" aria-label="Consoles">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={pathname.startsWith(l.href) ? 'page' : undefined}
              className={cn(
                'truncate rounded-md px-3 py-1.5 text-sm hover:bg-accent',
                pathname.startsWith(l.href) && 'bg-accent font-medium',
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {me.data && me.data.orgs.length > 0 && (
            <Link
              href="/inbox"
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" aria-hidden /> My workspace
            </Link>
          )}
          {me.data ? <UserMenu me={me.data} /> : <Skeleton className="size-8 rounded-full" />}
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 p-6">
        {me.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : me.data?.impersonation ? (
          <div className="py-16 text-center text-sm">
            <p className="text-muted-foreground">
              You are viewing {me.data.impersonation.orgName}. Leave it to come back here.
            </p>
            <Button className="mt-4" onClick={() => void endImpersonation()}>
              Exit workspace
            </Button>
          </div>
        ) : !allowed ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            You do not have access to this console.
          </p>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
