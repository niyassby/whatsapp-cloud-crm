'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Permission } from '@wacrm/shared';
import { Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { inboxKeys, useCannedReplies, useLabels } from '@/lib/inbox';
import { useCan } from '@/lib/queries';

export default function InboxSettingsPage() {
  const canManage = useCan(Permission.INBOX_ASSIGN);
  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        Only owners and admins can manage labels and canned replies.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <LabelsCard />
      <CannedRepliesCard />
    </div>
  );
}

function LabelsCard() {
  const queryClient = useQueryClient();
  const labels = useLabels();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#64748b');
  const refresh = () => queryClient.invalidateQueries({ queryKey: inboxKeys.labels });

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/inbox/labels', { method: 'POST', body: { name, color } });
      setName('');
      await refresh();
    } catch (err) {
      handleApiError(err);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/inbox/labels/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Labels</CardTitle>
        <CardDescription>Tag conversations so your team can organise them.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form onSubmit={(e) => void add(e)} className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <FormField
              label="Name"
              name="label-name"
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="label-color" className="text-sm font-medium">
              Colour
            </label>
            <input
              id="label-color"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
            />
          </div>
          <Button type="submit" disabled={!name.trim()}>
            Add label
          </Button>
        </form>
        <ul className="flex flex-wrap gap-2">
          {labels.data?.map((label) => (
            <li
              key={label.id}
              className="flex items-center gap-1.5 rounded-full border py-0.5 pl-2 pr-1 text-sm"
            >
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: label.color }}
                aria-hidden
              />
              {label.name}
              <button
                type="button"
                aria-label={`Delete label ${label.name}`}
                className="rounded-full p-1 hover:bg-muted"
                onClick={() => void remove(label.id)}
              >
                <Trash2 className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function CannedRepliesCard() {
  const queryClient = useQueryClient();
  const replies = useCannedReplies();
  const [shortcut, setShortcut] = useState('');
  const [body, setBody] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: inboxKeys.canned });

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/inbox/canned-replies', { method: 'POST', body: { shortcut, body } });
      setShortcut('');
      setBody('');
      await refresh();
    } catch (err) {
      handleApiError(err);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/inbox/canned-replies/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Canned replies</CardTitle>
        <CardDescription>Type / in the composer to insert one.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form onSubmit={(e) => void add(e)} className="grid gap-3">
          <FormField
            label="Shortcut"
            name="canned-shortcut"
            hint="Letters, numbers, - and _"
            maxLength={32}
            value={shortcut}
            onChange={(e) => setShortcut(e.target.value)}
          />
          <div className="grid gap-1.5">
            <label htmlFor="canned-body" className="text-sm font-medium">
              Message
            </label>
            <textarea
              id="canned-body"
              rows={3}
              maxLength={4096}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <Button
            type="submit"
            className="justify-self-start"
            disabled={!shortcut.trim() || !body.trim()}
          >
            Add canned reply
          </Button>
        </form>
        <ul className="grid gap-2">
          {replies.data?.map((reply) => (
            <li key={reply.id} className="flex items-start gap-2 rounded-md border p-2 text-sm">
              <span className="font-medium">/{reply.shortcut}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-muted-foreground">
                {reply.body}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete canned reply ${reply.shortcut}`}
                onClick={() => void remove(reply.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
