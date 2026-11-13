'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CHANNEL_LABELS,
  type ChannelDto,
  type InstagramStartDto,
  Permission,
  type WebchatConfig,
} from '@wacrm/shared';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { env } from '@/lib/env';
import { handleApiError } from '@/lib/forms';
import { useCan } from '@/lib/queries';

const useChannels = () =>
  useQuery({ queryKey: ['channels'], queryFn: () => api<ChannelDto[]>('/channels') });

const INSTAGRAM_RESULTS: Record<string, { title: string; ok: boolean }> = {
  connected: { title: 'Instagram account connected', ok: true },
  cancelled: { title: 'Instagram login was cancelled', ok: false },
  expired: { title: 'That login link expired. Try again.', ok: false },
  taken: { title: 'This Instagram account is connected to another workspace', ok: false },
  error: { title: 'Instagram could not be connected', ok: false },
};

function InstagramNotice() {
  const result = useSearchParams().get('instagram');
  const notice = result ? INSTAGRAM_RESULTS[result] : undefined;
  if (!notice) return null;
  return (
    <Alert variant={notice.ok ? 'default' : 'destructive'}>
      <AlertTitle>{notice.title}</AlertTitle>
    </Alert>
  );
}

function embedCode(key: string): string {
  return `<script src="${env.NEXT_PUBLIC_API_URL}/webchat/widget.js" data-key="${key}" async></script>`;
}

function WebchatEditor({ channel, onDone }: { channel: ChannelDto; onDone: () => void }) {
  const queryClient = useQueryClient();
  const config = channel.config as WebchatConfig;
  const [form, setForm] = useState({
    name: channel.name,
    title: config.title,
    greeting: config.greeting,
    color: config.color,
    allowed: config.allowedOrigins.join('\n'),
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/channels/${channel.id}`, {
        method: 'PATCH',
        body: {
          name: form.name,
          config: {
            title: form.title,
            greeting: form.greeting,
            color: form.color,
            allowedOrigins: form.allowed
              .split(/\s+/)
              .map((s) => s.trim())
              .filter(Boolean),
          },
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Saved');
      onDone();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="grid gap-3 border-t pt-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label="Name"
          name={`wc-name-${channel.id}`}
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <FormField
          label="Title"
          name={`wc-title-${channel.id}`}
          value={form.title}
          onChange={(e) => set({ title: e.target.value })}
        />
      </div>
      <FormField
        label="Greeting"
        name={`wc-greeting-${channel.id}`}
        value={form.greeting}
        onChange={(e) => set({ greeting: e.target.value })}
      />
      <FormField
        label="Colour"
        name={`wc-color-${channel.id}`}
        value={form.color}
        onChange={(e) => set({ color: e.target.value })}
      />
      <div className="grid gap-1.5">
        <label htmlFor={`wc-allowed-${channel.id}`} className="text-sm font-medium">
          Allowed sites
        </label>
        <textarea
          id={`wc-allowed-${channel.id}`}
          rows={3}
          className="rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          placeholder="https://example.com"
          value={form.allowed}
          onChange={(e) => set({ allowed: e.target.value })}
        />
        <p className="text-sm text-muted-foreground">
          One per line. Leave empty to allow any site.
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          Save
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ChannelCard({ channel }: { channel: ChannelDto }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const live = channel.status === 'active';

  const disconnect = async () => {
    if (!window.confirm(`Disconnect ${channel.name}? Its conversations stay in the inbox.`)) return;
    try {
      await api(`/channels/${channel.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <li className="flex flex-col gap-3 py-3" data-testid={`channel-${channel.kind}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{channel.name}</span>
        <Badge variant="secondary">{CHANNEL_LABELS[channel.kind]}</Badge>
        {!live && <Badge variant="outline">Disconnected</Badge>}
        {channel.detail && <span className="text-sm text-muted-foreground">{channel.detail}</span>}
        {live && channel.kind !== 'whatsapp' && (
          <span className="ml-auto flex gap-2">
            {channel.kind === 'webchat' && (
              <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)}>
                Settings
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </span>
        )}
      </div>
      {live && channel.widgetKey && (
        <div className="grid gap-1.5">
          <span className="text-sm text-muted-foreground">
            Paste this before the closing &lt;/body&gt; tag of your site:
          </span>
          <div className="flex items-start gap-2">
            <code
              className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs"
              data-testid="embed-code"
            >
              {embedCode(channel.widgetKey)}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(embedCode(channel.widgetKey!));
                toast.success('Copied');
              }}
            >
              Copy
            </Button>
          </div>
        </div>
      )}
      {editing && <WebchatEditor channel={channel} onDone={() => setEditing(false)} />}
    </li>
  );
}

function AddChannels() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const createWidget = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/channels/webchat', { method: 'POST', body: { name: name.trim() } });
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
      setName('');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const instagram = async () => {
    setBusy(true);
    try {
      const { url } = await api<InstagramStartDto>('/channels/instagram/start', { method: 'POST' });
      window.location.assign(url);
    } catch (err) {
      handleApiError(err);
      setBusy(false);
    }
  };

  const instagramToken = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/channels/instagram/token', {
        method: 'POST',
        body: { accessToken: token.trim() },
      });
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
      setToken('');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Website chat</CardTitle>
          <CardDescription>
            A chat button for your site. Messages arrive in the inbox with everything else.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex items-end gap-2" onSubmit={(e) => void createWidget(e)}>
            <div className="flex-1">
              <FormField
                label="Widget name"
                name="webchat-name"
                placeholder="Main site"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy || !name.trim()}>
              Add website chat
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Instagram</CardTitle>
          <CardDescription>
            Answer Instagram direct messages from the inbox. Needs an Instagram professional
            account.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button className="self-start" disabled={busy} onClick={() => void instagram()}>
            Connect Instagram
          </Button>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Connect with a token</summary>
            <form className="mt-2 flex items-end gap-2" onSubmit={(e) => void instagramToken(e)}>
              <div className="flex-1">
                <FormField
                  label="Long-lived access token"
                  name="instagram-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </div>
              <Button type="submit" variant="outline" disabled={busy || token.trim().length < 20}>
                Connect
              </Button>
            </form>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}

export default function ChannelsPage() {
  const canManage = useCan(Permission.CHANNELS_MANAGE);
  const channels = useChannels();
  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">Only owners and admins can manage channels.</p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Suspense>
        <InstagramNotice />
      </Suspense>
      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>
          <CardDescription>
            Everywhere customers can reach you. WhatsApp numbers are managed in Settings &gt;
            WhatsApp.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {channels.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : !channels.data?.length ? (
            <p className="text-sm text-muted-foreground">No channels yet.</p>
          ) : (
            <ul className="divide-y">
              {channels.data.map((c) => (
                <ChannelCard key={c.id} channel={c} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <AddChannels />
    </div>
  );
}
