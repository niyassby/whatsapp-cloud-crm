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
  /** Instagram messaging: the Instagram app of the Meta app (App Dashboard > Instagram). */
  INSTAGRAM_APP_ID: z.string().min(1).optional(),
  INSTAGRAM_APP_SECRET: z.string().min(1).optional(),
  /** Local fakes only: one base for Instagram login, token exchange and Graph. Refused in production. */
  INSTAGRAM_BASE_URL: z.url().optional(),
  /** Cloud API default throughput per number. Config, since Meta raises it for some numbers. */
  OUTBOUND_MPS_PER_NUMBER: z.coerce.number().int().positive().default(80),
  /** Lower than the line above, so inbox replies always find room on a busy number. */
  CAMPAIGN_MPS_PER_NUMBER: z.coerce.number().int().positive().default(40),
  /** Failed out of attempted, above which a campaign pauses itself. */
  CAMPAIGN_MAX_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.2),
  /** Local testing only: lets webhooks reach private addresses. Refused in production. */
  WEBHOOK_ALLOW_PRIVATE_URLS: z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .default(false),

  /** AI (both API and worker). Unset: AI features are unavailable. `fake` is for local runs and tests. */
  AI_PROVIDER: z.enum(['anthropic', 'fake']).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Defaults to claude-opus-5-5. */
  AI_MODEL: z.string().optional(),
  /** Embeddings for the knowledge base: voyage, openai (any OpenAI-compatible endpoint) or fake. */
  AI_EMBEDDINGS_PROVIDER: z.enum(['voyage', 'openai', 'fake']).optional(),
  AI_EMBEDDINGS_MODEL: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.url().optional(),
  /** The API as providers reach it, for webhook addresses registered by connectors. Same value as the API. */
  API_PUBLIC_URL: z.url().default('http://localhost:4000'),
  /** Registers the Demo Store connector, for trying integrations locally. Same value as the API. */
  INTEGRATIONS_DEMO: z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .default(false),
  /** The worker asks providers for current subscription state. Same values as the API. */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_API_BASE: z.url().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_API_BASE: z.url().optional(),
  WALLET_DEFAULT_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('INR'),
  ...s3EnvShape,
  /** How often recent hours of report data are recomputed. Lower only for local tests. */
  ANALYTICS_ROLLUP_EVERY_MS: z.coerce.number().int().min(1000).default(300_000),
  /** Scheduled report emails. Same values as the API. */
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).default('smtp://127.0.0.1:1025'),
  MAIL_FROM: z.string().default('WhatsApp CRM <no-reply@localhost>'),
  WEB_URL: z.url().default('http://localhost:3000'),
  /** Raw webhook payloads are kept this long for replay. */
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const loadWorkerEnv = (source?: Record<string, string | undefined>): WorkerEnv =>
  parseEnv(workerEnvSchema, source);
