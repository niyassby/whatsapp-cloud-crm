'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  ACCEPTED_MEDIA_TYPES,
  type ConversationDto,
  type MessageDto,
  mediaRuleFor,
} from '@wacrm/shared';
import { Clock, Lock, Paperclip, Send } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useRealtime } from '@/components/realtime-provider';
import { api, ApiError, apiUpload } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { inboxKeys, isWindowOpen, upsertMessage, useCannedReplies } from '@/lib/inbox';
import { cn } from '@/lib/utils';
import { AiMenu } from './ai-menu';
import { TemplateDialog } from './template-dialog';

/** Re-renders when the window closes, so the composer locks without needing a new event. */
function useWindowOpen(conversation: ConversationDto): boolean {
  const [, tick] = useState(0);
  const open = isWindowOpen(conversation);
  const expiresAt = conversation.windowExpiresAt;
  useEffect(() => {
    if (!open || !expiresAt) return;
    const ms = Math.min(new Date(expiresAt).getTime() - Date.now() + 500, 2 ** 31 - 1);
    const timer = setTimeout(() => tick((n) => n + 1), ms);
    return () => clearTimeout(timer);
  }, [open, expiresAt]);
  return open;
}

function remaining(iso: string): string {
  const mins = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 60_000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

const newClientId = () => crypto.randomUUID();

export function Composer({ conversation }: { conversation: ConversationDto }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const socket = useRealtime((s) => s.socket);
  const canned = useCannedReplies();
  const windowOpen = useWindowOpen(conversation);

  const isNote = mode === 'note';
  const numberConnected = conversation.phoneNumber.status === 'connected';
  // Notes never reach the customer, so neither restriction applies to them.
  const locked = !isNote && (!windowOpen || !numberConnected);

  const suggestions = useMemo(() => {
    if (!text.startsWith('/')) return [];
    const q = text.slice(1).toLowerCase();
    return (canned.data ?? []).filter((c) => c.shortcut.startsWith(q)).slice(0, 6);
  }, [text, canned.data]);

  // ---- typing indicator: at most one event every 2 seconds
  const lastTyping = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const emitTyping = (isTyping: boolean) => {
    socket?.emit('typing', { conversationId: conversation.id, isTyping });
  };
  const stopTyping = () => {
    clearTimeout(stopTimer.current);
    if (lastTyping.current) emitTyping(false);
    lastTyping.current = 0;
  };
  const onInput = (value: string) => {
    setText(value);
    if (isNote || !value) return stopTyping();
    const now = Date.now();
    if (now - lastTyping.current > 2000) {
      lastTyping.current = now;
      emitTyping(true);
    }
    clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(stopTyping, 3000);
  };
  useEffect(() => () => clearTimeout(stopTimer.current), []);

  const send = async () => {
    const body = text.trim();
    if (!body || busy || locked) return;
    setBusy(true);
    stopTyping();
    try {
      const message = isNote
        ? await api<MessageDto>(`/inbox/conversations/${conversation.id}/notes`, {
            method: 'POST',
            body: { clientMessageId: newClientId(), body },
          })
        : await api<MessageDto>(`/inbox/conversations/${conversation.id}/messages`, {
            method: 'POST',
            body: { type: 'text', clientMessageId: newClientId(), body },
          });
      upsertMessage(queryClient, message);
      setText('');
    } catch (err) {
      // The server's clock decides: refresh so the banner matches what it just told us.
      if (err instanceof ApiError && err.code === 'WINDOW_CLOSED') {
        void queryClient.invalidateQueries({
          queryKey: inboxKeys.conversation(conversation.id),
        });
      }
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (suggestions[0] && text.startsWith('/')) setText(suggestions[0].body);
      else void send();
    }
  };

  const upload = async (file: File) => {
    const rule = mediaRuleFor(file.type);
    if (!rule) return toast.error('WhatsApp does not accept this file type');
    if (file.size > rule.maxBytes) {
      return toast.error(`This file is over the ${Math.round(rule.maxBytes / 1048576)} MB limit`);
    }
    const form = new FormData();
    // Fields first: the API reads them from the part before the file.
    form.append('clientMessageId', newClientId());
    if (text.trim()) form.append('caption', text.trim());
    form.append('file', file);
    setBusy(true);
    try {
      upsertMessage(
        queryClient,
        await apiUpload<MessageDto>(`/inbox/conversations/${conversation.id}/messages/media`, form),
      );
      setText('');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-t bg-background">
      {!numberConnected && (
        <p role="status" className="bg-muted px-3 py-2 text-sm text-muted-foreground">
          This WhatsApp number is not connected, so replies cannot be sent.
        </p>
      )}
      {numberConnected && !windowOpen && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <span className="flex items-center gap-1.5">
            <Clock className="size-4 shrink-0" aria-hidden />
            The 24-hour window has closed. You can only send an approved template until the customer
            replies.
          </span>
          <TemplateDialog
            conversationId={conversation.id}
            optInStatus={conversation.contact.optInStatus}
          />
        </div>
      )}

      <div className="relative p-2">
        {suggestions.length > 0 && !locked && (
          <ul
            aria-label="Canned replies"
            className="absolute bottom-full left-2 right-2 mb-1 overflow-hidden rounded-md border bg-popover shadow-md"
          >
            {suggestions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="w-full truncate px-3 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => setText(s.body)}
                >
                  <span className="font-medium">/{s.shortcut}</span>{' '}
                  <span className="text-muted-foreground">{s.body}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mb-1 flex items-center gap-1" role="group" aria-label="Message type">
          <Button
            size="sm"
            className="h-7"
            variant={mode === 'reply' ? 'secondary' : 'ghost'}
            aria-pressed={mode === 'reply'}
            onClick={() => setMode('reply')}
          >
            Reply
          </Button>
          <Button
            size="sm"
            className="h-7"
            variant={isNote ? 'secondary' : 'ghost'}
            aria-pressed={isNote}
            onClick={() => setMode('note')}
          >
            <Lock className="size-3" aria-hidden /> Note
          </Button>
          {numberConnected && windowOpen && !isNote && conversation.windowExpiresAt && (
            <span className="ml-auto text-xs text-muted-foreground">
              Window closes in {remaining(conversation.windowExpiresAt)}
            </span>
          )}
        </div>

        <div className="flex items-end gap-1">
          {!isNote && (
            <>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                accept={ACCEPTED_MEDIA_TYPES.join(',')}
                aria-label="Attach a file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void upload(file);
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Attach a file"
                disabled={locked || busy}
                onClick={() => fileRef.current?.click()}
              >
                <Paperclip className="size-4" />
              </Button>
            </>
          )}
          <AiMenu
            conversationId={conversation.id}
            draft={text}
            disabled={locked}
            onText={(value) => setText(value)}
          />
          <textarea
            value={text}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={stopTyping}
            disabled={locked}
            rows={2}
            maxLength={4096}
            aria-label={isNote ? 'Internal note' : 'Message'}
            placeholder={
              locked
                ? 'Free-form messages are unavailable'
                : isNote
                  ? 'Write a note only your team can see'
                  : 'Type a message. Use / for canned replies'
            }
            className={cn(
              'min-h-10 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
              isNote && 'border-amber-300 bg-amber-50/60 dark:bg-amber-950/40',
            )}
          />
          <Button
            size="icon"
            aria-label={isNote ? 'Add note' : 'Send message'}
            disabled={locked || busy || !text.trim()}
            onClick={() => void send()}
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
