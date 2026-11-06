'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  canReceiveMarketing,
  formatMoney,
  type InboxTemplateDto,
  isMarketingCategory,
  type MessageDto,
  type OptInStatus,
  renderTemplate,
} from '@wacrm/shared';
import { useState } from 'react';
import { FormField } from '@/components/form-field';
import { TemplatePreview } from '@/components/templates/template-preview';
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

export function TemplateDialog({
  conversationId,
  optInStatus,
}: {
  conversationId: string;
  optInStatus: OptInStatus;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<InboxTemplateDto | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const templates = useTemplates(conversationId, open);

  const pick = (t: InboxTemplateDto) => {
    setSelected(t);
    setValues(Object.fromEntries(t.variables.map((v) => [v.key, v.value])));
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
          templateId: selected.id,
          variables: values,
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

  const ready = selected && selected.variables.every((v) => values[v.key]?.trim());

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Send a template</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
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
            No approved templates yet. Create one under Templates.
          </p>
        ) : !selected ? (
          <ul className="grid max-h-72 gap-1 overflow-y-auto">
            {templates.data.map((t) => {
              const consentBlocked =
                isMarketingCategory(t.category) && !canReceiveMarketing(optInStatus);
              const blocked = consentBlocked || Boolean(t.sendIssue);
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    disabled={blocked}
                    className="w-full rounded-md border p-2 text-left enabled:hover:bg-muted disabled:opacity-60"
                    onClick={() => pick(t)}
                  >
                    <span className="block text-sm font-medium">
                      {t.name} <span className="text-muted-foreground">({t.language})</span>
                    </span>
                    <span className="line-clamp-2 text-sm text-muted-foreground">
                      {t.definition.body}
                    </span>
                    {t.cost && t.cost.micros > 0 && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Costs {formatMoney(t.cost.micros, t.cost.currency)}
                      </span>
                    )}
                    {consentBlocked ? (
                      <span className="mt-1 block text-xs text-destructive">
                        {optInStatus === 'opted_out'
                          ? 'Marketing template: this contact opted out'
                          : 'Marketing template: record this contact’s consent first'}
                      </span>
                    ) : (
                      t.sendIssue && (
                        <span className="mt-1 block text-xs text-destructive">{t.sendIssue}</span>
                      )
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="grid gap-3">
            {selected.cost && (
              <p className="text-sm text-muted-foreground">
                {selected.cost.micros > 0
                  ? `This send costs ${formatMoney(selected.cost.micros, selected.cost.currency)} from your wallet.`
                  : 'This send is free.'}
              </p>
            )}
            <TemplatePreview
              definition={selected.definition}
              values={Object.fromEntries(
                selected.variables.map((v) => [v.key, values[v.key] ?? '']),
              )}
            />
            {selected.variables.map((v) => (
              <FormField
                key={v.key}
                label={v.label}
                name={`variable-${v.key}`}
                value={values[v.key] ?? ''}
                onChange={(e) => setValues((all) => ({ ...all, [v.key]: e.target.value }))}
              />
            ))}
            <span className="sr-only" aria-live="polite">
              {renderTemplate(selected.definition, values).body}
            </span>
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
