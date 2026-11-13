'use client';

import { useQueryClient } from '@tanstack/react-query';
import { type ConversationDto, type MessageDto, Permission } from '@wacrm/shared';
import { Phone } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { startCall, useCalls } from '@/lib/calls';
import { handleApiError } from '@/lib/forms';
import { upsertMessage } from '@/lib/inbox';
import { useCan } from '@/lib/queries';

/** Call a WhatsApp customer, or ask them for permission to be called first. */
export function CallActions({ conversation }: { conversation: ConversationDto }) {
  const queryClient = useQueryClient();
  const canCall = useCan(Permission.CALLS_HANDLE);
  const inCall = useCalls((s) => s.active !== null);
  const [busy, setBusy] = useState(false);
  if (conversation.channel.kind !== 'whatsapp' || !canCall) return null;

  const call = async () => {
    setBusy(true);
    try {
      const permission = await api<{ canCall: boolean; status: string }>(
        `/inbox/conversations/${conversation.id}/call-permission`,
      );
      if (!permission.canCall) {
        toast.info('This customer has not allowed calls yet. Ask for permission first.');
        return;
      }
      await startCall(conversation.id);
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const ask = async () => {
    setBusy(true);
    try {
      const message = await api<MessageDto>(
        `/inbox/conversations/${conversation.id}/call-permission`,
        { method: 'POST', body: { clientMessageId: crypto.randomUUID() } },
      );
      upsertMessage(queryClient, message);
      toast.success('Asked for permission to call');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label="Call"
          disabled={busy || inCall}
        >
          <Phone className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void call()}>Call on WhatsApp</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void ask()}>Ask permission to call</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
