import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

// TODO(branding): title/favicon per partner would plug in here.
export const metadata: Metadata = {
  title: { default: 'WhatsApp CRM', template: '%s · WhatsApp CRM' },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The per-request CSP nonce from proxy.ts. Reading it also renders every page per request,
  // which a nonce needs.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <Providers nonce={nonce}>{children}</Providers>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
