'use client';

import { Permission } from '@wacrm/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useMe } from '@/lib/queries';
import { cn } from '@/lib/utils';

const ITEMS: { href: string; label: string; permission?: Permission }[] = [
  { href: '/settings/general', label: 'General', permission: Permission.ORG_READ },
  { href: '/settings/team', label: 'Team', permission: Permission.TEAM_READ },
  { href: '/settings/whatsapp', label: 'WhatsApp', permission: Permission.WHATSAPP_MANAGE },
  { href: '/settings/inbox', label: 'Inbox', permission: Permission.INBOX_ASSIGN },
  { href: '/settings/contacts', label: 'Contacts', permission: Permission.CONTACTS_MANAGE },
  { href: '/settings/billing', label: 'Billing', permission: Permission.BILLING_READ },
  { href: '/settings/api-keys', label: 'API keys', permission: Permission.API_KEYS_MANAGE },
  { href: '/settings/webhooks', label: 'Webhooks', permission: Permission.API_KEYS_MANAGE },
  { href: '/settings/security', label: 'Security' },
  { href: '/settings/audit', label: 'Audit log', permission: Permission.AUDIT_READ },
  // Later phases: API keys, billing, integrations.
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: me } = useMe();
  const items = ITEMS.filter((i) => !i.permission || me?.permissions.includes(i.permission));

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="mt-6 flex flex-col gap-6 md:flex-row">
        <nav className="flex gap-1 overflow-x-auto md:w-48 md:flex-col" aria-label="Settings">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap rounded-md px-3 py-2 text-sm hover:bg-muted',
                pathname === item.href && 'bg-muted font-medium',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <section className="min-w-0 flex-1">{children}</section>
      </div>
    </div>
  );
}
