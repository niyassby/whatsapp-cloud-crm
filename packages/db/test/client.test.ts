import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { appClient } from './fixtures';

let app: DbClient;

beforeAll(() => {
  app = appClient();
});
afterAll(async () => {
  await app.$disconnect();
});

describe('connections', () => {
  it('run in UTC, whatever the server is set to', async () => {
    const [row] = await app.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    expect(row?.tz).toBe('UTC');
  });

  it('a Date in raw SQL means the same instant on any server', async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);
    // What the stale-send and due-run queries rely on: an older timestamp compares as older.
    const [row] = await app.$queryRaw<{ older: boolean; drift: number }[]>`
      SELECT (now() - interval '10 minutes') < ${fiveMinutesAgo} AS older,
             abs(extract(epoch FROM (now() - interval '10 minutes') - ${tenMinutesAgo}::timestamptz))
               AS drift`;
    expect(row?.older).toBe(true);
    expect(Number(row?.drift)).toBeLessThan(60);
  });
});
