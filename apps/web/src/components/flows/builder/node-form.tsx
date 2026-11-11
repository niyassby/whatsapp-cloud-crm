'use client';

import type {
  ContactFieldDto,
  FlowCondition,
  FlowDefinition,
  FlowIssue,
  FlowNode,
  FlowSettings,
  FlowTrigger,
  FlowVariableOption,
  MemberDto,
  PhoneNumberDto,
  TagDto,
  TemplateDto,
} from '@wacrm/shared';
import {
  edgeTarget,
  FLOW_ANSWER_TYPES,
  FLOW_CONDITION_OPS,
  FLOW_NODE_META,
  FLOW_TRIGGER_TYPES,
  flowTriggerSchema,
  handleLabel,
  nodeHandles,
  templateVariables,
  UNSET_ID,
} from '@wacrm/shared';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { apiUpload } from '@/lib/api';
import { TRIGGER_LABELS } from '@/lib/flows';
import { handleApiError } from '@/lib/forms';
import { ChoiceField, TextField, VariableField } from './fields';

export interface BuilderData {
  templates: TemplateDto[];
  tags: TagDto[];
  members: MemberDto[];
  fields: ContactFieldDto[];
  phones: PhoneNumberDto[];
}

const END = '__end__';
const NONE = '__none__';

