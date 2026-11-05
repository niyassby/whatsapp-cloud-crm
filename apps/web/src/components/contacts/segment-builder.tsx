'use client';

import {
  type ContactFieldDto,
  OPT_IN_STATUSES,
  type OptInStatus,
  type SegmentFilter,
  segmentFilterSchema,
  type SegmentRule,
  type TagDto,
} from '@wacrm/shared';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { OPT_IN_LABELS, useContactFields, useSegmentPreview, useTags } from '@/lib/contacts';

/** Editing form of a rule: fields stay in place while the person is still choosing. */
interface Draft {
  kind: string; // tag | opt_in | last_activity | custom:<key>
  op: string;
  value: string;
}

const OPS: Record<string, { value: string; label: string }[]> = {
  tag: [
    { value: 'has', label: 'has' },
    { value: 'not_has', label: 'does not have' },
  ],
  opt_in: [
    { value: 'is', label: 'is' },
    { value: 'is_not', label: 'is not' },
  ],
  last_activity: [
    { value: 'within_days', label: 'within the last (days)' },
    { value: 'older_than_days', label: 'more than (days) ago' },
    { value: 'never', label: 'never' },
  ],
};

const CUSTOM_OPS: Record<string, { value: string; label: string }[]> = {
  text: [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'is_set', label: 'has a value' },
    { value: 'not_set', label: 'has no value' },
  ],
  number: [
    { value: 'eq', label: 'equals' },
    { value: 'gt', label: 'is above' },
    { value: 'lt', label: 'is below' },
    { value: 'is_set', label: 'has a value' },
    { value: 'not_set', label: 'has no value' },
  ],
  date: [
    { value: 'gt', label: 'is after' },
    { value: 'lt', label: 'is before' },
    { value: 'is_set', label: 'has a value' },
    { value: 'not_set', label: 'has no value' },
  ],
  boolean: [{ value: 'eq', label: 'is' }],
  select: [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'is_set', label: 'has a value' },
    { value: 'not_set', label: 'has no value' },
  ],
};

const fieldOf = (draft: Draft, fields: ContactFieldDto[]) =>
  draft.kind.startsWith('custom:')
    ? fields.find((f) => f.key === draft.kind.slice('custom:'.length))
    : undefined;

const opsFor = (draft: Draft, fields: ContactFieldDto[]) => {
  const field = fieldOf(draft, fields);
  return field ? (CUSTOM_OPS[field.type] ?? []) : (OPS[draft.kind] ?? []);
};

const newDraft = (kind: string, fields: ContactFieldDto[]): Draft => {
  const draft: Draft = { kind, op: '', value: '' };
  draft.op = opsFor(draft, fields)[0]?.value ?? '';
  return draft;
};

/** Null while a rule is incomplete, so the count only ever reflects whole rules. */
function draftToRule(draft: Draft, fields: ContactFieldDto[]): SegmentRule | null {
  const raw = (() => {
    if (draft.kind === 'tag') return { field: 'tag', op: draft.op, tagId: draft.value };
    if (draft.kind === 'opt_in') return { field: 'opt_in', op: draft.op, value: draft.value };
    if (draft.kind === 'last_activity') {
      return draft.op === 'never'
        ? { field: 'last_activity', op: 'never' }
        : { field: 'last_activity', op: draft.op, days: Number(draft.value) };
    }
    const field = fieldOf(draft, fields);
    if (!field) return null;
    if (draft.op === 'is_set' || draft.op === 'not_set') {
      return { field: 'custom', key: field.key, op: draft.op };
    }
    if (!draft.value) return null;
    const value =
      field.type === 'number'
        ? Number(draft.value)
        : field.type === 'boolean'
          ? draft.value === 'true'
          : draft.value;
    return { field: 'custom', key: field.key, op: draft.op, value };
  })();
  const parsed = segmentFilterSchema.safeParse({ rules: raw ? [raw] : [{}] });
  return parsed.success ? (parsed.data.rules[0] ?? null) : null;
}

function ruleToDraft(rule: SegmentRule): Draft {
  switch (rule.field) {
    case 'tag':
      return { kind: 'tag', op: rule.op, value: rule.tagId };
    case 'opt_in':
      return { kind: 'opt_in', op: rule.op, value: rule.value };
    case 'last_activity':
      return { kind: 'last_activity', op: rule.op, value: 'days' in rule ? String(rule.days) : '' };
    case 'custom':
      return {
        kind: `custom:${rule.key}`,
        op: rule.op,
        value: 'value' in rule ? String(rule.value) : '',
      };
  }
}

