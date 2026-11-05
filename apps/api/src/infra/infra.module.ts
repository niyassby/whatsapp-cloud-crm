import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { S3Storage, s3ConfigFromEnv, SecretBox } from '@wacrm/shared/server';
import { Redis } from 'ioredis';
import { API_ENV, type ApiEnv } from '../env';
import { OBJECT_STORAGE, REDIS } from './infra.tokens';
import { MAILER, SmtpMailer } from './mailer';
import { QueuesService } from './queues.service';
import { RateLimiter } from './rate-limiter.service';

@Injectable()
class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onModuleDestroy() {
    await this.redis.quit();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) =>
        new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false }),
    },
    RedisLifecycle,
    {
      provide: SecretBox,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => new SecretBox(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS),
    },
    { provide: MAILER, inject: [API_ENV], useFactory: (env: ApiEnv) => new SmtpMailer(env) },
    RateLimiter,
    QueuesService,
    {
      provide: OBJECT_STORAGE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => new S3Storage(s3ConfigFromEnv(env)),
    },
  ],
  exports: [REDIS, SecretBox, MAILER, RateLimiter, QueuesService, OBJECT_STORAGE],
})
export class InfraModule {}

export { REDIS };
