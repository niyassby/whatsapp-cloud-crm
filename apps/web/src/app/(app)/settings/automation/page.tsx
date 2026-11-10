'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  ASSIGNMENT_STRATEGIES,
  type AssignmentRuleDto,
  type AssignmentStrategy,
  AUTO_REPLY_MATCH_TYPES,
  type AutomationSettingsDto,
  type AutoReplyMatchType,
  type AutoReplyRuleDto,
  type BusinessHours,
  type DefaultAssignment,
  Permission,
  regexProblem,
  WEEKDAYS,
  type Weekday,
} from '@wacrm/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
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
  automationKeys,
  useAssignmentRules,
  useAutomationSettings,
  useAutoReplies,
} from '@/lib/automation';
import { useTags } from '@/lib/contacts';
import { handleApiError } from '@/lib/forms';
import { queryKeys, useCan, useMembers } from '@/lib/queries';

const DAY_LABELS: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};
const MATCH_LABELS: Record<AutoReplyMatchType, string> = {
  exact: 'Is exactly',
  contains: 'Contains the words',
  regex: 'Matches the pattern',
};
const STRATEGY_LABELS: Record<AssignmentStrategy, string> = {
  round_robin: 'In turn (round-robin)',
  load_based: 'Least busy first',
};
const splitList = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function MessagesAndSla({ settings }: { settings: AutomationSettingsDto }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(settings);
  const [hours, setHours] = useState<Record<Weekday, { open: boolean; from: string; to: string }>>(
    () =>
      Object.fromEntries(
        WEEKDAYS.map((d) => {
          const span = settings.businessHours?.days[d]?.[0];
          const weekend = d === 'sat' || d === 'sun';
          return [
            d,
            span
              ? { open: true, from: span.from, to: span.to }
              : { open: !settings.businessHours && !weekend, from: '09:00', to: '18:00' },
          ];
        }),
      ) as Record<Weekday, { open: boolean; from: string; to: string }>,
  );
  const [useHours, setUseHours] = useState(Boolean(settings.businessHours));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof AutomationSettingsDto>(key: K, value: AutomationSettingsDto[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const businessHours: BusinessHours | null = useHours
      ? {
          days: Object.fromEntries(
            WEEKDAYS.filter((d) => hours[d].open).map((d) => [
              d,
              [{ from: hours[d].from, to: hours[d].to }],
            ]),
          ),
        }
      : null;
    try {
      const { timezone: _timezone, ...body } = form;
      void _timezone;
      await api('/automation/settings', {
        method: 'PUT',
        body: {
          ...body,
          businessHours,
          welcomeMessage: body.welcomeMessage?.trim() || null,
          awayMessage: body.awayMessage?.trim() || null,
        },
      });
      await queryClient.invalidateQueries({ queryKey: automationKeys.settings });
      toast.success('Saved');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Messages</CardTitle>
          <CardDescription>
            Sent automatically, inside the 24-hour window the customer just opened. At most three
            automatic replies go to one conversation in an hour.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Checkbox
            label="Welcome new conversations"
            checked={form.welcomeEnabled}
            onChange={(v) => set('welcomeEnabled', v)}
          />
          {form.welcomeEnabled && (
            <FormField
              label="Welcome message"
              name="welcome"
              value={form.welcomeMessage ?? ''}
              onChange={(e) => set('welcomeMessage', e.target.value)}
            />
          )}
          <Checkbox
            label="Reply when we are closed"
            checked={form.awayEnabled}
            onChange={(v) => {
              set('awayEnabled', v);
              if (v) setUseHours(true);
            }}
          />
          {form.awayEnabled && (
            <FormField
              label="Away message"
              name="away"
              value={form.awayMessage ?? ''}
              onChange={(e) => set('awayMessage', e.target.value)}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Business hours</CardTitle>
          <CardDescription>In {settings.timezone}, the workspace’s time zone.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Checkbox label="We have set hours" checked={useHours} onChange={setUseHours} />
          {useHours &&
            WEEKDAYS.map((d) => (
              <div key={d} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="w-28">
                  <Checkbox
                    label={DAY_LABELS[d]}
                    checked={hours[d].open}
                    onChange={(open) => setHours((h) => ({ ...h, [d]: { ...h[d], open } }))}
                  />
                </span>
                {hours[d].open ? (
                  <>
                    <input
                      type="time"
                      aria-label={`${DAY_LABELS[d]} opens`}
                      className="rounded-md border bg-transparent px-2 py-1"
                      value={hours[d].from}
                      onChange={(e) =>
                        setHours((h) => ({ ...h, [d]: { ...h[d], from: e.target.value } }))
                      }
                    />
                    to
                    <input
                      type="time"
                      aria-label={`${DAY_LABELS[d]} closes`}
                      className="rounded-md border bg-transparent px-2 py-1"
                      value={hours[d].to}
                      onChange={(e) =>
                        setHours((h) => ({ ...h, [d]: { ...h[d], to: e.target.value } }))
                      }
                    />
                  </>
                ) : (
                  <span className="text-muted-foreground">Closed</span>
                )}
              </div>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Response time (SLA)</CardTitle>
          <CardDescription>
            The clock starts at a customer’s first unanswered message, and stops when a person
            replies or the conversation closes. Automatic replies do not stop it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Checkbox
            label="Track response time"
            checked={form.slaEnabled}
            onChange={(v) => set('slaEnabled', v)}
          />
          {form.slaEnabled && (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Reply within (minutes)"
                name="sla-minutes"
                type="number"
                min={1}
                value={String(form.slaFirstResponseMinutes)}
                onChange={(e) => set('slaFirstResponseMinutes', Number(e.target.value))}
              />
              <FormField
                label="Escalate after a further (minutes, blank for never)"
                name="sla-escalate"
                type="number"
                min={1}
                value={
                  form.slaEscalateAfterMinutes === null ? '' : String(form.slaEscalateAfterMinutes)
                }
                onChange={(e) =>
                  set('slaEscalateAfterMinutes', e.target.value ? Number(e.target.value) : null)
                }
              />
              {form.slaEscalateAfterMinutes !== null && (
                <Checkbox
                  label="On escalation, reassign to someone available"
                  checked={form.slaReassignOnEscalate}
                  onChange={(v) => set('slaReassignOnEscalate', v)}
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>When no assignment rule matches</CardTitle>
        </CardHeader>
        <CardContent>
          <Select
            value={form.defaultAssignment}
            onValueChange={(v) => set('defaultAssignment', v as DefaultAssignment)}
          >
            <SelectTrigger aria-label="Default assignment" className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Leave it unassigned</SelectItem>
              {ASSIGNMENT_STRATEGIES.map((s) => (
                <SelectItem key={s} value={s}>
                  Assign {STRATEGY_LABELS[s].toLowerCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          Save settings
        </Button>
      </div>
    </form>
  );
}

function AutoReplyDialog({
  rule,
  onClose,
}: {
  rule: AutoReplyRuleDto | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(rule?.name ?? '');
  const [matchType, setMatchType] = useState<AutoReplyMatchType>(rule?.matchType ?? 'contains');
  const [keywords, setKeywords] = useState(rule?.keywords.join(', ') ?? '');
  const [pattern, setPattern] = useState(rule?.pattern ?? '');
  const [reply, setReply] = useState(rule?.reply ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [busy, setBusy] = useState(false);
  const patternError = matchType === 'regex' && pattern ? regexProblem(pattern) : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(rule ? `/automation/auto-replies/${rule.id}` : '/automation/auto-replies', {
        method: rule ? 'PUT' : 'POST',
        body: {
          name: name.trim(),
          active: rule?.active ?? true,
          matchType,
          keywords: matchType === 'regex' ? [] : splitList(keywords),
          pattern: matchType === 'regex' ? pattern : null,
          reply: reply.trim(),
          phoneId: rule?.phoneId ?? null,
          priority: Number(priority) || 0,
        },
      });
      await queryClient.invalidateQueries({ queryKey: automationKeys.autoReplies });
      onClose();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{rule ? 'Edit auto-reply' : 'New auto-reply'}</DialogTitle>
            <DialogDescription>
              When a customer’s message matches, this reply goes straight back. The first matching
              rule, lowest priority number first, is the one that answers.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Name"
            name="rule-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="match-type">When the message</Label>
            <Select value={matchType} onValueChange={(v) => setMatchType(v as AutoReplyMatchType)}>
              <SelectTrigger id="match-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTO_REPLY_MATCH_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {MATCH_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {matchType === 'regex' ? (
            <FormField
              label="Pattern"
              name="pattern"
              value={pattern}
              error={patternError ?? undefined}
              placeholder="^order\s*#?\d{4,}$"
              onChange={(e) => setPattern(e.target.value)}
            />
          ) : (
            <FormField
              label="Keywords, separated by commas"
              name="keywords"
              value={keywords}
              placeholder="price, cost, how much"
              onChange={(e) => setKeywords(e.target.value)}
            />
          )}
          <FormField
            label="Reply"
            name="reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <FormField
            label="Priority"
            name="priority"
            type="number"
            min={0}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
          <DialogFooter>
            <Button
              type="submit"
              disabled={busy || !name.trim() || !reply.trim() || Boolean(patternError)}
            >
              Save rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AutoReplies() {
  const queryClient = useQueryClient();
  const rules = useAutoReplies();
  const [editing, setEditing] = useState<AutoReplyRuleDto | null | 'new'>(null);

  const remove = async (rule: AutoReplyRuleDto) => {
    if (!window.confirm(`Delete "${rule.name}"?`)) return;
    try {
      await api(`/automation/auto-replies/${rule.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: automationKeys.autoReplies });
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>Keyword auto-replies</CardTitle>
          <CardDescription>
            Answers for common questions, sent as soon as they arrive.
          </CardDescription>
        </div>
        <Button onClick={() => setEditing('new')}>New auto-reply</Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rules.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : !rules.data?.length ? (
          <p className="text-sm text-muted-foreground">No auto-replies yet.</p>
        ) : (
          rules.data.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
            >
              <span className="font-medium">{r.name}</span>
              {!r.active && <Badge variant="outline">Off</Badge>}
              <span className="text-muted-foreground">
                {MATCH_LABELS[r.matchType].toLowerCase()}{' '}
                {r.matchType === 'regex' ? r.pattern : r.keywords.join(', ')}
              </span>
              <span className="ml-auto flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditing(r)}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void remove(r)}>
                  Delete
                </Button>
              </span>
            </div>
          ))
        )}
      </CardContent>
      {editing && (
        <AutoReplyDialog
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function AssignmentRuleDialog({
  rule,
  onClose,
}: {
  rule: AssignmentRuleDto | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const members = useMembers();
  const tags = useTags();
  const [name, setName] = useState(rule?.name ?? '');
  const [strategy, setStrategy] = useState<AssignmentStrategy>(rule?.strategy ?? 'round_robin');
  const [keywords, setKeywords] = useState(rule?.keywords.join(', ') ?? '');
  const [tagIds, setTagIds] = useState<string[]>(rule?.tagIds ?? []);
  const [target, setTarget] = useState<'agents' | 'skill'>(rule?.skill ? 'skill' : 'agents');
  const [agentIds, setAgentIds] = useState<string[]>(rule?.agentIds ?? []);
  const [skill, setSkill] = useState(rule?.skill ?? '');
  const [busy, setBusy] = useState(false);
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(rule ? `/automation/assignment-rules/${rule.id}` : '/automation/assignment-rules', {
        method: rule ? 'PUT' : 'POST',
        body: {
          name: name.trim(),
          active: rule?.active ?? true,
          priority: rule?.priority ?? 100,
          strategy,
          tagIds,
          phoneIds: rule?.phoneIds ?? [],
          keywords: splitList(keywords),
          agentIds: target === 'agents' ? agentIds : [],
          skill: target === 'skill' ? skill.trim() : null,
        },
      });
      await queryClient.invalidateQueries({ queryKey: automationKeys.assignmentRules });
      onClose();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{rule ? 'Edit assignment rule' : 'New assignment rule'}</DialogTitle>
            <DialogDescription>
              For new conversations nobody has yet. Only available agents are given work. If nobody
              in this rule is available, the next rule is tried.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Name"
            name="assign-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <FormField
            label="When the message contains (optional, separated by commas)"
            name="assign-keywords"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
          />
          {(tags.data ?? []).length > 0 && (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-sm font-medium">
                Or the contact has a tag (optional)
              </legend>
              {(tags.data ?? []).map((t) => (
                <Checkbox
                  key={t.id}
                  label={t.name}
                  checked={tagIds.includes(t.id)}
                  onChange={(on) => setTagIds((l) => toggle(l, t.id, on))}
                />
              ))}
            </fieldset>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="assign-target">Give it to</Label>
            <Select value={target} onValueChange={(v) => setTarget(v as 'agents' | 'skill')}>
              <SelectTrigger id="assign-target" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agents">These people</SelectItem>
                <SelectItem value="skill">Anyone with a skill</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {target === 'agents' ? (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="sr-only">People</legend>
              {(members.data ?? [])
                .filter((m) => m.status === 'active')
                .map((m) => (
                  <Checkbox
                    key={m.userId}
                    label={m.name}
                    checked={agentIds.includes(m.userId)}
                    onChange={(on) => setAgentIds((l) => toggle(l, m.userId, on))}
                  />
                ))}
            </fieldset>
          ) : (
            <FormField
              label="Skill"
              name="assign-skill"
              value={skill}
              placeholder="hindi"
              onChange={(e) => setSkill(e.target.value)}
            />
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="assign-strategy">How</Label>
            <Select value={strategy} onValueChange={(v) => setStrategy(v as AssignmentStrategy)}>
              <SelectTrigger id="assign-strategy" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNMENT_STRATEGIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STRATEGY_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={
                busy ||
                !name.trim() ||
                (target === 'agents' ? agentIds.length === 0 : !skill.trim())
              }
            >
              Save rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Assignment() {
  const queryClient = useQueryClient();
  const rules = useAssignmentRules();
  const members = useMembers();
  const [editing, setEditing] = useState<AssignmentRuleDto | null | 'new'>(null);

  const remove = async (rule: AssignmentRuleDto) => {
    if (!window.confirm(`Delete "${rule.name}"?`)) return;
    try {
      await api(`/automation/assignment-rules/${rule.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: automationKeys.assignmentRules });
    } catch (err) {
      handleApiError(err);
    }
  };

  const saveSkills = async (membershipId: string, value: string) => {
    try {
      await api(`/automation/members/${membershipId}/skills`, {
        method: 'PUT',
        body: { skills: splitList(value) },
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.members });
      toast.success('Skills saved');
    } catch (err) {
      handleApiError(err);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle>Assignment rules</CardTitle>
            <CardDescription>
              Checked in order. The first that can assign someone does.
            </CardDescription>
          </div>
          <Button onClick={() => setEditing('new')}>New rule</Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {rules.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : !rules.data?.length ? (
            <p className="text-sm text-muted-foreground">No rules yet.</p>
          ) : (
            rules.data.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
              >
                <span className="font-medium">{r.name}</span>
                <span className="text-muted-foreground">
                  {r.skill ? `skill: ${r.skill}` : `${r.agentIds.length} people`},{' '}
                  {STRATEGY_LABELS[r.strategy].toLowerCase()}
                </span>
                <span className="ml-auto flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void remove(r)}>
                    Delete
                  </Button>
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Team availability and skills</CardTitle>
          <CardDescription>
            People set their own availability from their account menu. Skills are for skill-based
            rules.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(members.data ?? [])
            .filter((m) => m.status === 'active')
            .map((m) => (
              <form
                key={m.id}
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = new FormData(e.currentTarget).get('skills');
                  void saveSkills(m.id, String(input ?? ''));
                }}
              >
                <div className="w-40 text-sm">
                  <div className="font-medium">{m.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {m.available ? 'Available' : 'Not taking new conversations'}
                  </div>
                </div>
                <div className="min-w-48 flex-1">
                  <FormField
                    label={`Skills for ${m.name}`}
                    name="skills"
                    defaultValue={m.skills.join(', ')}
                    placeholder="hindi, billing"
                  />
                </div>
                <Button type="submit" variant="outline" size="sm">
                  Save
                </Button>
              </form>
            ))}
        </CardContent>
      </Card>
      {editing && (
        <AssignmentRuleDialog
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

export default function AutomationSettingsPage() {
  const canManage = useCan(Permission.AUTOMATION_MANAGE);
  const settings = useAutomationSettings();

  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">Only owners and admins can change automation.</p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <AutoReplies />
      {settings.data ? (
        <MessagesAndSla key={JSON.stringify(settings.data)} settings={settings.data} />
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
      <Assignment />
    </div>
  );
}
