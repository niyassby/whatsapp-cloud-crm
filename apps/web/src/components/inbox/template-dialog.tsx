'use client';

import { useQueryClient } from '@tanstack/react-query';
import { type InboxTemplateDto, type MessageDto, renderTemplateBody } from '@wacrm/shared';
import { useState } from 'react';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { upsertMessage, useTemplates } from '@/lib/inbox';

export function TemplateDialog({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<InboxTemplateDto | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const templates = useTemplates(conversationId, open);

  const pick = (t: InboxTemplateDto) => {
    setSelected(t);
    setParams(Array.from({ length: t.paramCount }, () => ''));
  };

  const send = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const message = await api<MessageDto>(`/inbox/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: {
          type: 'template',
          clientMessageId: crypto.randomUUID(),
          templateName: selected.name,
          language: selected.language,
          bodyParams: params.map((p) => p.trim()),
        },
      });
      upsertMessage(queryClient, message);
      setOpen(false);
      setSelected(null);
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const ready = selected && params.every((p) => p.trim());

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Send a template</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a template</DialogTitle>
          <DialogDescription>Approved templates can be sent at any time.</DialogDescription>
        </DialogHeader>

        {templates.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : templates.isError ? (
          <p className="text-sm text-destructive">{templates.error.message}</p>
        ) : !templates.data?.length ? (
          <p className="text-sm text-muted-foreground">
            No approved templates can be sent from the inbox yet. Create one in Meta Business Suite.
          </p>
        ) : !selected ? (
          <ul className="grid max-h-72 gap-1 overflow-y-auto">
            {templates.data.map((t) => (
              <li key={`${t.name}:${t.language}`}>
                <button
                  type="button"
                  className="w-full rounded-md border p-2 text-left hover:bg-muted"
                  onClick={() => pick(t)}
                >
                  <span className="block text-sm font-medium">
                    {t.name} <span className="text-muted-foreground">({t.language})</span>
                  </span>
                  <span className="line-clamp-2 text-sm text-muted-foreground">{t.body}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="grid gap-3">
            <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">
              {
                renderTemplateBody(
                  selected.body,
                  params.map((p, i) => p || `{{${i + 1}}}`),
                ).text
              }
            </p>
            {params.map((value, i) => (
              <FormField
                key={i}
                label={`Value for {{${i + 1}}}`}
                name={`param-${i}`}
                value={value}
                onChange={(e) =>
                  setParams((all) => all.map((p, j) => (j === i ? e.target.value : p)))
                }
              />
            ))}
          </div>
        )}

        <DialogFooter>
          {selected && (
            <Button variant="outline" onClick={() => setSelected(null)}>
              Back
            </Button>
          )}
          <Button disabled={!ready || busy} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Send template'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
