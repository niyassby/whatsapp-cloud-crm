import { describe, expect, it } from 'vitest';
import {
  assignmentRuleSchema,
  autoReplyRuleSchema,
  automationSettingsSchema,
  type BusinessHours,
  DEFAULT_AUTOMATION_SETTINGS,
  isWithinBusinessHours,
  localTime,
  matchesRule,
  normalizeForMatch,
  pickLeastLoaded,
  pickRoundRobin,
  regexProblem,
} from './automation';

describe('business hours', () => {
  const weekdays: BusinessHours = {
    days: {
      mon: [{ from: '09:00', to: '18:00' }],
      tue: [{ from: '09:00', to: '18:00' }],
      sat: [
        { from: '10:00', to: '13:00' },
        { from: '14:00', to: '16:00' },
      ],
    },
  };
  // 2026-11-09 is a Monday.
  const at = (iso: string) => new Date(iso);

  it('reads the weekday and time in the organization’s time zone', () => {
    // 03:30 UTC is 09:00 in Kolkata, on the same Monday.
    expect(localTime(at('2026-11-09T03:30:00Z'), 'Asia/Kolkata')).toEqual({
      day: 'mon',
      minutes: 540,
    });
    // 23:30 UTC on Sunday is already Monday in Tokyo.
    expect(localTime(at('2026-11-08T23:30:00Z'), 'Asia/Tokyo').day).toBe('mon');
  });

  it('is open inside a span, from its start up to but not including its end', () => {
    const tz = 'Asia/Kolkata';
    expect(isWithinBusinessHours(weekdays, tz, at('2026-11-09T03:29:00Z'))).toBe(false);
    expect(isWithinBusinessHours(weekdays, tz, at('2026-11-09T03:30:00Z'))).toBe(true);
    expect(isWithinBusinessHours(weekdays, tz, at('2026-11-09T12:29:00Z'))).toBe(true);
    expect(isWithinBusinessHours(weekdays, tz, at('2026-11-09T12:30:00Z'))).toBe(false);
  });

  it('a day with no hours is closed, and a day can have a break', () => {
    const tz = 'UTC';
    expect(isWithinBusinessHours(weekdays, tz, at('2026-11-11T10:00:00Z'))).toBe(false);
    expect(isWithinBusinessHours(weekdays, tz, at('2026-11-14T11:00:00Z'))).toBe(true);
    expect(isWithinBusinessHours(weekdays, tz, at('2026-11-14T13:30:00Z'))).toBe(false);
    expect(isWithinBusinessHours(weekdays, tz, at('2026-11-14T15:00:00Z'))).toBe(true);
  });

  it('no hours set means always open', () => {
    expect(isWithinBusinessHours(null, 'UTC', at('2026-11-15T03:00:00Z'))).toBe(true);
  });

  it('refuses a span that ends before it starts', () => {
    const settings = {
      ...DEFAULT_AUTOMATION_SETTINGS,
      businessHours: { days: { mon: [{ from: '18:00', to: '09:00' }] } },
    };
    expect(automationSettingsSchema.safeParse(settings).success).toBe(false);
  });
});

describe('keyword matching', () => {
  const rule = (matchType: 'exact' | 'contains' | 'regex', keywords: string[], pattern = null) => ({
    matchType,
    keywords,
    pattern: pattern as string | null,
  });

  it('ignores case, spacing and surrounding punctuation', () => {
    expect(normalizeForMatch('  Price?? ')).toBe('price');
    expect(normalizeForMatch('Opening   HOURS!')).toBe('opening hours');
  });

  it('exact needs the whole message', () => {
    const r = rule('exact', ['price', 'Opening hours']);
    expect(matchesRule(r, 'PRICE?')).toBe(true);
    expect(matchesRule(r, 'opening   hours')).toBe(true);
    expect(matchesRule(r, 'what is the price')).toBe(false);
  });

  it('contains matches whole words, not inside other words', () => {
    const r = rule('contains', ['hi', 'order status']);
    expect(matchesRule(r, 'Hi there')).toBe(true);
    expect(matchesRule(r, 'what is my order status?')).toBe(true);
    expect(matchesRule(r, 'this is it')).toBe(false);
    expect(matchesRule(r, 'order statuses')).toBe(false);
  });

  it('works in other scripts', () => {
    expect(matchesRule(rule('contains', ['नमस्ते']), 'नमस्ते जी')).toBe(true);
    expect(matchesRule(rule('exact', ['مرحبا']), 'مرحبا!')).toBe(true);
  });

  it('keywords with regex characters are taken literally', () => {
    expect(matchesRule(rule('contains', ['c++']), 'do you teach c++ classes')).toBe(true);
    expect(matchesRule(rule('contains', ['a.b']), 'axb')).toBe(false);
  });

  it('regex, case-insensitive', () => {
    expect(matchesRule(rule('regex', [], '^order\\s*#?\\d{4,}$' as never), 'Order #10421')).toBe(
      true,
    );
    expect(matchesRule(rule('regex', [], '^order\\s*#?\\d{4,}$' as never), 'order 12')).toBe(false);
  });

  it('nothing matches an empty message, or media with no caption', () => {
    expect(matchesRule(rule('contains', ['hi']), null)).toBe(false);
    expect(matchesRule(rule('contains', ['hi']), '   ')).toBe(false);
  });
});

