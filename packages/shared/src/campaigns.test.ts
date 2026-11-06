import { describe, expect, it } from 'vitest';
import {
  broadcastSkipReason,
  createCampaignSchema,
  isValidTimeZone,
  launchCampaignSchema,
  saveDripSchema,
  toCampaignCounts,
  zonedTimeToUtc,
} from './campaigns';

describe('zonedTimeToUtc', () => {
  it.each([
    ['2026-11-06T09:00', 'Asia/Kolkata', '2026-11-06T03:30:00.000Z'],
    ['2026-11-06T09:00', 'UTC', '2026-11-06T09:00:00.000Z'],
    ['2026-01-15T09:00', 'America/New_York', '2026-01-15T14:00:00.000Z'],
    ['2026-07-15T09:00', 'America/New_York', '2026-07-15T13:00:00.000Z'],
    ['2026-07-15T23:30', 'Asia/Tokyo', '2026-07-15T14:30:00.000Z'],
  ])('%s in %s is %s', (local, zone, utc) => {
    expect(zonedTimeToUtc(local, zone).toISOString()).toBe(utc);
  });

  it('handles the days clocks change', () => {
    // New York moved to summer time at 02:00 on 8 March 2026.
    expect(zonedTimeToUtc('2026-03-08T01:00', 'America/New_York').toISOString()).toBe(
      '2026-03-08T06:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-03-08T03:00', 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:00:00.000Z',
    );
  });

  it('refuses text that is not a time', () => {
    expect(() => zonedTimeToUtc('tomorrow', 'UTC')).toThrow();
  });
});

describe('isValidTimeZone', () => {
  it('knows real zones', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
  });
});

describe('broadcastSkipReason', () => {
  it('needs consent for marketing', () => {
    expect(broadcastSkipReason('opted_in', 'MARKETING')).toBeNull();
    expect(broadcastSkipReason('unknown', 'MARKETING')).toBe('no_consent');
  });

  it('lets utility go to contacts with no recorded choice', () => {
    expect(broadcastSkipReason('unknown', 'UTILITY')).toBeNull();
  });

  it('sends no broadcast to someone who said STOP, even a utility one', () => {
    expect(broadcastSkipReason('opted_out', 'UTILITY')).toBe('opted_out');
    expect(broadcastSkipReason('opted_out', 'MARKETING')).toBe('opted_out');
  });
});

describe('toCampaignCounts', () => {
  it('reads as a funnel, where a read message was also delivered and sent', () => {
    expect(
      toCampaignCounts([
        { status: 'sent', count: 1 },
        { status: 'delivered', count: 2 },
        { status: 'read', count: 3 },
        { status: 'replied', count: 4 },
        { status: 'failed', count: 5 },
        { status: 'skipped', count: 6 },
        { status: 'pending', count: 7 },
      ]),
    ).toEqual({
      total: 28,
      pending: 7,
      sending: 0,
      sent: 10,
      delivered: 9,
      read: 7,
      replied: 4,
      failed: 5,
      skipped: 6,
      cancelled: 0,
    });
  });
});

describe('schemas', () => {
  const ids = {
    phoneId: '01900000-0000-7000-8000-000000000001',
    templateId: '01900000-0000-7000-8000-000000000002',
  };

  it('a campaign needs a name', () => {
    expect(createCampaignSchema.safeParse({ ...ids, name: ' ' }).success).toBe(false);
    expect(createCampaignSchema.parse({ ...ids, name: 'Launch' }).audience.type).toBe('segment');
  });

  it('a schedule needs a real time zone', () => {
    const at = { when: 'scheduled', localTime: '2026-11-06T09:00' };
    expect(launchCampaignSchema.safeParse({ ...at, timezone: 'Asia/Kolkata' }).success).toBe(true);
    expect(launchCampaignSchema.safeParse({ ...at, timezone: 'Nope' }).success).toBe(false);
    expect(launchCampaignSchema.safeParse({ when: 'now' }).success).toBe(true);
  });

  it('a drip needs at least one step', () => {
    const base = { name: 'Welcome', phoneId: ids.phoneId };
    expect(saveDripSchema.safeParse({ ...base, steps: [] }).success).toBe(false);
    const ok = saveDripSchema.parse({
      ...base,
      steps: [{ delayMinutes: '60', templateId: ids.templateId }],
    });
    expect(ok.steps[0]?.delayMinutes).toBe(60);
    expect(ok.exitOnReply).toBe(true);
  });
});
