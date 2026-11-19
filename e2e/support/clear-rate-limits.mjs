/**
 * Clears the API's rate-limit counters (`<QUEUE_PREFIX>:rl:*`) before an e2e run. Every browser in the suite
 * comes from 127.0.0.1, so counters left by an earlier run within the hour (invitations accepted,
 * logins) would refuse this one. Local test Redis only: the keys are just counters.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.resolve(import.meta.dirname, '../../apps/api/package.json'));
const { Redis } = require('ioredis');

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
let cursor = '0';
let cleared = 0;
do {
  const [next, keys] = await redis.scan(
    cursor,
    'MATCH',
    `${process.env.QUEUE_PREFIX ?? 'wacrm'}:rl:*`,
    'COUNT',
    1000,
  );
  if (keys.length) cleared += await redis.del(...keys);
  cursor = next;
} while (cursor !== '0');
await redis.quit();
console.log(`Cleared ${cleared} rate-limit counters.`);
