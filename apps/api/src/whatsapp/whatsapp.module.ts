import { Module } from '@nestjs/common';
import { withTenant } from '@wacrm/db';
import { AppError, ErrorCode } from '@wacrm/shared';
import { phoneTokenAad, SecretBox } from '@wacrm/shared/server';
import { type GraphConfig, WhatsAppClientFactory } from '@wacrm/whatsapp';
import { PrismaService } from '../db/prisma.service';
import { API_ENV, type ApiEnv } from '../env';
import { MetaCallbacksController, WebhooksController } from './webhooks.controller';
import { WebhookIngestService } from './webhook-ingest.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { GRAPH_CONFIG } from './whatsapp.tokens';

@Module({
  controllers: [WhatsAppController, WebhooksController, MetaCallbacksController],
  providers: [
    WhatsAppService,
    WebhookIngestService,
    {
      provide: GRAPH_CONFIG,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): GraphConfig => ({
        apiVersion: env.META_GRAPH_API_VERSION,
        baseUrl: env.META_GRAPH_BASE_URL,
        appId: env.META_APP_ID,
        appSecret: env.META_APP_SECRET,
      }),
    },
    {
      provide: WhatsAppClientFactory,
      inject: [GRAPH_CONFIG, PrismaService, SecretBox],
      useFactory: (graph: GraphConfig, prisma: PrismaService, secrets: SecretBox) =>
        new WhatsAppClientFactory({
          graph,
          // Runs under the org's RLS context, so another tenant's number is simply not found.
          loadCredentials: async ({ orgId, phoneNumberId }) => {
            const row = await withTenant(prisma.client, { orgId }, (tx) =>
              tx.phoneNumber.findFirst({
                where: { phoneNumberId, status: { not: 'disconnected' } },
                select: {
                  id: true,
                  accessTokenEnc: true,
                  wabaAccount: { select: { wabaId: true } },
                },
              }),
            );
            if (!row?.accessTokenEnc) {
              throw new AppError(ErrorCode.NOT_FOUND, 'Phone number is not connected');
            }
            return {
              accessToken: secrets.decrypt(row.accessTokenEnc, phoneTokenAad(row.id)),
              wabaId: row.wabaAccount.wabaId,
            };
          },
        }),
    },
  ],
  exports: [WhatsAppClientFactory],
})
export class WhatsAppModule {}
