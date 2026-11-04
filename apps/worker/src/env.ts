import { z } from 'zod';
import { logLevelSchema, nodeEnvSchema, parseEnv } from '@wacrm/shared';

export const workerEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4001),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const loadWorkerEnv = (source?: Record<string, string | undefined>): WorkerEnv =>
  parseEnv(workerEnvSchema, source);
