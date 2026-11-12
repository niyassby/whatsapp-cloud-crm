'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  type AiSettingsDto,
  formatMoney,
  KNOWLEDGE_MIME_TYPES,
  type KnowledgeDocumentDto,
  type KnowledgeHitDto,
  Permission,
} from '@wacrm/shared';
import { FileText, RefreshCw, Trash2, Upload } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { aiKeys, useAiLog, useAiSettings, useKnowledgeDocuments } from '@/lib/ai';
import { api, apiUpload } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { useCan } from '@/lib/queries';
import { useWallet } from '@/lib/wallet';

const textareaClass =
  'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

function Toggle(props: {
  label: string;
  help: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium">{props.label}</span>
        <span className="block text-muted-foreground">{props.help}</span>
      </span>
    </label>
  );
}

function AssistantSettings({ settings }: { settings: AiSettingsDto }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const unavailable = !settings.available.chat;
  const changed =
    draft.enabled !== settings.enabled ||
    draft.inboxAssist !== settings.inboxAssist ||
    draft.autoReply !== settings.autoReply ||
    draft.minConfidence !== settings.minConfidence ||
    draft.instructions !== settings.instructions;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const next = await api<AiSettingsDto>('/ai/settings', {
        method: 'PATCH',
        body: {
          enabled: draft.enabled,
          inboxAssist: draft.inboxAssist,
          autoReply: draft.autoReply,
          minConfidence: draft.minConfidence,
          instructions: draft.instructions,
        },
      });
      queryClient.setQueryData(aiKeys.settings, next);
      setDraft(next);
      toast.success('AI settings saved');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assistant</CardTitle>
        <CardDescription>
          {unavailable
            ? 'AI is not set up on this installation yet. Ask whoever runs it to add an AI provider.'
            : `Answers come from your knowledge base, using ${settings.model}. Every call is logged below and charged to the wallet.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <Toggle
            label="Use AI in this workspace"
            help="Off: nothing below runs, and nothing is charged."
            checked={draft.enabled}
            disabled={unavailable}
            onChange={(enabled) => setDraft({ ...draft, enabled })}
          />
          <Toggle
            label="Help in the inbox"
            help="Suggested replies, summaries and rewrites. An agent always reviews and sends."
            checked={draft.inboxAssist}
            disabled={!draft.enabled}
            onChange={(inboxAssist) => setDraft({ ...draft, inboxAssist })}
          />
          <Toggle
            label="Let flows send AI answers without a person"
            help="Off: a flow's AI step saves its answer as a note and hands the chat to your team. On: confident answers are sent to the customer straight away."
            checked={draft.autoReply}
            disabled={!draft.enabled}
            onChange={(autoReply) => setDraft({ ...draft, autoReply })}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-confidence">Hand over below this confidence</Label>
            <div className="flex items-center gap-2">
              <Input
                id="ai-confidence"
                type="number"
                min={0}
                max={100}
                step={5}
                className="w-24"
                value={Math.round(draft.minConfidence * 100)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    minConfidence: Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100,
                  })
                }
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-instructions">Instructions</Label>
            <textarea
              id="ai-instructions"
              rows={4}
              maxLength={4000}
              className={textareaClass}
              placeholder="For example: We are Chai House, a tea shop in Mumbai. Be warm and brief. Never promise refunds; hand those to a person."
              value={draft.instructions}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            />
          </div>
          <div>
            <Button type="submit" disabled={busy || !changed}>
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const STATUS: Record<
  KnowledgeDocumentDto['status'],
  { label: string; tone: 'secondary' | 'outline' | 'destructive' }
> = {
  pending: { label: 'Waiting', tone: 'outline' },
  indexing: { label: 'Reading', tone: 'outline' },
  ready: { label: 'Ready', tone: 'secondary' },
  failed: { label: 'Failed', tone: 'destructive' },
};

function KnowledgeBase({ available }: { available: boolean }) {
  const queryClient = useQueryClient();
  const docs = useKnowledgeDocuments();
  const fileRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHitDto[] | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: aiKeys.knowledge });
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast.success(done);
      await refresh();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const addText = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api('/ai/knowledge', { method: 'POST', body: { title, content } });
      setTitle('');
      setContent('');
      setAdding(false);
    }, 'Added. It will be ready in a moment.');
  };

  const upload = (file: File) =>
    run(async () => {
      const form = new FormData();
      form.append('file', file);
      await apiUpload('/ai/knowledge/upload', form);
    }, 'Uploaded. It will be ready in a moment.');

  const search = (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    void run(async () => {
      setHits(
        await api<KnowledgeHitDto[]>('/ai/knowledge/search', { method: 'POST', body: { query } }),
      );
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Knowledge base</CardTitle>
        <CardDescription>
          {available
            ? 'What the assistant may answer from: policies, prices, opening hours, FAQs. Text files (.txt, .md, .csv, .json) or pasted text.'
            : 'The knowledge base is not set up on this installation yet.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!available || busy}
            onClick={() => setAdding((v) => !v)}
          >
            <FileText className="size-4" aria-hidden /> Add text
          </Button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            aria-label="Upload a document"
            accept={[
              ...Object.keys(KNOWLEDGE_MIME_TYPES),
              ...Object.values(KNOWLEDGE_MIME_TYPES),
            ].join(',')}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
          />
          <Button
            variant="outline"
            disabled={!available || busy}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="size-4" aria-hidden /> Upload a file
          </Button>
        </div>

        {adding && (
          <form onSubmit={addText} className="flex flex-col gap-2 rounded-md border p-3">
            <Label htmlFor="kb-title">Title</Label>
            <Input
              id="kb-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Label htmlFor="kb-content">Text</Label>
            <textarea
              id="kb-content"
              rows={8}
              className={textareaClass}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !title.trim() || !content.trim()}>
                Add
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        <ul className="divide-y rounded-md border" aria-label="Documents">
          {(docs.data ?? []).length === 0 && (
            <li className="p-3 text-sm text-muted-foreground">No documents yet.</li>
          )}
          {(docs.data ?? []).map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center gap-2 p-3 text-sm"
              data-testid="knowledge-document"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
              <Badge variant={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
              <span className="text-muted-foreground">
                {d.status === 'ready'
                  ? `${d.chunkCount} passages`
                  : `${Math.ceil(d.sizeBytes / 1024)} KB`}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Read ${d.title} again`}
                disabled={busy}
                onClick={() =>
                  void run(() => api(`/ai/knowledge/${d.id}/reindex`, { method: 'POST' }))
                }
              >
                <RefreshCw className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${d.title}`}
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Delete "${d.title}"? The assistant stops using it at once.`))
                    return;
                  void run(() => api(`/ai/knowledge/${d.id}`, { method: 'DELETE' }), 'Deleted');
                }}
              >
                <Trash2 className="size-4" />
              </Button>
              {d.error && <p className="w-full text-destructive">{d.error}</p>}
            </li>
          ))}
        </ul>

        <form onSubmit={search} className="flex flex-col gap-2">
          <Label htmlFor="kb-search">Try a question</Label>
          <div className="flex gap-2">
            <Input
              id="kb-search"
              value={query}
              placeholder="When are you open on Sundays?"
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={!available || busy || !query.trim()}>
              Search
            </Button>
          </div>
          {hits && (
            <ol className="flex flex-col gap-2 text-sm" aria-label="Matching passages">
              {hits.length === 0 && <li className="text-muted-foreground">Nothing matched.</li>}
              {hits.map((h) => (
                <li key={h.chunkId} className="rounded-md border p-2">
                  <span className="font-medium">{h.title}</span>{' '}
                  <span className="text-muted-foreground">{Math.round(h.score * 100)}% match</span>
                  <p className="mt-1 line-clamp-3 whitespace-pre-line text-muted-foreground">
                    {h.content}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

const KIND_LABEL: Record<string, string> = {
  suggestion: 'Suggested reply',
  summary: 'Summary',
  rewrite: 'Rewrite',
  flow_reply: 'Flow answer',
  indexing: 'Reading a document',
};

function Activity() {
  const log = useAiLog();
  const wallet = useWallet(useCan(Permission.WALLET_READ));
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  const currency = wallet.data?.currency ?? 'INR';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>
          Every AI call: what it was asked, what it said, and what it cost.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm" aria-label="AI activity">
          {items.length === 0 && <li className="py-2 text-muted-foreground">Nothing yet.</li>}
          {items.map((l) => (
            <li key={l.id} className="flex flex-col gap-0.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{KIND_LABEL[l.kind] ?? l.kind}</span>
                <Badge
                  variant={
                    l.status === 'failed' || l.status === 'refused' ? 'destructive' : 'outline'
                  }
                >
                  {l.sent ? 'sent' : l.status}
                </Badge>
                {l.confidence !== null && (
                  <span className="text-muted-foreground">
                    {Math.round(l.confidence * 100)}% sure
                  </span>
                )}
                <span className="ml-auto text-muted-foreground">
                  {formatMoney(l.costMicros, currency)} · {new Date(l.createdAt).toLocaleString()}
                </span>
              </div>
              {l.input && <p className="line-clamp-1 text-muted-foreground">Asked: {l.input}</p>}
              {l.output && <p className="line-clamp-2">{l.output}</p>}
              {l.error && <p className="text-destructive">{l.error}</p>}
            </li>
          ))}
        </ul>
        {log.hasNextPage && (
          <Button variant="outline" className="mt-2" onClick={() => void log.fetchNextPage()}>
            Load more
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export default function AiSettingsPage() {
  const canManage = useCan(Permission.AI_MANAGE);
  const settings = useAiSettings(canManage);
  if (!canManage)
    return <p className="text-sm text-muted-foreground">Only owners and admins manage AI.</p>;
  if (!settings.data) return null;
  return (
    <div className="flex flex-col gap-6">
      <AssistantSettings key={JSON.stringify(settings.data)} settings={settings.data} />
      <KnowledgeBase available={settings.data.available.knowledge} />
      <Activity />
    </div>
  );
}
