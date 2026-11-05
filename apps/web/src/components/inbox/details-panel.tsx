'use client';

import { useQueryClient } from '@tanstack/react-query';
import { type ConversationDto, Permission } from '@wacrm/shared';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useRealtime } from '@/components/realtime-provider';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { applyConversationUpdate, displayWaId, inboxKeys, useLabels } from '@/lib/inbox';
import { useCan, useMe, useMembers } from '@/lib/queries';
import { cn } from '@/lib/utils';

const UNASSIGNED = 'unassigned';

export function DetailsPanel({ conversation }: { conversation: ConversationDto }) {
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const members = useMembers();
  const labels = useLabels();
  const online = useRealtime((s) => s.online);
  const canAssign = useCan(Permission.INBOX_ASSIGN);
  const [busy, setBusy] = useState(false);

  const myId = me?.user.id;
  const isMine = conversation.assignee?.id === myId;
  const applied = new Set(conversation.labels.map((l) => l.id));

  const patch = async (body: { status?: 'open' | 'closed'; assigneeId?: string | null }) => {
    setBusy(true);
    try {
      applyConversationUpdate(
        queryClient,
        await api<ConversationDto>(`/inbox/conversations/${conversation.id}`, {
          method: 'PATCH',
          body,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists });
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const toggleLabel = async (id: string) => {
    const next = new Set(applied);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      applyConversationUpdate(
        queryClient,
        await api<ConversationDto>(`/inbox/conversations/${conversation.id}/labels`, {
          method: 'PUT',
          body: { labelIds: [...next] },
        }),
      );
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <aside className="grid gap-6 p-4" aria-label="Conversation details">
      <div>
        <h3 className="font-semibold">{conversation.contact.name ?? conversation.contact.waId}</h3>
        <p className="text-sm text-muted-foreground">{displayWaId(conversation.contact.waId)}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Via {conversation.phoneNumber.display ?? 'your number'}
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="assignee">Assigned to</Label>
        {canAssign ? (
          <Select
            value={conversation.assignee?.id ?? UNASSIGNED}
            disabled={busy}
            onValueChange={(v) => void patch({ assigneeId: v === UNASSIGNED ? null : v })}
          >
            <SelectTrigger id="assignee" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
              {members.data?.map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      online[m.userId] ? 'bg-emerald-500' : 'bg-muted-foreground/30',
                    )}
                    aria-hidden
                  />
                  {m.name}
                  <span className="sr-only">{online[m.userId] ? ' (online)' : ' (offline)'}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span id="assignee">{conversation.assignee?.name ?? 'Unassigned'}</span>
            {!conversation.assignee && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void patch({ assigneeId: myId })}
              >
                Assign to me
              </Button>
            )}
            {isMine && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void patch({ assigneeId: null })}
              >
                Release
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-1.5">
        <span className="text-sm font-medium">Status</span>
        <div className="flex items-center gap-2">
          <Badge
            variant={conversation.status === 'open' ? 'default' : 'secondary'}
            className="capitalize"
          >
            {conversation.status}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void patch({ status: conversation.status === 'open' ? 'closed' : 'open' })
            }
          >
            {conversation.status === 'open' ? 'Close' : 'Reopen'}
          </Button>
        </div>
      </div>

      <div className="grid gap-1.5">
        <span className="text-sm font-medium">Labels</span>
        {labels.data?.length ? (
          <ul className="flex flex-wrap gap-1">
            {labels.data.map((label) => {
              const on = applied.has(label.id);
              return (
                <li key={label.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => void toggleLabel(label.id)}
                    className={cn(
                      'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                      on ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60',
                    )}
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: label.color }}
                      aria-hidden
                    />
                    {label.name}
                    {on && <Check className="size-3" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {canAssign ? 'Create labels in Settings > Inbox.' : 'No labels yet.'}
          </p>
        )}
      </div>
    </aside>
  );
}
