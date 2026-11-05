import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { MAX_UPLOAD_BYTES } from '@wacrm/shared';
import type { ApiEnv } from './env';
import { RealtimeIoAdapter } from './realtime/realtime.adapter';

/** Methods the web app uses. @fastify/cors defaults to GET,HEAD,POST only. */
export const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Webhook signatures are computed over the exact bytes, so keep them. */
export const NEST_OPTIONS = { rawBody: true } as const;

export function createAdapter(env: ApiEnv): FastifyAdapter {
  return new FastifyAdapter({
    logger: {
      level: env.LOG_LEVEL,
      // Never log credentials.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    trustProxy: env.TRUST_PROXY,
    // Meta batches webhook deliveries; the default 1 MiB can be too small.
    bodyLimit: 5 * 1024 * 1024,
  });
}

/** Shared by main.ts and integration tests so both run the same HTTP stack. */
export async function configureApp(app: NestFastifyApplication, env: ApiEnv): Promise<void> {
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  app.useWebSocketAdapter(new RealtimeIoAdapter(app, env));
  app.enableCors({
    origin: new URL(env.WEB_URL).origin,
    credentials: true,
    methods: CORS_METHODS,
    allowedHeaders: ['authorization', 'content-type'],
    maxAge: 600,
  });
  app.enableShutdownHooks();
}