function ValueInput({
  draft,
  tags,
  fields,
  onChange,
}: {
  draft: Draft;
  tags: TagDto[];
  fields: ContactFieldDto[];
  onChange: (value: string) => void;
}) {
  const select = (options: { value: string; label: string }[]) => (
    <Select value={draft.value} onValueChange={onChange}>
      <SelectTrigger aria-label="Value" className="w-40">
        <SelectValue placeholder="Choose" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (draft.kind === 'tag') return select(tags.map((t) => ({ value: t.id, label: t.name })));
  if (draft.kind === 'opt_in') {
    return select(OPT_IN_STATUSES.map((s: OptInStatus) => ({ value: s, label: OPT_IN_LABELS[s] })));
  }
  if (draft.op === 'never' || draft.op === 'is_set' || draft.op === 'not_set') return null;
  if (draft.kind === 'last_activity') {
    return (
      <Input
        aria-label="Days"
        type="number"
        min={1}
        max={3650}
        className="w-24"
        value={draft.value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  const field = fieldOf(draft, fields);
  if (field?.type === 'boolean') {
    return select([
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ]);
  }
  if (field?.type === 'select') return select(field.options.map((o) => ({ value: o, label: o })));
  return (
    <Input
      aria-label="Value"
      type={field?.type === 'number' ? 'number' : field?.type === 'date' ? 'date' : 'text'}
      className="w-40"
      value={draft.value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function SegmentBuilder({
  initial,
  onChange,
}: {
  initial?: SegmentFilter;
  /** Null while any rule is incomplete. */
  onChange: (filter: SegmentFilter | null) => void;
}) {
  const tags = useTags();
  const fieldsQuery = useContactFields();
  const fields = fieldsQuery.data ?? [];
  const [match, setMatch] = useState<'all' | 'any'>(initial?.match ?? 'all');
  const [drafts, setDrafts] = useState<Draft[]>(initial?.rules.map(ruleToDraft) ?? []);

  const rules = drafts.map((d) => draftToRule(d, fields));
  const complete = rules.every((r) => r !== null);
  const filter: SegmentFilter = { match, rules: rules.filter((r): r is SegmentRule => r !== null) };
  const key = JSON.stringify(filter);

  // Waits for typing to settle, since each change would otherwise cost a count query.
  const [settled, setSettled] = useState(filter);
  useEffect(() => {
    const parsed = JSON.parse(key) as SegmentFilter;
    onChange(complete ? parsed : null);
    const timer = setTimeout(() => setSettled(parsed), 300);
    return () => clearTimeout(timer);
    // `onChange` is not a dependency: a parent's new function must not restart the wait.
  }, [key, complete]);
  const preview = useSegmentPreview(settled, complete);

  const setDraft = (index: number, next: Draft) =>
    setDrafts((all) => all.map((d, i) => (i === index ? next : d)));

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        Contacts matching
        <Select value={match} onValueChange={(v) => setMatch(v as 'all' | 'any')}>
          <SelectTrigger aria-label="How rules combine" size="sm" className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all</SelectItem>
            <SelectItem value="any">any</SelectItem>
          </SelectContent>
        </Select>
        of these rules
      </div>

      <ul className="grid gap-2">
        {drafts.map((draft, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <Select
              value={draft.kind}
              onValueChange={(kind) => setDraft(i, newDraft(kind, fields))}
            >
              <SelectTrigger aria-label="Rule type" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tag">Tag</SelectItem>
                <SelectItem value="opt_in">Consent</SelectItem>
                <SelectItem value="last_activity">Last activity</SelectItem>
                {fields.map((f) => (
                  <SelectItem key={f.key} value={`custom:${f.key}`}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={draft.op} onValueChange={(op) => setDraft(i, { ...draft, op })}>
              <SelectTrigger aria-label="Condition" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {opsFor(draft, fields).map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ValueInput
              draft={draft}
              tags={tags.data ?? []}
              fields={fields}
              onChange={(value) => setDraft(i, { ...draft, value })}
            />
            <Button
              size="icon"
              variant="ghost"
              aria-label="Remove rule"
              onClick={() => setDrafts((all) => all.filter((_, j) => j !== i))}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={drafts.length >= 20}
          onClick={() => setDrafts((all) => [...all, newDraft('tag', fields)])}
        >
          Add rule
        </Button>
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {!complete
            ? 'Finish the rules to see a count'
            : preview.data
              ? `${preview.data.count.toLocaleString()} contacts match`
              : ''}
        </span>
      </div>
    </div>
  );
}
