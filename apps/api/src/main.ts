import 'reflect-metadata';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { loadApiEnv } from './env';

// Local dev convenience: load the repo-root .env. Production injects real env vars.
const rootEnv = path.resolve(__dirname, '../../../.env');
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function bootstrap() {
  const env = loadApiEnv();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(env),
    new FastifyAdapter({ logger: { level: env.LOG_LEVEL } }),
  );
  app.enableCors({ origin: env.WEB_URL, credentials: true });
  app.enableShutdownHooks();
  await app.listen(env.API_PORT, '0.0.0.0');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
