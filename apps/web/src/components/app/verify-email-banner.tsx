'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';

export function VerifyEmailBanner({ email }: { email: string }) {
  const [sending, setSending] = useState(false);

  const resend = async () => {
    setSending(true);
    try {
      await api('/auth/resend-verification', { method: 'POST' });
      toast.success(`Verification email sent to ${email}`);
    } catch (err) {
      handleApiError(err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      <span>Confirm your email address ({email}) to keep your account secure.</span>
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-inherit underline"
        disabled={sending}
        onClick={() => void resend()}
      >
        {sending ? 'Sending…' : 'Resend email'}
      </Button>
    </div>
  );
}
