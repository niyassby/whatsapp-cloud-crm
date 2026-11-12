'use client';

import {
  AI_TONE_LABELS,
  AI_TONES,
  type AiSuggestionDto,
  type AiTextDto,
  type AiTone,
  Permission,
} from '@wacrm/shared';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAiSettings } from '@/lib/ai';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { useCan } from '@/lib/queries';

/**
 * AI help for the agent: a suggested reply from the knowledge base, a rewrite of the draft, a
 * summary of the conversation. Nothing is sent: the agent reads, edits and sends.
 */
export function AiMenu(props: {
  conversationId: string;
  draft: string;
  disabled: boolean;
  onText: (text: string) => void;
}) {
  const canReply = useCan(Permission.INBOX_REPLY);
  const settings = useAiSettings(canReply);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const s = settings.data;
  if (!s || !s.available.chat || !s.enabled || !s.inboxAssist) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const suggest = () =>
    run(async () => {
      const r = await api<AiSuggestionDto>(`/ai/conversations/${props.conversationId}/suggest`, {
        method: 'POST',
      });
      if (!r.text) {
        toast.info(r.note ?? 'The assistant has no answer for this one.');
        return;
      }
      props.onText(r.text);
      const from = r.sources.map((x) => x.title).join(', ');
      toast.success(
        `Suggestion added to the reply box: ${Math.round(r.confidence * 100)}% sure${from ? `, from ${from}` : ''}. Check it before sending.`,
      );
    });

  const rewrite = (tone: AiTone) =>
    run(async () => {
      const r = await api<AiTextDto>('/ai/rewrite', {
        method: 'POST',
        body: { text: props.draft, tone },
      });
      if (r.text) props.onText(r.text);
    });

  const summarize = () =>
    run(async () => {
      const r = await api<AiTextDto>(`/ai/conversations/${props.conversationId}/summarize`, {
        method: 'POST',
      });
      setSummary(r.text);
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="AI help" disabled={busy}>
            <Sparkles className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem disabled={props.disabled} onSelect={() => void suggest()}>
            Suggest a reply
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void summarize()}>
            Summarize conversation
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Rewrite my draft
          </DropdownMenuLabel>
          {AI_TONES.map((tone) => (
            <DropdownMenuItem
              key={tone}
              disabled={!props.draft.trim()}
              onSelect={() => void rewrite(tone)}
            >
              {AI_TONE_LABELS[tone]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={summary !== null} onOpenChange={(open) => !open && setSummary(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Conversation summary</DialogTitle>
            <DialogDescription>Written by AI from the latest messages.</DialogDescription>
          </DialogHeader>
          <p className="whitespace-pre-line text-sm" data-testid="ai-summary">
            {summary}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
