import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppErrorFilter } from './common/app-error.filter';
import { DbModule } from './db/db.module';
import { API_ENV, type ApiEnv, loadApiEnv } from './env';
import { HealthController } from './health.controller';
import { TenancyModule } from './tenancy/tenancy.module';

@Module({})
export class AppModule {
  /** `env` is injectable for tests; production loads and validates process.env. */
  static forRoot(env: ApiEnv = loadApiEnv()): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DbModule, TenancyModule],
      controllers: [HealthController],
      providers: [
        { provide: API_ENV, useValue: env },
        { provide: APP_FILTER, useClass: AppErrorFilter },
      ],
      exports: [API_ENV],
    };
  }
}
