import { describe, expect, it } from 'vitest';
import {
  type AgentsReportDto,
  formatDuration,
  lastDays,
  localDate,
  nextScheduleRun,
  reportRangeSchema,
  reportToCsv,
  schedulePeriod,
  zonedToUtc,
} from './reports';

describe('time zones', () => {
  it('finds the instant of a local time, half-hour zones included', () => {
    expect(zonedToUtc('2026-11-14', 8, 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-14T02:30:00.000Z',
    );
    expect(zonedToUtc('2026-11-14', 8, 'UTC').toISOString()).toBe('2026-11-14T08:00:00.000Z');
    // New York in summer and in winter.
    expect(zonedToUtc('2026-07-01', 8, 'America/New_York').toISOString()).toBe(
      '2026-07-01T12:00:00.000Z',
    );
    expect(zonedToUtc('2026-12-01', 8, 'America/New_York').toISOString()).toBe(
      '2026-12-01T13:00:00.000Z',
    );
  });

  it('knows the local date, and the last N days end today', () => {
    const at = new Date('2026-11-14T20:00:00Z'); // 01:30 on the 15th in Kolkata
    expect(localDate(at, 'Asia/Kolkata')).toBe('2026-11-15');
    expect(localDate(at, 'UTC')).toBe('2026-11-14');
    expect(lastDays(7, 'Asia/Kolkata', at)).toEqual({ from: '2026-11-09', to: '2026-11-15' });
  });
});

describe('schedules', () => {
  const tz = 'Asia/Kolkata';

  it('runs daily at the next local hour', () => {
    const after = new Date('2026-11-14T01:00:00Z'); // 06:30 local
    expect(nextScheduleRun('daily', 8, tz, after).toISOString()).toBe('2026-11-14T02:30:00.000Z');
    expect(nextScheduleRun('daily', 8, tz, new Date('2026-11-14T02:30:00Z')).toISOString()).toBe(
      '2026-11-15T02:30:00.000Z',
    );
  });

  it('runs weekly on Monday and monthly on the 1st', () => {
    const saturday = new Date('2026-11-14T06:00:00Z');
    expect(nextScheduleRun('weekly', 9, tz, saturday).toISOString()).toBe(
      '2026-11-16T03:30:00.000Z',
    );
    expect(nextScheduleRun('monthly', 9, tz, saturday).toISOString()).toBe(
      '2026-12-01T03:30:00.000Z',
    );
  });

  it('covers the whole period before the day it runs', () => {
    const monday = new Date('2026-11-16T03:30:00Z');
    expect(schedulePeriod('daily', monday, tz)).toEqual({ from: '2026-11-15', to: '2026-11-15' });
    expect(schedulePeriod('weekly', monday, tz)).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    const first = new Date('2026-12-01T03:30:00Z');
    expect(schedulePeriod('monthly', first, tz)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });
});

describe('ranges and files', () => {
  it('refuses a backwards range and more than 366 days', () => {
    expect(reportRangeSchema.safeParse({ from: '2026-11-01', to: '2026-11-30' }).success).toBe(
      true,
    );
    expect(reportRangeSchema.safeParse({ from: '2026-11-30', to: '2026-11-01' }).success).toBe(
      false,
    );
    expect(reportRangeSchema.safeParse({ from: '2025-01-01', to: '2026-11-01' }).success).toBe(
      false,
    );
  });

  it('formats durations for people', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(200)).toBe('3m 20s');
    expect(formatDuration(3900)).toBe('1h 5m');
    expect(formatDuration(3 * 86_400)).toBe('3d 0h');
    expect(formatDuration(null)).toBe('');
  });

  it('writes CSV with raw seconds and no formulas', () => {
    const report: AgentsReportDto = {
      kind: 'agents',
      period: { from: '2026-11-01', to: '2026-11-30', timezone: 'UTC' },
      rows: [
        {
          userId: 'u',
          name: '=HYPERLINK("x")',
          email: 'a@b.c',
          messages: 10,
          notes: 1,
          responses: 4,
          medianResponseSeconds: 125.4,
          resolved: 2,
          medianResolutionSeconds: null,
          openAssigned: 3,
        },
      ],
    };
    const [header, row] = reportToCsv(report).split('\r\n');
    expect(header).toContain('Median first response (seconds)');
    expect(row).toBe(`"'=HYPERLINK(""x"")",a@b.c,10,1,4,125,2,,3`);
  });
});

describe('duration histograms', () => {
  it('buckets are 10% wide and percentiles land within 5% of the exact value', async () => {
    const { histogramBucket, histogramPercentile } = await import('./reports');
    expect(histogramBucket(0.4)).toBe(0);
    expect(histogramBucket(1)).toBe(1);
    expect(histogramBucket(1.1 ** 10 + 0.001)).toBe(11);
    // 10,000 response times spread from 10 seconds to 2 hours.
    const values = Array.from(
      { length: 10_000 },
      (_, i) => 10 * Math.exp((i / 9_999) * Math.log(720)),
    );
    const counts = new Map<number, number>();
    for (const v of values)
      counts.set(histogramBucket(v), (counts.get(histogramBucket(v)) ?? 0) + 1);
    const exact = (q: number) => {
      const r = q * (values.length - 1);
      const lo = Math.floor(r);
      return values[lo]! + (values[Math.min(lo + 1, values.length - 1)]! - values[lo]!) * (r - lo);
    };
    for (const q of [0.5, 0.9]) {
      const got = histogramPercentile(counts, q)!;
      expect(Math.abs(got - exact(q)) / exact(q)).toBeLessThan(0.05);
    }
    expect(histogramPercentile(new Map(), 0.5)).toBeNull();
  });
});