const slug = (s: string, fallback: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || fallback;

/** An id not used by the others, from a title: "Track order" -> "track_order". */
function freshId(title: string, taken: string[], fallback: string): string {
  const base = slug(title, fallback);
  if (!taken.includes(base) && !['next', 'other', 'timeout', 'else'].includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}_${i}`)) return `${base}_${i}`;
}

const OP_LABELS: Record<(typeof FLOW_CONDITION_OPS)[number], string> = {
  eq: 'is',
  neq: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  is_set: 'has a value',
  is_not_set: 'is empty',
};

const ANSWER_LABELS: Record<(typeof FLOW_ANSWER_TYPES)[number], string> = {
  any: 'Anything',
  text: 'Text',
  number: 'A number',
  email: 'An email address',
  phone: 'A phone number',
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <TextField
      label={label}
      type="number"
      value={value === null ? '' : String(value)}
      hint={hint}
      onChange={(v) => {
        if (v === '') return onChange(null);
        const n = Math.round(Number(v));
        if (!Number.isFinite(n)) return;
        onChange(Math.min(max ?? n, Math.max(min ?? n, n)));
      }}
    />
  );
}

function SaveAs({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <TextField
      label="Save the answer as"
      value={value ?? ''}
      hint="A name like order_number. Use it later as {{vars.order_number}}."
      onChange={(v) => {
        const clean = v
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '_')
          .slice(0, 40);
        onChange(clean ? clean : undefined);
      }}
    />
  );
}

function Timeout({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <NumberField
      label="Stop waiting after (minutes)"
      value={value}
      min={1}
      max={43200}
      onChange={onChange}
      hint="Empty: 7 days. Then the No answer exit is taken."
    />
  );
}

function TemplatePicker({
  data,
  value,
  onChange,
  allowAny,
}: {
  data: BuilderData;
  value: string | null;
  onChange: (id: string | null) => void;
  allowAny?: boolean;
}) {
  const usable = data.templates.filter((t) => t.supported && t.status === 'approved');
  return (
    <ChoiceField
      label="Template"
      value={value && value !== UNSET_ID ? value : allowAny ? NONE : ''}
      placeholder="Choose an approved template"
      onChange={(v) => onChange(v === NONE ? null : v)}
      options={[
        ...(allowAny ? [{ value: NONE, label: 'Any template' }] : []),
        ...usable.map((t) => ({ value: t.id, label: `${t.name} (${t.language})` })),
      ]}
    />
  );
}

function TagPicker({
  data,
  value,
  onChange,
  label = 'Tag',
}: {
  data: BuilderData;
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  return (
    <ChoiceField
      label={label}
      value={value === UNSET_ID ? '' : value}
      placeholder={data.tags.length ? 'Choose a tag' : 'Create tags under Contacts first'}
      onChange={onChange}
      options={data.tags.map((t) => ({ value: t.id, label: t.name }))}
    />
  );
}

function MemberPicker({
  data,
  value,
  onChange,
  label,
}: {
  data: BuilderData;
  value: string | null;
  onChange: (id: string | null) => void;
  label: string;
}) {
  return (
    <ChoiceField
      label={label}
      value={value ?? NONE}
      onChange={(v) => onChange(v === NONE ? null : v)}
      options={[
        { value: NONE, label: 'Whoever the assignment rules choose' },
        ...data.members
          .filter((m) => m.status === 'active')
          .map((m) => ({ value: m.userId, label: m.name })),
      ]}
    />
  );
}

// ------------------------------------------------------------------ conditions

function ConditionEditor({
  condition,
  onChange,
  onRemove,
  data,
  variables,
}: {
  condition: FlowCondition;
  onChange: (c: FlowCondition) => void;
  onRemove: () => void;
  data: BuilderData;
  variables: FlowVariableOption[];
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <ChoiceField
            label="Check"
            value={condition.kind}
            onChange={(kind) =>
              onChange(
                kind === 'value'
                  ? { kind, left: '{{vars.answer}}', op: 'eq', right: '' }
                  : kind === 'tag'
                    ? { kind, tagId: data.tags[0]?.id ?? UNSET_ID, has: true }
                    : { kind, open: true },
              )
            }
            options={[
              { value: 'value', label: 'A value' },
              { value: 'tag', label: 'A contact tag' },
              { value: 'business_hours', label: 'Business hours' },
            ]}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove condition"
          onClick={onRemove}
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
      </div>
      {condition.kind === 'value' && (
        <>
          <VariableField
            label="Value"
            value={condition.left}
            variables={variables}
            onChange={(left) => onChange({ ...condition, left })}
          />
          <ChoiceField
            label="Comparison"
            value={condition.op}
            onChange={(op) => onChange({ ...condition, op })}
            options={FLOW_CONDITION_OPS.map((op) => ({ value: op, label: OP_LABELS[op] }))}
          />
          {condition.op !== 'is_set' && condition.op !== 'is_not_set' && (
            <VariableField
              label="Compared with"
              value={condition.right}
              variables={variables}
              onChange={(right) => onChange({ ...condition, right })}
            />
          )}
        </>
      )}
      {condition.kind === 'tag' && (
        <>
          <ChoiceField
            label="Contact"
            value={condition.has ? 'has' : 'lacks'}
            onChange={(v) => onChange({ ...condition, has: v === 'has' })}
            options={[
              { value: 'has', label: 'has the tag' },
              { value: 'lacks', label: 'does not have the tag' },
            ]}
          />
          <TagPicker
            data={data}
            value={condition.tagId}
            onChange={(tagId) => onChange({ ...condition, tagId })}
          />
        </>
      )}
      {condition.kind === 'business_hours' && (
        <ChoiceField
          label="When we are"
          value={condition.open ? 'open' : 'closed'}
          onChange={(v) => onChange({ ...condition, open: v === 'open' })}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ one step

function StepFields({
  node,
  onChange,
  data,
  variables,
}: {
  node: FlowNode;
  onChange: (n: FlowNode) => void;
  data: BuilderData;
  variables: FlowVariableOption[];
}) {
  const [uploading, setUploading] = useState(false);
  // Every case returns a node of its own type, so the cast only restores what TS cannot narrow.
  const set = <N extends FlowNode>(n: N, d: Partial<N['data']>) =>
    onChange({ ...n, data: { ...n.data, ...d } } as FlowNode);

  switch (node.type) {
    case 'send_message':
      return (
        <VariableField
          label="Message"
          multiline
          maxLength={4096}
          value={node.data.text}
          variables={variables}
          onChange={(text) => set(node, { text })}
          hint="Free-form messages go out only within 24 hours of the customer's last message."
        />
      );
    case 'send_template': {
      const t = data.templates.find((x) => x.id === node.data.templateId);
      const vars = t?.definition ? templateVariables(t.definition) : [];
      return (
        <>
          <TemplatePicker
            data={data}
            value={node.data.templateId}
            onChange={(templateId) =>
              set(node, { templateId: templateId ?? UNSET_ID, variables: {} })
            }
          />
          {vars.map((v) => (
            <VariableField
              key={v.key}
              label={v.label}
              value={node.data.variables[v.key] ?? ''}
              variables={variables}
              maxLength={1024}
              onChange={(value) =>
                set(node, { variables: { ...node.data.variables, [v.key]: value } })
              }
            />
          ))}
        </>
      );
    }
    case 'media': {
      const upload = async (file: File) => {
        setUploading(true);
        try {
          const form = new FormData();
          form.append('file', file);
          const res = await apiUpload<{
            mediaKey: string;
            mimeType: string;
            kind: string;
            filename: string | null;
          }>('/flows/media', form);
          set(node, {
            mediaKey: res.mediaKey,
            mimeType: res.mimeType,
            kind: res.kind as typeof node.data.kind,
            filename: res.filename ?? undefined,
          });
        } catch (err) {
          handleApiError(err);
        } finally {
          setUploading(false);
        }
      };
      return (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor={`file-${node.id}`}>File</Label>
            <input
              id={`file-${node.id}`}
              type="file"
              disabled={uploading}
              className="text-sm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
            <p className="text-xs text-muted-foreground">
              {node.data.mediaKey === 'unset'
                ? 'No file yet.'
                : `${node.data.kind}: ${node.data.filename ?? node.data.mimeType}`}
            </p>
          </div>
          {node.data.kind !== 'audio' && (
            <VariableField
              label="Caption"
              value={node.data.caption ?? ''}
              variables={variables}
              maxLength={1024}
              onChange={(caption) => set(node, { caption: caption || undefined })}
            />
          )}
        </>
      );
    }
    case 'buttons':
      return (
        <>
          <VariableField
            label="Message"
            multiline
            maxLength={1024}
            value={node.data.body}
            variables={variables}
            onChange={(body) => set(node, { body })}
          />
          <Section title="Buttons">
            {node.data.buttons.map((b, i) => (
              <div key={b.id} className="flex items-end gap-2">
                <div className="flex-1">
                  <TextField
                    label={`Button ${i + 1}`}
                    value={b.title}
                    maxLength={20}
                    onChange={(title) =>
                      set(node, {
                        buttons: node.data.buttons.map((x) =>
                          x.id === b.id ? { ...x, title } : x,
                        ),
                      })
                    }
                  />
                </div>
                {node.data.buttons.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove button ${i + 1}`}
                    onClick={() =>
                      set(node, { buttons: node.data.buttons.filter((x) => x.id !== b.id) })
                    }
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                )}
              </div>
            ))}
            {node.data.buttons.length < 3 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const title = `Option ${node.data.buttons.length + 1}`;
                  const id = freshId(
                    title,
                    node.data.buttons.map((b) => b.id),
                    'option',
                  );
                  set(node, { buttons: [...node.data.buttons, { id, title }] });
                }}
              >
                <Plus className="size-4" aria-hidden /> Add button
              </Button>
            )}
          </Section>
          <SaveAs value={node.data.saveAs} onChange={(saveAs) => set(node, { saveAs })} />
          <Timeout
            value={node.data.timeoutMinutes}
            onChange={(timeoutMinutes) => set(node, { timeoutMinutes })}
          />
        </>
      );
    case 'list': {
      const [section, ...rest] = node.data.sections;
      const rows = section?.rows ?? [];
      const setRows = (next: typeof rows) =>
        set(node, { sections: [{ ...section, rows: next }, ...rest] });
      return (
        <>
          <VariableField
            label="Message"
            multiline
            maxLength={1024}
            value={node.data.body}
            variables={variables}
            onChange={(body) => set(node, { body })}
          />
          <TextField
            label="Menu button"
            value={node.data.buttonText}
            maxLength={20}
            onChange={(buttonText) => set(node, { buttonText })}
          />
          <Section title="Choices">
            {rest.length > 0 && (
              <p className="text-xs text-muted-foreground">
                This list has more sections; edit them as JSON.
              </p>
            )}
            {rows.map((r, i) => (
              <div key={r.id} className="flex items-end gap-2">
                <div className="flex-1">
                  <TextField
                    label={`Choice ${i + 1}`}
                    value={r.title}
                    maxLength={24}
                    onChange={(title) =>
                      setRows(rows.map((x) => (x.id === r.id ? { ...x, title } : x)))
                    }
                  />
                </div>
                {rows.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove choice ${i + 1}`}
                    onClick={() => setRows(rows.filter((x) => x.id !== r.id))}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                )}
              </div>
            ))}
            {rows.length < 10 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const title = `Choice ${rows.length + 1}`;
                  setRows([
                    ...rows,
                    {
                      id: freshId(
                        title,
                        rows.map((x) => x.id),
                        'choice',
                      ),
                      title,
                    },
                  ]);
                }}
              >
                <Plus className="size-4" aria-hidden /> Add choice
              </Button>
            )}
          </Section>
          <SaveAs value={node.data.saveAs} onChange={(saveAs) => set(node, { saveAs })} />
          <Timeout
            value={node.data.timeoutMinutes}
            onChange={(timeoutMinutes) => set(node, { timeoutMinutes })}
          />
        </>
      );
    }
    case 'ask_question':
      return (
        <>
          <VariableField
            label="Question"
            multiline
            maxLength={1024}
            value={node.data.question}
            variables={variables}
            onChange={(question) => set(node, { question })}
          />
          <ChoiceField
            label="Expected answer"
            value={node.data.answerType}
            onChange={(answerType) => set(node, { answerType })}
            options={FLOW_ANSWER_TYPES.map((t) => ({ value: t, label: ANSWER_LABELS[t] }))}
          />
          <SaveAs
            value={node.data.saveAs}
            onChange={(saveAs) => set(node, { saveAs: saveAs ?? 'answer' })}
          />
          <ChoiceField
            label="Also save on the contact"
            value={node.data.contactField ?? NONE}
            onChange={(v) => set(node, { contactField: v === NONE ? undefined : v })}
            options={[
              { value: NONE, label: 'No' },
              ...data.fields.map((f) => ({ value: f.key, label: f.label })),
            ]}
          />
          <VariableField
            label="If the answer does not fit"
            value={node.data.retryMessage}
            variables={variables}
            maxLength={1024}
            onChange={(retryMessage) => set(node, { retryMessage })}
          />
          <NumberField
            label="Times to ask again"
            value={node.data.retries}
            min={0}
            max={5}
            onChange={(retries) => set(node, { retries: retries ?? 0 })}
          />
          <Timeout
            value={node.data.timeoutMinutes}
            onChange={(timeoutMinutes) => set(node, { timeoutMinutes })}
          />
        </>
      );
    case 'wait_for_reply':
      return (
        <>
          <SaveAs value={node.data.saveAs} onChange={(saveAs) => set(node, { saveAs })} />
          <Timeout
            value={node.data.timeoutMinutes}
            onChange={(timeoutMinutes) => set(node, { timeoutMinutes })}
          />
        </>
      );
    case 'condition':
      return (
        <Section title="Branches, checked in order">
          {node.data.branches.map((b, bi) => {
            const setBranch = (next: typeof b) =>
              set(node, { branches: node.data.branches.map((x) => (x.id === b.id ? next : x)) });
            return (
              <div key={b.id} className="flex flex-col gap-2 rounded-md border p-2">
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <TextField
                      label={`Branch ${bi + 1} name`}
                      value={b.label}
                      maxLength={60}
                      onChange={(label) => setBranch({ ...b, label })}
                    />
                  </div>
                  {node.data.branches.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove branch ${bi + 1}`}
                      onClick={() =>
                        set(node, { branches: node.data.branches.filter((x) => x.id !== b.id) })
                      }
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  )}
                </div>
                <ChoiceField
                  label="Take it when"
                  value={b.match}
                  onChange={(match) => setBranch({ ...b, match })}
                  options={[
                    { value: 'all', label: 'All of these are true' },
                    { value: 'any', label: 'Any of these is true' },
                  ]}
                />
                {b.conditions.map((c, ci) => (
                  <ConditionEditor
                    key={ci}
                    condition={c}
                    data={data}
                    variables={variables}
                    onChange={(next) =>
                      setBranch({
                        ...b,
                        conditions: b.conditions.map((x, i) => (i === ci ? next : x)),
                      })
                    }
                    onRemove={() =>
                      b.conditions.length > 1 &&
                      setBranch({ ...b, conditions: b.conditions.filter((_, i) => i !== ci) })
                    }
                  />
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setBranch({
                      ...b,
                      conditions: [
                        ...b.conditions,
                        { kind: 'value', left: '', op: 'eq', right: '' },
                      ],
                    })
                  }
                >
                  <Plus className="size-4" aria-hidden /> Add condition
                </Button>
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const label = `Branch ${node.data.branches.length + 1}`;
              set(node, {
                branches: [
                  ...node.data.branches,
                  {
                    id: freshId(
                      label,
                      node.data.branches.map((b) => b.id),
                      'branch',
                    ),
                    label,
                    match: 'all',
                    conditions: [{ kind: 'value', left: '', op: 'eq', right: '' }],
                  },
                ],
              });
            }}
          >
            <Plus className="size-4" aria-hidden /> Add branch
          </Button>
          <p className="text-xs text-muted-foreground">
            When no branch matches, Otherwise is taken.
          </p>
        </Section>
      );
    case 'delay':
      return (
        <div className="flex items-end gap-2">
          <NumberField
            label="Wait"
            value={node.data.amount}
            min={1}
            onChange={(amount) => set(node, { amount: amount ?? 1 })}
          />
          <ChoiceField
            label="Unit"
            value={node.data.unit}
            onChange={(unit) => set(node, { unit })}
            options={[
              { value: 'minutes', label: 'Minutes' },
              { value: 'hours', label: 'Hours' },
              { value: 'days', label: 'Days' },
            ]}
          />
        </div>
      );
    case 'http_request':
      return (
        <>
          <ChoiceField
            label="Method"
            value={node.data.method}
            onChange={(method) => set(node, { method })}
            options={(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => ({
              value: m,
              label: m,
            }))}
          />
          <VariableField
            label="Address"
            value={node.data.url}
            variables={variables}
            maxLength={2000}
            onChange={(url) => set(node, { url })}
            hint="https only. Values from variables are encoded for you."
          />
          {node.data.method !== 'GET' && node.data.method !== 'DELETE' && (
            <VariableField
              label="Body"
              multiline
              value={node.data.body ?? ''}
              variables={variables}
              maxLength={10000}
              onChange={(body) => set(node, { body: body || undefined })}
            />
          )}
          <Section title="Headers">
            {node.data.headers.map((h, i) => (
              <div key={i} className="flex items-end gap-2">
                <TextField
                  label="Name"
                  value={h.name}
                  maxLength={64}
                  onChange={(name) =>
                    set(node, {
                      headers: node.data.headers.map((x, j) => (j === i ? { ...x, name } : x)),
                    })
                  }
                />
                <TextField
                  label="Value"
                  value={h.value}
                  maxLength={1000}
                  onChange={(value) =>
                    set(node, {
                      headers: node.data.headers.map((x, j) => (j === i ? { ...x, value } : x)),
                    })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove header"
                  onClick={() =>
                    set(node, { headers: node.data.headers.filter((_, j) => j !== i) })
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                set(node, { headers: [...node.data.headers, { name: 'Authorization', value: '' }] })
              }
            >
              <Plus className="size-4" aria-hidden /> Add header
            </Button>
          </Section>
          <Section title="Save from the answer">
            {Object.entries(node.data.saveResponse).map(([name, path]) => (
              <div key={name} className="flex items-end gap-2">
                <div className="grid gap-1.5">
                  <span className="text-sm font-medium">Variable</span>
                  <code className="flex h-9 items-center text-sm">{`{{vars.${name}}}`}</code>
                </div>
                <TextField
                  label="Path in the JSON"
                  value={path}
                  maxLength={200}
                  onChange={(p) =>
                    set(node, { saveResponse: { ...node.data.saveResponse, [name]: p } })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Stop saving ${name}`}
                  onClick={() => {
                    const next = { ...node.data.saveResponse };
                    delete next[name];
                    set(node, { saveResponse: next });
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            ))}
            <AddMapping
              taken={Object.keys(node.data.saveResponse)}
              onAdd={(name, path) =>
                set(node, { saveResponse: { ...node.data.saveResponse, [name]: path } })
              }
            />
          </Section>
        </>
      );
    case 'integration_action':
      return (
        <>
          <p className="text-sm text-muted-foreground">
            Connected apps arrive with integrations. Until then this step takes its Failed exit.
          </p>
          <TextField
            label="App"
            value={node.data.connector}
            onChange={(connector) => set(node, { connector })}
          />
          <TextField
            label="Action"
            value={node.data.action}
            onChange={(action) => set(node, { action })}
          />
        </>
      );
    case 'tag':
      return (
        <>
          <ChoiceField
            label="Do"
            value={node.data.action}
            onChange={(action) => set(node, { action })}
            options={[
              { value: 'add', label: 'Add the tag' },
              { value: 'remove', label: 'Remove the tag' },
            ]}
          />
          <TagPicker
            data={data}
            value={node.data.tagId}
            onChange={(tagId) => set(node, { tagId })}
          />
        </>
      );
    case 'assign_agent':
      return (
        <MemberPicker
          data={data}
          label="Give the conversation to"
          value={node.data.userId}
          onChange={(userId) => set(node, { userId })}
        />
      );
    case 'ai_reply':
      return (
        <>
          <p className="text-sm text-muted-foreground">
            The AI assistant arrives later. Until then this step hands over to your team.
          </p>
          <TextField
            label="Instructions"
            value={node.data.instructions}
            maxLength={2000}
            onChange={(instructions) => set(node, { instructions })}
          />
        </>
      );
    case 'human_handoff':
      return (
        <>
          <VariableField
            label="Last message (optional)"
            multiline
            maxLength={4096}
            value={node.data.message ?? ''}
            variables={variables}
            onChange={(message) => set(node, { message: message || undefined })}
          />
          <MemberPicker
            data={data}
            label="Give the conversation to"
            value={node.data.userId}
            onChange={(userId) => set(node, { userId })}
          />
        </>
      );
    case 'end':
      return <p className="text-sm text-muted-foreground">The flow ends here.</p>;
  }
}

function AddMapping({
  taken,
  onAdd,
}: {
  taken: string[];
  onAdd: (name: string, path: string) => void;
}) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const clean = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const ok = /^[a-z][a-z0-9_]{0,39}$/.test(clean) && !taken.includes(clean) && path.trim();
  return (
    <div className="flex items-end gap-2">
      <TextField label="New variable" value={name} onChange={setName} maxLength={40} />
      <TextField
        label="Path"
        value={path}
        onChange={setPath}
        maxLength={200}
        hint="e.g. order.status"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!ok}
        onClick={() => {
          onAdd(clean, path.trim());
          setName('');
          setPath('');
        }}
      >
        Add
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ panels

/** Where each exit of a step goes, chosen from a list. The canvas lines show the same thing. */
function Exits({
  node,
  def,
  onConnect,
}: {
  node: FlowNode;
  def: FlowDefinition;
  onConnect: (handle: string, target: string | null) => void;
}) {
  const handles = nodeHandles(node);
  if (handles.length === 0) return null;
  const others = def.nodes.filter((n) => n.id !== node.id);
  return (
    <Section title="Then">
      {handles.map((h) => (
        <ChoiceField
          key={h}
          label={`After ${handleLabel(node, h)}`}
          value={edgeTarget(def, node.id, h) ?? END}
          onChange={(v) => onConnect(h, v === END ? null : v)}
          options={[
            { value: END, label: 'End the flow' },
            ...others.map((n) => ({
              value: n.id,
              label: `${FLOW_NODE_META[n.type].label} (${n.id})`,
            })),
          ]}
        />
      ))}
    </Section>
  );
}

export function StepPanel({
  node,
  def,
  issues,
  data,
  variables,
  onChange,
  onConnect,
  onMakeStart,
  onDuplicate,
  onDelete,
}: {
  node: FlowNode;
  def: FlowDefinition;
  issues: FlowIssue[];
  data: BuilderData;
  variables: FlowVariableOption[];
  onChange: (n: FlowNode) => void;
  onConnect: (handle: string, target: string | null) => void;
  onMakeStart: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const mine = issues.filter((i) => i.nodeId === node.id);
  return (
    <div className="flex flex-col gap-4" aria-label="Step settings">
      <div>
        <h2 className="text-base font-semibold">{FLOW_NODE_META[node.type].label}</h2>
        <p className="text-xs text-muted-foreground">
          {FLOW_NODE_META[node.type].description} · <code>{node.id}</code>
        </p>
      </div>
      {mine.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Problems with this step">
          {mine.map((i, k) => (
            <li key={k} className="flex gap-2">
              <Badge variant={i.level === 'error' ? 'destructive' : 'secondary'}>
                {i.level === 'error' ? 'Error' : 'Warning'}
              </Badge>
              {i.message}
            </li>
          ))}
        </ul>
      )}
      <StepFields node={node} onChange={onChange} data={data} variables={variables} />
      <Separator />
      <Exits node={node} def={def} onConnect={onConnect} />
      <div className="flex flex-wrap gap-2">
        {def.startNodeId !== node.id && (
          <Button type="button" variant="outline" size="sm" onClick={onMakeStart}>
            Make this the first step
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onDuplicate}>
          <Copy className="size-4" aria-hidden /> Duplicate step
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
          <Trash2 className="size-4" aria-hidden /> Delete step
        </Button>
      </div>
    </div>
  );
}

const TRIGGER_DEFAULTS: Record<FlowTrigger['type'], unknown> = {
  keyword: { type: 'keyword', matchType: 'contains', keywords: [] },
  new_contact: { type: 'new_contact' },
  tag_added: { type: 'tag_added', tagId: UNSET_ID },
  template_button: { type: 'template_button' },
  integration_event: { type: 'integration_event', connector: 'shopify', event: 'order.created' },
  ad_referral: { type: 'ad_referral', sourceId: null },
  manual: { type: 'manual' },
};

export function TriggerPanel({
  def,
  issues,
  data,
  onTrigger,
  onSettings,
}: {
  def: FlowDefinition;
  issues: FlowIssue[];
  data: BuilderData;
  onTrigger: (t: FlowTrigger) => void;
  onSettings: (s: FlowSettings) => void;
}) {
  const t = def.trigger;
  const s = def.settings;
  const mine = issues.filter((i) => i.nodeId === null);
  const [keywordText, setKeywordText] = useState(t.type === 'keyword' ? t.keywords.join(', ') : '');
  return (
    <div className="flex flex-col gap-4" aria-label="Trigger settings">
      <div>
        <h2 className="text-base font-semibold">Starts when</h2>
        <p className="text-xs text-muted-foreground">What makes a conversation enter this flow.</p>
      </div>
      {mine.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Problems with this flow">
          {mine.map((i, k) => (
            <li key={k} className="flex gap-2">
              <Badge variant={i.level === 'error' ? 'destructive' : 'secondary'}>
                {i.level === 'error' ? 'Error' : 'Warning'}
              </Badge>
              {i.message}
            </li>
          ))}
        </ul>
      )}
      <ChoiceField
        label="Trigger"
        value={t.type}
        onChange={(type) => {
          const next = flowTriggerSchema.parse(TRIGGER_DEFAULTS[type]);
          setKeywordText('');
          onTrigger(next);
        }}
        options={FLOW_TRIGGER_TYPES.map((x) => ({ value: x, label: TRIGGER_LABELS[x] }))}
      />
      {t.type === 'keyword' && (
        <>
          <ChoiceField
            label="Match"
            value={t.matchType}
            onChange={(matchType) => onTrigger({ ...t, matchType })}
            options={[
              { value: 'contains', label: 'Message contains a keyword' },
              { value: 'exact', label: 'Message is exactly a keyword' },
              { value: 'regex', label: 'Pattern (regular expression)' },
            ]}
          />
          {t.matchType === 'regex' ? (
            <TextField
              label="Pattern"
              value={t.pattern ?? ''}
              maxLength={200}
              onChange={(pattern) => onTrigger({ ...t, pattern: pattern || null })}
            />
          ) : (
            <TextField
              label="Keywords, separated by commas"
              value={keywordText}
              onChange={(v) => {
                setKeywordText(v);
                onTrigger({
                  ...t,
                  keywords: v
                    .split(',')
                    .map((k) => k.trim())
                    .filter(Boolean)
                    .slice(0, 50),
                });
              }}
            />
          )}
        </>
      )}
      {t.type === 'tag_added' && (
        <TagPicker
          data={data}
          label="When this tag is added"
          value={t.tagId}
          onChange={(tagId) => onTrigger({ ...t, tagId })}
        />
      )}
      {t.type === 'template_button' && (
        <>
          <TemplatePicker
            data={data}
            allowAny
            value={t.templateId}
            onChange={(templateId) => onTrigger({ ...t, templateId })}
          />
          <TextField
            label="Button text (empty: any button)"
            value={t.buttonText ?? ''}
            maxLength={25}
            onChange={(v) => onTrigger({ ...t, buttonText: v || null })}
          />
        </>
      )}
      {t.type === 'ad_referral' && (
        <TextField
          label="Ad id (empty: any ad)"
          value={t.sourceId ?? ''}
          maxLength={64}
          onChange={(v) => onTrigger({ ...t, sourceId: v || null })}
        />
      )}
      {t.type === 'integration_event' && (
        <>
          <TextField
            label="App"
            value={t.connector}
            onChange={(connector) => onTrigger({ ...t, connector })}
          />
          <TextField
            label="Event"
            value={t.event}
            onChange={(event) => onTrigger({ ...t, event })}
          />
        </>
      )}
      <Separator />
      <Section title="Flow settings">
        <ChoiceField
          label="When a step fails"
          value={s.onError}
          onChange={(onError) => onSettings({ ...s, onError })}
          options={[
            { value: 'end', label: 'End the flow' },
            { value: 'handoff', label: 'Hand over to the team' },
          ]}
        />
        <ChoiceField
          label="A contact can go through it"
          value={s.reentry}
          onChange={(reentry) => onSettings({ ...s, reentry })}
          options={[
            { value: 'always', label: 'Every time it is triggered' },
            { value: 'once', label: 'Only once' },
          ]}
        />
        <ChoiceField
          label="Number to use when a trigger has no conversation"
          value={s.phoneId ?? NONE}
          onChange={(v) => onSettings({ ...s, phoneId: v === NONE ? null : v })}
          options={[
            { value: NONE, label: 'The contact’s latest conversation' },
            ...data.phones
              .filter((p) => p.status === 'connected')
              .map((p) => ({ value: p.id, label: p.displayPhoneNumber ?? p.phoneNumberId })),
          ]}
        />
      </Section>
    </div>
  );
}
