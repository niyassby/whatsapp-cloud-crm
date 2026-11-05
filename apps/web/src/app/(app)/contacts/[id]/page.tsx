'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  type ContactConversationDto,
  type ContactDto,
  type ContactFieldDto,
  Permission,
} from '@wacrm/shared';
import { ArrowLeft, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { ConsentBadge } from '@/components/contacts/consent-badge';
import { TagChip } from '@/components/contacts/tag-chip';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import {
  contactKeys,
  contactLabel,
  OPT_IN_LABELS,
  useConsentHistory,
  useContact,
  useContactConversations,
  useContactFields,
  useContactNotes,
  useConversationHistory,
  useTags,
} from '@/lib/contacts';
import { handleApiError } from '@/lib/forms';
import { displayWaId } from '@/lib/inbox';
import { useCan, useMe } from '@/lib/queries';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never');
const EMPTY = '__empty__';

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ContactFieldDto;
  value: string;
  onChange: (value: string) => void;
}) {
  if (field.type === 'select' || field.type === 'boolean') {
    const options =
      field.type === 'select'
        ? field.options.map((o) => ({ value: o, label: o }))
        : [
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ];
    const id = `field-${field.key}`;
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={id}>{field.label}</Label>
        <Select value={value || EMPTY} onValueChange={(v) => onChange(v === EMPTY ? '' : v)}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={EMPTY}>Not set</SelectItem>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  return (
    <FormField
      label={field.label}
      name={`field-${field.key}`}
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      step={field.type === 'number' ? 'any' : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function DetailsCard({ contact, canWrite }: { contact: ContactDto; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const fields = useContactFields();
  const [name, setName] = useState(contact.name ?? '');
  const [email, setEmail] = useState(contact.email ?? '');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(contact.customFields).map(([k, v]) => [k, String(v)])),
  );
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      // Only known fields are sent. An emptied one is removed.
      const customFields = Object.fromEntries(
        (fields.data ?? []).map((f) => [f.key, values[f.key] ? values[f.key] : null]),
      );
      const updated = await api<ContactDto>(`/contacts/${contact.id}`, {
        method: 'PATCH',
        body: { name: name.trim() || null, email: email.trim() || null, customFields },
      });
      queryClient.setQueryData(contactKeys.contact(contact.id), updated);
      await queryClient.invalidateQueries({ queryKey: contactKeys.lists });
      toast.success('Saved');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void save(e)} className="grid gap-3">
          <fieldset disabled={!canWrite} className="grid gap-3">
            <FormField
              label="Name"
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <FormField
              label="Email"
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {fields.data?.map((f) => (
              <FieldInput
                key={f.id}
                field={f}
                value={values[f.key] ?? ''}
                onChange={(v) => setValues((all) => ({ ...all, [f.key]: v }))}
              />
            ))}
          </fieldset>
          {canWrite && (
            <div>
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function TagsCard({ contact, canWrite }: { contact: ContactDto; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const tags = useTags();
  const [newTag, setNewTag] = useState('');
  const current = new Set(contact.tags.map((t) => t.id));

  const apply = async (tagIds: string[]) => {
    const updated = await api<ContactDto>(`/contacts/${contact.id}/tags`, {
      method: 'PUT',
      body: { tagIds },
    });
    queryClient.setQueryData(contactKeys.contact(contact.id), updated);
    await queryClient.invalidateQueries({ queryKey: contactKeys.lists });
  };

  const toggle = async (id: string) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      await apply([...next]);
    } catch (err) {
      handleApiError(err);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const tag = await api<{ id: string }>('/contact-tags', {
        method: 'POST',
        body: { name: newTag },
      });
      setNewTag('');
      await queryClient.invalidateQueries({ queryKey: contactKeys.tags });
      await apply([...current, tag.id]);
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tags</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {canWrite ? (
          <ul className="flex flex-wrap gap-1.5">
            {tags.data?.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  aria-pressed={current.has(t.id)}
                  className={current.has(t.id) ? '' : 'opacity-50 hover:opacity-100'}
                  onClick={() => void toggle(t.id)}
                >
                  <TagChip tag={t} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {contact.tags.map((t) => (
              <TagChip key={t.id} tag={t} />
            ))}
          </div>
        )}
        {canWrite && (
          <form onSubmit={(e) => void create(e)} className="flex items-end gap-2">
            <div className="flex-1">
              <FormField
                label="New tag"
                name="new-tag"
                value={newTag}
                maxLength={40}
                onChange={(e) => setNewTag(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={!newTag.trim()}>
              Add
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function ConsentCard({ contact, canWrite }: { contact: ContactDto; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const history = useConsentHistory(contact.id);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [proof, setProof] = useState('');
  const [busy, setBusy] = useState(false);

  const change = async (body: object) => {
    setBusy(true);
    try {
      const updated = await api<ContactDto>(`/contacts/${contact.id}/consent`, {
        method: 'POST',
        body,
      });
      queryClient.setQueryData(contactKeys.contact(contact.id), updated);
      await queryClient.invalidateQueries({ queryKey: contactKeys.all });
      setOpen(false);
      setSource('');
      setProof('');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Marketing consent <ConsentBadge status={contact.optInStatus} />
        </CardTitle>
        <CardDescription>
          {contact.optInStatus === 'opted_in'
            ? `From ${contact.optInSource ?? 'an unknown source'} on ${when(contact.optInAt)}.`
            : contact.optInStatus === 'opted_out'
              ? `Opted out on ${when(contact.optOutAt)}. Marketing templates are blocked.`
              : 'Marketing templates are blocked until consent is recorded.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {canWrite && (
          <div className="flex gap-2">
            {contact.optInStatus !== 'opted_in' && (
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline">
                    Record opt-in
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Record opt-in</DialogTitle>
                    <DialogDescription>
                      {contact.optInStatus === 'opted_out'
                        ? 'This person opted out. Only continue if they have since asked to hear from you again.'
                        : 'Only record this if this person agreed to receive marketing messages from you.'}
                    </DialogDescription>
                  </DialogHeader>
                  <FormField
                    label="Where consent came from"
                    name="consent-source"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    placeholder="In-store form"
                  />
                  <FormField
                    label="Proof of consent"
                    name="consent-proof"
                    value={proof}
                    onChange={(e) => setProof(e.target.value)}
                    placeholder="Signed form #1042, kept at the Kochi branch"
                  />
                  <DialogFooter>
                    <Button
                      disabled={busy || !source.trim() || proof.trim().length < 3}
                      onClick={() => void change({ status: 'opted_in', source, proof })}
                    >
                      Save consent
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
            {contact.optInStatus !== 'opted_out' && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void change({ status: 'opted_out' })}
              >
                Opt out
              </Button>
            )}
          </div>
        )}
        <div>
          <h3 className="mb-1 text-sm font-medium">History</h3>
          {history.data?.length ? (
            <ul className="grid gap-2 text-sm">
              {history.data.map((e) => (
                <li key={e.id} className="border-l-2 pl-2">
                  <span className="font-medium">{OPT_IN_LABELS[e.status]}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    · {e.source ?? 'unknown'} · {when(e.createdAt)}
                    {e.actorName ? ` · ${e.actorName}` : ''}
                  </span>
                  {e.proof && <p className="break-words text-muted-foreground">{e.proof}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No changes recorded.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NotesCard({ contact, canWrite }: { contact: ContactDto; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const notes = useContactNotes(contact.id);
  const { data: me } = useMe();
  const canManage = useCan(Permission.CONTACTS_MANAGE);
  const [body, setBody] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: contactKeys.notes(contact.id) });

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/contacts/${contact.id}/notes`, { method: 'POST', body: { body } });
      setBody('');
      await refresh();
    } catch (err) {
      handleApiError(err);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/contacts/${contact.id}/notes/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notes</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {canWrite && (
          <form onSubmit={(e) => void add(e)} className="flex items-end gap-2">
            <div className="flex-1">
              <FormField
                label="Add a note"
                name="note"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={!body.trim()}>
              Add
            </Button>
          </form>
        )}
        <ul className="grid gap-2 text-sm">
          {notes.data?.map((n) => (
            <li key={n.id} className="flex items-start gap-2 rounded-md bg-muted p-2">
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap break-words">{n.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {n.authorName ?? 'Former member'} · {when(n.createdAt)}
                </p>
              </div>
              {(canManage || n.authorId === me?.user.id) && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Delete note"
                  onClick={() => void remove(n.id)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ThreadHistory({ conversation }: { conversation: ContactConversationDto }) {
  const history = useConversationHistory(conversation.id);
  const items = history.data?.pages.flatMap((p) => p.items).reverse() ?? [];
  return (
    <div className="grid gap-2">
      {history.hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          Load older messages
        </Button>
      )}
      {history.isPending && <Skeleton className="h-16 w-full" />}
      <ul className="grid max-h-96 gap-1.5 overflow-y-auto text-sm">
        {items.map((m) => (
          <li
            key={m.id}
            className={`max-w-[85%] rounded-md p-2 ${
              m.direction === 'inbound'
                ? 'justify-self-start bg-muted'
                : m.direction === 'internal'
                  ? 'justify-self-end border border-dashed'
                  : 'justify-self-end bg-primary/10'
            }`}
          >
            <p className="whitespace-pre-wrap break-words">{m.body ?? `[${m.type}]`}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {when(m.createdAt)}
              {m.direction === 'internal' ? ' · note' : ''}
              {m.direction === 'outbound' ? ` · ${m.status}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConversationsCard({ contactId }: { contactId: string }) {
  const conversations = useContactConversations(contactId);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversation history</CardTitle>
      </CardHeader>
      <CardContent>
        {conversations.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : !conversations.data?.length ? (
          <p className="text-sm text-muted-foreground">No conversations yet.</p>
        ) : (
          <ul className="grid gap-3">
            {conversations.data.map((c) => (
              <li key={c.id} className="grid gap-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{c.phoneDisplay ?? 'Your number'}</span>
                  <Badge variant="outline">{c.status}</Badge>
                  <span className="text-muted-foreground">{when(c.lastMessageAt)}</span>
                  <span className="ml-auto flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={openId === c.id}
                      onClick={() => setOpenId(openId === c.id ? null : c.id)}
                    >
                      {openId === c.id ? 'Hide messages' : 'Show messages'}
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <Link href={`/inbox?c=${c.id}`}>Open in inbox</Link>
                    </Button>
                  </span>
                </div>
                {openId !== c.id && c.lastMessagePreview && (
                  <p className="truncate text-sm text-muted-foreground">{c.lastMessagePreview}</p>
                )}
                {openId === c.id && <ThreadHistory conversation={c} />}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const contact = useContact(id);
  const canWrite = useCan(Permission.CONTACTS_WRITE);
  const canManage = useCan(Permission.CONTACTS_MANAGE);
  const [confirming, setConfirming] = useState(false);

  const remove = async () => {
    try {
      await api(`/contacts/${id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: contactKeys.lists });
      router.push('/contacts');
    } catch (err) {
      handleApiError(err);
    }
  };

  if (contact.isPending) return <Skeleton className="mx-auto h-64 max-w-5xl" />;
  if (contact.isError) {
    return (
      <div className="mx-auto max-w-5xl">
        <p className="text-sm text-muted-foreground">This contact was not found.</p>
        <Button size="sm" variant="link" className="px-0" asChild>
          <Link href="/contacts">Back to contacts</Link>
        </Button>
      </div>
    );
  }
  const c = contact.data;

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="icon" variant="ghost" aria-label="Back to contacts" asChild>
          <Link href="/contacts">
            <ArrowLeft className="size-4" aria-hidden />
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">{contactLabel(c)}</h1>
        <span className="text-muted-foreground">{displayWaId(c.waId)}</span>
        {canManage && (
          <Dialog open={confirming} onOpenChange={setConfirming}>
            <DialogTrigger asChild>
              <Button size="sm" variant="ghost" className="ml-auto">
                Delete
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete this contact?</DialogTitle>
                <DialogDescription>
                  They disappear from your list. Conversations and consent records are kept, and the
                  contact returns if they message you.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={() => void remove()}>
                  Delete contact
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="grid gap-4">
          <DetailsCard key={c.id} contact={c} canWrite={canWrite} />
          <TagsCard contact={c} canWrite={canWrite} />
        </div>
        <div className="grid gap-4">
          <ConsentCard contact={c} canWrite={canWrite} />
          <NotesCard contact={c} canWrite={canWrite} />
        </div>
      </div>
      <ConversationsCard contactId={c.id} />
    </div>
  );
}
