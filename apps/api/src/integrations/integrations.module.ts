import { Module } from '@nestjs/common';
import { buildRegistry } from '@wacrm/connectors';
import { API_ENV, type ApiEnv } from '../env';
import { IntegrationsController, IntegrationsPublicController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { CONNECTORS, INTEGRATIONS_FETCH } from './integrations.tokens';

/** Connections, OAuth, webhooks and the event log. The work itself happens in the worker. */
@Module({
  controllers: [IntegrationsController, IntegrationsPublicController],
  providers: [
    IntegrationsService,
    {
      provide: CONNECTORS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => buildRegistry({ demo: env.INTEGRATIONS_DEMO }),
    },
    { provide: INTEGRATIONS_FETCH, useValue: globalThis.fetch },
  ],
  exports: [CONNECTORS],
})
export class IntegrationsModule {}
