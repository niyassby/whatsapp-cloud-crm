/**
 * Rules and routing (Phase 3.1): auto-replies, business hours, assignment and SLA. The matching
 * and picking logic is pure, so the worker uses it and the tests pin it without a database.
 */
import { z } from 'zod';

// ------------------------------------------------------------------ business hours

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Use HH:MM, such as 09:30');
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const span = z
  .object({ from: time, to: time })
  .refine((s) => minutesOf(s.to) > minutesOf(s.from), 'The end must be after the start');

/** Open spans per weekday, in the organization's time zone. A day with no spans is closed. */
export const businessHoursSchema = z.object({
  days: z.partialRecord(z.enum(WEEKDAYS), z.array(span).max(4)),
});
export type BusinessHours = z.infer<typeof businessHoursSchema>;

const WEEKDAY_FROM_INTL: Record<string, Weekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

/** The weekday and minutes past midnight at this moment, in a time zone. */
export function localTime(at: Date, timezone: string): { day: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: WEEKDAY_FROM_INTL[get('weekday')] ?? 'mon',
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** No hours set means always open. */
export function isWithinBusinessHours(
  hours: BusinessHours | null,
  timezone: string,
  at: Date,
): boolean {
  if (!hours) return true;
  const { day, minutes } = localTime(at, timezone);
  return (hours.days[day] ?? []).some(
    (s) => minutes >= minutesOf(s.from) && minutes < minutesOf(s.to),
  );
}

// ------------------------------------------------------------------ keyword matching

export const AUTO_REPLY_MATCH_TYPES = ['exact', 'contains', 'regex'] as const;
export type AutoReplyMatchType = (typeof AUTO_REPLY_MATCH_TYPES)[number];

/** Long enough for any real message. A regex never sees more, which bounds its cost. */
export const MATCH_TEXT_LIMIT = 1000;

/** Case, spacing and surrounding punctuation do not matter: "Price?" matches "price". */
export const normalizeForMatch = (text: string) =>
  text
    .slice(0, MATCH_TEXT_LIMIT)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Why this pattern cannot be used, or null. Patterns run on every inbound message in a shared
 * worker, so ones that can take exponential time are refused: backreferences and a quantified group
 * that itself contains a quantifier, such as (a+)+. Text is also capped at MATCH_TEXT_LIMIT.
 */
export function regexProblem(pattern: string): string | null {
  if (pattern.length > 200) return 'Keep the pattern under 200 characters';
  try {
    new RegExp(pattern, 'iu');
  } catch {
    return 'This is not a valid regular expression';
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'Backreferences are not allowed';
  if (/\((?:[^()\\]|\\.)*[*+}](?:[^()\\]|\\.)*\)\s*[*+{?]/.test(pattern)) {
    return 'Nested repetition, such as (a+)+, is not allowed because it can be very slow';
  }
  return null;
}

export interface MatchableRule {
  matchType: AutoReplyMatchType;
  keywords: string[];
  pattern: string | null;
}

/**
 * Exact: the whole message is one of the keywords. Contains: a keyword appears as whole words, so
 * "hi" matches "hi there" but not "this". Regex: tested case-insensitively on the message.
 */
export function matchesRule(rule: MatchableRule, text: string | null): boolean {
  if (!text) return false;
  const normalized = normalizeForMatch(text);
  if (!normalized) return false;
  if (rule.matchType === 'regex') {
    if (!rule.pattern || regexProblem(rule.pattern)) return false;
    return new RegExp(rule.pattern, 'iu').test(text.slice(0, MATCH_TEXT_LIMIT));
  }
  return rule.keywords.some((raw) => {
    const keyword = normalizeForMatch(raw);
    if (!keyword) return false;
    if (rule.matchType === 'exact') return normalized === keyword;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(keyword)}($|[^\\p{L}\\p{N}])`, 'u').test(
      normalized,
    );
  });
}

// ------------------------------------------------------------------ assignment

export const ASSIGNMENT_STRATEGIES = ['round_robin', 'load_based'] as const;
export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGIES)[number];

export const DEFAULT_ASSIGNMENTS = ['none', ...ASSIGNMENT_STRATEGIES] as const;
export type DefaultAssignment = (typeof DEFAULT_ASSIGNMENTS)[number];

/** The next agent after the last one given work, wrapping round. Candidates in a fixed order. */
export function pickRoundRobin(candidates: string[], lastAssigned: string | null): string | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort();
  const next = lastAssigned ? sorted.find((id) => id > lastAssigned) : undefined;
  return next ?? sorted[0] ?? null;
}

/** Whoever has the fewest open conversations. Ties go to the earliest in a fixed order. */
export function pickLeastLoaded(loads: { userId: string; open: number }[]): string | null {
  const sorted = [...loads].sort((a, b) => a.open - b.open || (a.userId < b.userId ? -1 : 1));
  return sorted[0]?.userId ?? null;
}

// ------------------------------------------------------------------ limits on automated replies

/** At most this many automated replies in one conversation per hour, whatever the rules say. */
export const MAX_AUTOMATED_REPLIES_PER_HOUR = 3;

/** What kind of automation sent a message, kept on the message for the inbox and for limits. */
export type AutomationKind = 'welcome' | 'keyword' | 'away';

// ------------------------------------------------------------------ input

const message = z.string().trim().min(1, 'Write the message').max(4096);
const skill = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N} _-]+$/u, 'Use letters, numbers, spaces, dashes or underscores');

export const automationSettingsSchema = z
  .object({
    welcomeEnabled: z.boolean(),
    welcomeMessage: z.string().trim().max(4096).nullable(),
    awayEnabled: z.boolean(),
    awayMessage: z.string().trim().max(4096).nullable(),
    businessHours: businessHoursSchema.nullable(),
    /** One away message per conversation within this long. */
    awayCooldownMinutes: z.number().int().min(10).max(10080),
    defaultAssignment: z.enum(DEFAULT_ASSIGNMENTS),
    slaEnabled: z.boolean(),
    slaFirstResponseMinutes: z.number().int().min(1).max(10080),
    /** After a breach, how long before it escalates. Null means it does not escalate. */
    slaEscalateAfterMinutes: z.number().int().min(1).max(10080).nullable(),
    slaReassignOnEscalate: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.welcomeEnabled && !v.welcomeMessage) {
      ctx.addIssue({ code: 'custom', path: ['welcomeMessage'], message: 'Write the message' });
    }
    if (v.awayEnabled && !v.awayMessage) {
      ctx.addIssue({ code: 'custom', path: ['awayMessage'], message: 'Write the message' });
    }
    if (v.awayEnabled && !v.businessHours) {
      ctx.addIssue({
        code: 'custom',
        path: ['businessHours'],
        message: 'Set your business hours, so it is clear when you are away',
      });
    }
  });
export type AutomationSettingsInput = z.infer<typeof automationSettingsSchema>;

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettingsInput = {
  welcomeEnabled: false,
  welcomeMessage: null,
  awayEnabled: false,
  awayMessage: null,
  businessHours: null,
  awayCooldownMinutes: 720,
  defaultAssignment: 'none',
  slaEnabled: false,
  slaFirstResponseMinutes: 60,
  slaEscalateAfterMinutes: null,
  slaReassignOnEscalate: false,
};

export const autoReplyRuleSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the rule a name').max(80),
    active: z.boolean().default(true),
    matchType: z.enum(AUTO_REPLY_MATCH_TYPES),
    keywords: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    pattern: z.string().max(200).nullable().default(null),
    reply: message,
    /** Only on this WhatsApp number. Null means every number. */
    phoneId: z.uuid().nullable().default(null),
    /** Lower runs first. The first matching rule replies. */
    priority: z.number().int().min(0).max(1000).default(100),
  })
  .superRefine((v, ctx) => {
    if (v.matchType === 'regex') {
      const problem = v.pattern ? regexProblem(v.pattern) : 'Write a pattern';
      if (problem) ctx.addIssue({ code: 'custom', path: ['pattern'], message: problem });
    } else if (v.keywords.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['keywords'], message: 'Add at least one keyword' });
    }
  });
export type AutoReplyRuleInput = z.input<typeof autoReplyRuleSchema>;
export type AutoReplyRuleParsed = z.infer<typeof autoReplyRuleSchema>;

export const assignmentRuleSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the rule a name').max(80),
    active: z.boolean().default(true),
    priority: z.number().int().min(0).max(1000).default(100),
    strategy: z.enum(ASSIGNMENT_STRATEGIES),
    /** All conditions that are set must match. None set matches every conversation. */
    tagIds: z.array(z.uuid()).max(20).default([]),
    phoneIds: z.array(z.uuid()).max(20).default([]),
    keywords: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    /** Who it goes to: these agents, or everyone with this skill. */
    agentIds: z.array(z.uuid()).max(100).default([]),
    skill: skill.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.agentIds.length === 0 && !v.skill) {
      ctx.addIssue({ code: 'custom', path: ['agentIds'], message: 'Choose agents or a skill' });
    }
  });
export type AssignmentRuleInput = z.input<typeof assignmentRuleSchema>;
export type AssignmentRuleParsed = z.infer<typeof assignmentRuleSchema>;

export const setAvailabilitySchema = z.object({ available: z.boolean() });
export const setSkillsSchema = z.object({ skills: z.array(skill).max(20) });

export const listNotificationsSchema = z.object({
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsSchema>;

export const markNotificationsReadSchema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(200) }),
  z.object({ all: z.literal(true) }),
]);
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;

// ------------------------------------------------------------------ DTOs

export interface AutomationSettingsDto extends AutomationSettingsInput {
  timezone: string;
}

export interface AutoReplyRuleDto extends AutoReplyRuleParsed {
  id: string;
  createdAt: string;
}

export interface AssignmentRuleDto extends AssignmentRuleParsed {
  id: string;
  createdAt: string;
}

export const NOTIFICATION_KINDS = [
  'conversation_assigned',
  'sla_breached',
  'sla_escalated',
  'integration_needs_reconnect',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationDto {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  conversationId: string | null;
  readAt: string | null;
  createdAt: string;
}
