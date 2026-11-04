import { z } from 'zod';
import { logLevelSchema, nodeEnvSchema, parseEnv } from '@wacrm/shared';

export const apiEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_URL: z.url().default('http://localhost:3000'),
  /** Non-owner app role (member of app_user) so Postgres RLS applies. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const loadApiEnv = (source?: Record<string, string | undefined>): ApiEnv =>
  parseEnv(apiEnvSchema, source);

/** DI token for the validated env. */
export const API_ENV = Symbol('API_ENV');
