import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { AppErrorFilter } from './common/app-error.filter';
import { DbModule } from './db/db.module';
import { API_ENV, type ApiEnv, loadApiEnv } from './env';
import { HealthController } from './health.controller';
import { InboxModule } from './inbox/inbox.module';
import { InfraModule } from './infra/infra.module';
import { OrgsModule } from './orgs/orgs.module';
import { RealtimeModule } from './realtime/realtime.module';
import { TeamModule } from './team/team.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

@Module({})
export class AppModule {
  /** `env` is injectable for tests; production loads and validates process.env. */
  static forRoot(env: ApiEnv = loadApiEnv()): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        DbModule,
        InfraModule,
        TenancyModule,
        AuthModule,
        TeamModule,
        OrgsModule,
        WhatsAppModule,
        RealtimeModule,
        InboxModule,
      ],
      controllers: [HealthController],
      providers: [
        { provide: API_ENV, useValue: env },
        { provide: APP_FILTER, useClass: AppErrorFilter },
      ],
      exports: [API_ENV],
    };
  }
}
