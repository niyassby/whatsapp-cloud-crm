import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { Logger } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { baseSecurityHeaders, ErrorCode, MAX_UPLOAD_BYTES } from '@wacrm/shared';
import { createMetricsRegistry, httpMetrics, metricsAllowed } from '@wacrm/shared/server';
import type { ApiEnv } from './env';
import { RateLimiter } from './infra/rate-limiter.service';
import { setupOpenApi } from './public-api/openapi';
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
  setupOpenApi(app);
  addMetrics(app, env);
  addSecurityHooks(app, env);
}

/** Paths with their own limits, or that providers must always reach. */
const UNLIMITED_PREFIXES = [
  '/health',
  '/metrics',
  '/webhooks/',
  '/integrations/hooks/',
  '/integrations/apps/',
  '/meta/',
  '/v1/',
  '/webchat/',
  '/socket.io',
];

/**
 * Phase 4.5: Prometheus metrics at `GET /metrics`, outside Nest's guards. Every answered request is
 * counted by its route template, so a URL full of ids cannot create new series.
 */
function addMetrics(app: NestFastifyApplication, env: ApiEnv): void {
  const fastify = app.getHttpAdapter().getInstance();
  const registry = createMetricsRegistry('api');
  const http = httpMetrics(registry);
  const production = env.NODE_ENV === 'production';

  fastify.addHook('onResponse', async (request, reply) => {
    if (request.url === '/metrics') return;
    http.observe(
      request.method,
      request.routeOptions.url,
      reply.statusCode,
      reply.elapsedTime / 1000,
    );
  });

  fastify.get('/metrics', async (request, reply) => {
    if (!metricsAllowed(request.headers.authorization, env.METRICS_TOKEN, production)) {
      return reply.code(404).send({ code: ErrorCode.NOT_FOUND, message: 'Not found' });
    }
    return reply
      .header('content-type', registry.contentType)
      .header('cache-control', 'no-store')
      .send(await registry.metrics());
  });
}

/**
 * Phase 4.4: security headers on every response, and a per-address request limit ahead of
 * everything else. The limit fails open: a Redis outage must not take the API down with it.
 */
function addSecurityHooks(app: NestFastifyApplication, env: ApiEnv): void {
  const fastify = app.getHttpAdapter().getInstance();
  const base = baseSecurityHeaders({ production: env.NODE_ENV === 'production' });
  const limiter = app.get(RateLimiter);
  const log = new Logger('RateLimit');

  fastify.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(base)) void reply.header(name, value);
    // The API serves JSON, files and one script; none of it is a page to frame or run inline.
    // The OpenAPI viewer is the exception, and gets a policy it can work with.
    const docs = request.url.startsWith('/v1/docs');
    void reply.header(
      'Content-Security-Policy',
      docs
        ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
        : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    void reply.header('X-Frame-Options', 'DENY');
    // Responses carry tenant data; no shared cache may keep them.
    if (!reply.hasHeader('cache-control')) void reply.header('Cache-Control', 'no-store');
    return payload;
  });

  fastify.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    if (UNLIMITED_PREFIXES.some((p) => request.url.startsWith(p))) return;
    const minute = Math.floor(Date.now() / 60_000);
    let count: number;
    try {
      count = await limiter.hit(`rl:ip:${request.ip}:${minute}`, 60);
    } catch (err) {
      log.warn(`rate limit unavailable, letting the request through: ${String(err)}`);
      return;
    }
    if (count > env.RATE_LIMIT_IP_PER_MINUTE) {
      const retryAfter = 60 - Math.floor((Date.now() / 1000) % 60);
      return reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send({
          code: ErrorCode.RATE_LIMITED,
          message: 'Too many requests. Try again in a minute.',
          details: { retryAfterSeconds: retryAfter },
        });
    }
  });
}
