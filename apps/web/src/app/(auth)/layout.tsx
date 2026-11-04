import { MessageCircle } from 'lucide-react';
import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-muted/40 px-4 py-12">
      {/* TODO(branding): partner logo/name plugs in here. */}
      <div className="mb-6 flex items-center gap-2 text-lg font-semibold">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <MessageCircle className="size-4" aria-hidden />
        </span>
        WhatsApp CRM
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
