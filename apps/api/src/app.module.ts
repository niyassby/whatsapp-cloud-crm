import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { FlowsModule } from './flows/flows.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { AiModule } from './ai/ai.module';
import { ResellerModule } from './reseller/reseller.module';
import { ChannelsModule } from './channels/channels.module';
import { WaModulesModule } from './wa-modules/wa-modules.module';
import { AutomationModule } from './automation/automation.module';
import { BillingModule } from './billing/billing.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { AppErrorFilter } from './common/app-error.filter';
import { ContactsModule } from './contacts/contacts.module';
import { DbModule } from './db/db.module';
import { DeveloperModule } from './developer/developer.module';
import { API_ENV, type ApiEnv, loadApiEnv } from './env';
import { HealthController } from './health.controller';
import { InboxModule } from './inbox/inbox.module';
import { InfraModule } from './infra/infra.module';
import { OrgsModule } from './orgs/orgs.module';
import { PublicApiModule } from './public-api/public-api.module';
import { RealtimeModule } from './realtime/realtime.module';
import { TeamModule } from './team/team.module';
import { TemplatesModule } from './templates/templates.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { WalletModule } from './wallet/wallet.module';
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
        ContactsModule,
        TemplatesModule,
        WalletModule,
        CampaignsModule,
        BillingModule,
        PublicApiModule,
        DeveloperModule,
        AutomationModule,
        FlowsModule,
        IntegrationsModule,
        AiModule,
        ResellerModule,
        ChannelsModule,
        WaModulesModule,
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
