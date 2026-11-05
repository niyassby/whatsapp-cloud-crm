'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CONTACT_FIELD_TYPES, type ContactFieldType, Permission } from '@wacrm/shared';
import { Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { TagChip } from '@/components/contacts/tag-chip';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { contactKeys, useContactFields, useOptOutKeywords, useTags } from '@/lib/contacts';
import { handleApiError } from '@/lib/forms';
import { useCan } from '@/lib/queries';

const TYPE_LABELS: Record<ContactFieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes or no',
  select: 'Pick from a list',
};

const toKey = (label: string) =>
  label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 40);

function FieldsCard() {
  const queryClient = useQueryClient();
  const fields = useContactFields();
  const [label, setLabel] = useState('');
  const [type, setType] = useState<ContactFieldType>('text');
  const [options, setOptions] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: contactKeys.fields });

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/contact-fields', {
        method: 'POST',
        body: {
          key: toKey(label),
          label,
          type,
          options:
            type === 'select'
              ? options
                  .split(',')
                  .map((o) => o.trim())
                  .filter(Boolean)
              : [],
        },
      });
      setLabel('');
      setOptions('');
      await refresh();
    } catch (err) {
      handleApiError(err);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/contact-fields/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Custom fields</CardTitle>
        <CardDescription>
          Extra details to keep on each contact. Use them in imports and segments.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ul className="grid gap-1">
          {fields.data?.map((f) => (
            <li key={f.id} className="flex items-center gap-2 text-sm">
              <span className="font-medium">{f.label}</span>
              <span className="text-muted-foreground">
                {TYPE_LABELS[f.type]}
                {f.options.length ? `: ${f.options.join(', ')}` : ''}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto"
                aria-label={`Delete field ${f.label}`}
                onClick={() => void remove(f.id)}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
          {fields.data?.length === 0 && (
            <li className="text-sm text-muted-foreground">No custom fields yet.</li>
          )}
        </ul>
        <form onSubmit={(e) => void add(e)} className="grid gap-3">
          <FormField
            label="Field name"
            name="field-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Customer plan"
          />
          <div className="grid gap-1.5">
            <Label htmlFor="field-type">Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as ContactFieldType)}>
              <SelectTrigger id="field-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTACT_FIELD_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {type === 'select' && (
            <FormField
              label="Options"
              name="field-options"
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              hint="Separate them with commas."
            />
          )}
          <div>
            <Button type="submit" size="sm" disabled={!toKey(label)}>
              Add field
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function KeywordsCard() {
  const queryClient = useQueryClient();
  const keywords = useOptOutKeywords();
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? keywords.data?.keywords.join(', ') ?? '';

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/contact-settings/opt-out-keywords', {
        method: 'PUT',
        body: {
          keywords: text
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean),
        },
      });
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: contactKeys.keywords });
      toast.success('Keywords saved');
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Opt-out keywords</CardTitle>
        <CardDescription>
          When a customer’s whole message is one of these, they are opted out of marketing
          automatically. “stop by tomorrow” does not count.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void save(e)} className="grid gap-3">
          <FormField
            label="Keywords"
            name="opt-out-keywords"
            value={text}
            onChange={(e) => setDraft(e.target.value)}
            hint={
              keywords.data?.isDefault
                ? 'These are the defaults. Separate keywords with commas.'
                : 'Separate keywords with commas.'
            }
          />
          <div>
            <Button type="submit" size="sm" disabled={!text.trim() || draft === null}>
              Save keywords
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function TagsCard() {
  const queryClient = useQueryClient();
  const tags = useTags();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#64748b');
  const refresh = () => queryClient.invalidateQueries({ queryKey: contactKeys.all });

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/contact-tags', { method: 'POST', body: { name, color } });
      setName('');
      await refresh();
    } catch (err) {
      handleApiError(err);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/contact-tags/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contact tags</CardTitle>
        <CardDescription>Deleting a tag removes it from every contact.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ul className="flex flex-wrap gap-2">
          {tags.data?.map((t) => (
            <li key={t.id} className="flex items-center gap-1">
              <TagChip tag={t} />
              <Button
                size="icon"
                variant="ghost"
                className="size-6"
                aria-label={`Delete tag ${t.name}`}
                onClick={() => void remove(t.id)}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </li>
          ))}
          {tags.data?.length === 0 && (
            <li className="text-sm text-muted-foreground">No tags yet.</li>
          )}
        </ul>
        <form onSubmit={(e) => void add(e)} className="flex items-end gap-2">
          <div className="flex-1">
            <FormField
              label="New tag"
              name="settings-tag"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="settings-tag-color">Colour</Label>
            <input
              id="settings-tag-color"
              type="color"
              className="h-9 w-12 rounded-md border"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Add
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function ContactSettingsPage() {
  const canManage = useCan(Permission.CONTACTS_MANAGE);
  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        Only owners and admins can manage contact settings.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <KeywordsCard />
      <FieldsCard />
      <TagsCard />
    </div>
  );
}
