import 'reflect-metadata';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { S3Storage } from '@wacrm/shared/server';
import { AppModule } from './app.module';
import { configureApp, createAdapter, NEST_OPTIONS } from './bootstrap';
import { loadApiEnv } from './env';
import { OBJECT_STORAGE } from './infra/infra.tokens';

// Local dev convenience: load the repo-root .env. Production injects real env vars.
const rootEnv = path.resolve(__dirname, '../../../.env');
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function bootstrap() {
  const env = loadApiEnv();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(env),
    createAdapter(env),
    NEST_OPTIONS,
  );
  await configureApp(app, env);
  if (env.NODE_ENV !== 'production') {
    // Local convenience; production buckets are provisioned separately.
    await (app.get(OBJECT_STORAGE) as S3Storage).ensureBucket().catch((err: unknown) => {
      new Logger('Bootstrap').warn(`could not create the media bucket: ${String(err)}`);
    });
  }
  await app.listen(env.API_PORT, '0.0.0.0');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