describe('regex safety', () => {
  it.each(['^hi$', 'order\\s*#?\\d+', '(yes|yeah|yep)', '\\b(price|cost)\\b'])(
    'allows %s',
    (pattern) => {
      expect(regexProblem(pattern)).toBeNull();
    },
  );

  it.each([
    ['(a+)+$', 'Nested'],
    ['(\\w*)*x', 'Nested'],
    ['(a|aa){2,}', null],
    ['(.)\\1', 'Backreferences'],
    ['[', 'not a valid'],
    ['a'.repeat(201), 'under 200'],
  ])('handles %s', (pattern, problem) => {
    const result = regexProblem(pattern);
    if (problem) expect(result).toContain(problem);
  });

  it('a refused pattern never matches, even if it got stored', () => {
    expect(matchesRule({ matchType: 'regex', keywords: [], pattern: '(a+)+$' }, 'aaaa')).toBe(
      false,
    );
  });

  it('the rule schema refuses an unsafe pattern, and keyword rules with no keywords', () => {
    const base = { name: 'x', reply: 'y' };
    expect(
      autoReplyRuleSchema.safeParse({ ...base, matchType: 'regex', pattern: '(a+)+' }).success,
    ).toBe(false);
    expect(autoReplyRuleSchema.safeParse({ ...base, matchType: 'contains' }).success).toBe(false);
    expect(
      autoReplyRuleSchema.safeParse({ ...base, matchType: 'contains', keywords: ['hi'] }).success,
    ).toBe(true);
  });
});

describe('picking an agent', () => {
  it('round-robin takes the next after the last, and wraps round', () => {
    const agents = ['c', 'a', 'b'];
    expect(pickRoundRobin(agents, null)).toBe('a');
    expect(pickRoundRobin(agents, 'a')).toBe('b');
    expect(pickRoundRobin(agents, 'b')).toBe('c');
    expect(pickRoundRobin(agents, 'c')).toBe('a');
  });

  it('round-robin carries on when the last one is no longer available', () => {
    expect(pickRoundRobin(['a', 'c'], 'b')).toBe('c');
    expect(pickRoundRobin([], 'b')).toBeNull();
  });

  it('load-based takes the least busy, ties in a fixed order', () => {
    expect(
      pickLeastLoaded([
        { userId: 'b', open: 3 },
        { userId: 'a', open: 1 },
        { userId: 'c', open: 1 },
      ]),
    ).toBe('a');
    expect(pickLeastLoaded([])).toBeNull();
  });

  it('an assignment rule needs someone to assign to', () => {
    expect(assignmentRuleSchema.safeParse({ name: 'x', strategy: 'round_robin' }).success).toBe(
      false,
    );
    expect(
      assignmentRuleSchema.safeParse({ name: 'x', strategy: 'round_robin', skill: 'Hindi' }).data
        ?.skill,
    ).toBe('hindi');
  });
});

describe('settings', () => {
  it('needs the message for what is switched on, and hours for away', () => {
    const on = { ...DEFAULT_AUTOMATION_SETTINGS, welcomeEnabled: true };
    expect(automationSettingsSchema.safeParse(on).success).toBe(false);
    const away = { ...DEFAULT_AUTOMATION_SETTINGS, awayEnabled: true, awayMessage: 'Back soon' };
    expect(automationSettingsSchema.safeParse(away).success).toBe(false);
    expect(automationSettingsSchema.safeParse(DEFAULT_AUTOMATION_SETTINGS).success).toBe(true);
  });
});
