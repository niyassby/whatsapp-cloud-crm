import fastifyCookie from '@fastify/cookie';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ApiEnv } from './env';

/** Methods the web app uses. @fastify/cors defaults to GET,HEAD,POST only. */
export const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Shared by main.ts and integration tests so both run the same HTTP stack. */
export async function configureApp(app: NestFastifyApplication, env: ApiEnv): Promise<void> {
  await app.register(fastifyCookie);
  app.enableCors({
    origin: new URL(env.WEB_URL).origin,
    credentials: true,
    methods: CORS_METHODS,
    allowedHeaders: ['authorization', 'content-type'],
    maxAge: 600,
  });
  app.enableShutdownHooks();
}
