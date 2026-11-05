import { logLevelSchema, nodeEnvSchema, parseEnv } from '@wacrm/shared';
import { s3EnvShape } from '@wacrm/shared/server';
import { z } from 'zod';

export const workerEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4001),
  /** Non-owner app role (member of app_user) so Postgres RLS applies. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://127.0.0.1:6379'),
  QUEUE_PREFIX: z.string().min(1).default('wacrm'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  /** Decrypts WhatsApp tokens. Same keys as the API. */
  ENCRYPTION_KEY: z.string().min(1),
  ENCRYPTION_KEY_PREVIOUS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean)
        : [],
    ),
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v25.0'),
  META_GRAPH_BASE_URL: z.url().optional(),
  /** Cloud API default throughput per number. Config, since Meta raises it for some numbers. */
  OUTBOUND_MPS_PER_NUMBER: z.coerce.number().int().positive().default(80),
  ...s3EnvShape,
  /** Raw webhook payloads are kept this long for replay. */
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const loadWorkerEnv = (source?: Record<string, string | undefined>): WorkerEnv =>
  parseEnv(workerEnvSchema, source);
