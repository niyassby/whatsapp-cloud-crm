import { z } from 'zod';
import { logLevelSchema, nodeEnvSchema, parseEnv } from '@wacrm/shared';
import { s3EnvShape } from '@wacrm/shared/server';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const base64Key = z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
  message: 'must be 32 bytes, base64 encoded (openssl rand -base64 32)',
});

export const apiEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  APP_NAME: z.string().default('WhatsApp CRM'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_URL: z.url().default('http://localhost:3000'),
  /** Set when running behind a load balancer so request.ip is the client address. */
  TRUST_PROXY: booleanString.default(false),

  /** Non-owner app role (member of app_user) so Postgres RLS applies. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://127.0.0.1:6379'),

  JWT_ACCESS_SECRET: z.string().min(32),
  /** Also the HMAC pepper for every stored opaque token (refresh, email links, invites). */
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Defaults to true in production. */
  COOKIE_SECURE: booleanString.optional(),

  ENCRYPTION_KEY: base64Key,
  /** Comma-separated previous keys, accepted for decryption during rotation. */
  ENCRYPTION_KEY_PREVIOUS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    )
    .pipe(z.array(base64Key)),

  /** Optional until a number is connected; required when NODE_ENV=production. */
  META_APP_ID: z.string().min(1).optional(),
  META_APP_SECRET: z.string().min(1).optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1).optional(),
  /** Facebook Login for Business configuration used by Embedded Signup. */
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().min(1).optional(),
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v25.0'),
  /** Point Graph calls at a local fake for end-to-end checks. Refused in production. */
  META_GRAPH_BASE_URL: z.url().optional(),
  /** System-user-token connect form. Defaults to on outside production, off in production. */
  ALLOW_MANUAL_CONNECT: booleanString.optional(),
  QUEUE_PREFIX: z.string().min(1).default('wacrm'),
  ...s3EnvShape,

  SMTP_URL: z.url({ protocol: /^smtps?$/ }).default('smtp://127.0.0.1:1025'),
  MAIL_FROM: z.string().default('WhatsApp CRM <no-reply@localhost>'),
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

const DEV_ENCRYPTION_KEY = 'ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzJieXRlcyE=';

export const loadApiEnv = (source?: Record<string, string | undefined>): ApiEnv => {
  const env = parseEnv(apiEnvSchema, source);
  if (env.NODE_ENV === 'production') {
    const devValues = [
      env.JWT_ACCESS_SECRET.includes('dev-only') && 'JWT_ACCESS_SECRET',
      env.JWT_REFRESH_SECRET.includes('dev-only') && 'JWT_REFRESH_SECRET',
      env.ENCRYPTION_KEY === DEV_ENCRYPTION_KEY && 'ENCRYPTION_KEY',
    ].filter(Boolean);
    if (env.META_GRAPH_BASE_URL) {
      throw new Error('META_GRAPH_BASE_URL must not be set in production');
    }
    const missing = ['META_APP_ID', 'META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN'].filter(
      (k) => !env[k as keyof ApiEnv],
    );
    if (missing.length > 0) {
      throw new Error(`Missing required production settings: ${missing.join(', ')}`);
    }
    if (devValues.length > 0) {
      throw new Error(
        `Refusing to start in production with dev-only values: ${devValues.join(', ')}`,
      );
    }
  }
  return env;
};

/** DI token for the validated env. */
export const API_ENV = Symbol('API_ENV');
