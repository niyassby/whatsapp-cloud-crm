'use client';

import { Permission } from '@wacrm/shared';
import {
  ChartColumn,
  ChartLine,
  FileText,
  Inbox,
  Megaphone,
  Plug,
  MessageCircle,
  Settings,
  Users,
  Wallet,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { CallBar } from '@/components/inbox/call-bar';
import { ImpersonationBanner } from './impersonation-banner';
import { LowBalanceBanner } from './low-balance-banner';
import { NoOrg } from './no-org';
import { NotificationBell } from './notification-bell';
import { ReconnectBanner } from './reconnect-banner';
import { OrgSwitcher } from './org-switcher';
import { TrialBanner } from './trial-banner';
import { UserMenu } from './user-menu';
import { VerifyEmailBanner } from './verify-email-banner';

const NAV: {
  href: string;
  label: string;
  icon: typeof Inbox;
  soon?: boolean;
  permission?: Permission;
}[] = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    icon: ChartLine,
    permission: Permission.ANALYTICS_READ,
  },
  { href: '/reports', label: 'Reports', icon: ChartColumn, permission: Permission.ANALYTICS_READ },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/contacts', label: 'Contacts', icon: Users },
  { href: '/templates', label: 'Templates', icon: FileText },
  {
    href: '/campaigns',
    label: 'Campaigns',
    icon: Megaphone,
    permission: Permission.CAMPAIGNS_MANAGE,
  },
  { href: '/flows', label: 'Flows', icon: Workflow, permission: Permission.FLOWS_MANAGE },
  {
    href: '/integrations',
    label: 'Integrations',
    icon: Plug,
    permission: Permission.INTEGRATIONS_MANAGE,
  },
  { href: '/wallet', label: 'Wallet', icon: Wallet, permission: Permission.WALLET_READ },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const me = useMe();
  // Banners ask the API about the workspace, which a suspended one refuses.
  const usable = Boolean(me.data?.currentOrg) && !me.data?.currentOrg?.suspended;

  return (
    <div className="flex h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
        {/* TODO(branding): partner logo/name plugs in here. */}
        <div className="flex h-14 items-center gap-2 border-b px-4 font-semibold">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <MessageCircle className="size-4" aria-hidden />
          </span>
          WhatsApp CRM
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-2" aria-label="Main">
          {NAV.filter((n) => !n.permission || me.data?.permissions.includes(n.permission)).map(
            ({ href, label, icon: Icon, soon }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return soon ? (
                <span
                  key={href}
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground/60"
                  aria-disabled
                >
                  <Icon className="size-4" aria-hidden /> {label}
                  <span className="ml-auto text-[10px] uppercase tracking-wide">Soon</span>
                </span>
              ) : (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent',
                    active && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                  )}
                >
                  <Icon className="size-4" aria-hidden /> {label}
                </Link>
              );
            },
          )}
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-4 border-b px-4">
          {!me.data ? (
            <Skeleton className="h-8 w-40" />
          ) : me.data.impersonation ? (
            // No switching while inside someone else's workspace: leave it first.
            <span className="truncate text-sm font-medium">{me.data.currentOrg?.name}</span>
          ) : (
            <OrgSwitcher me={me.data} />
          )}
          <div className="flex items-center gap-1">
            {usable && <NotificationBell />}
            {me.data ? <UserMenu me={me.data} /> : <Skeleton className="size-8 rounded-full" />}
          </div>
        </header>
        {me.data?.impersonation && <ImpersonationBanner impersonation={me.data.impersonation} />}
        {me.data && !me.data.user.emailVerified && !me.data.impersonation && (
          <VerifyEmailBanner email={me.data.user.email} />
        )}
        {usable && <CallBar />}
        {usable && <TrialBanner />}
        {usable && <LowBalanceBanner />}
        {usable && <ReconnectBanner />}
        <main className="min-h-0 flex-1 overflow-auto p-6">
          {me.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : me.data && !me.data.currentOrg ? (
            <NoOrg me={me.data} />
          ) : me.data?.currentOrg?.suspended ? (
            <div className="mx-auto max-w-lg py-16 text-center" data-testid="suspended-notice">
              <h1 className="text-xl font-semibold">This workspace is suspended</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {me.data.currentOrg.name} cannot be used for now. Nothing has been deleted. Contact
                whoever manages your account to have it restored, or switch to another workspace.
              </p>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}
