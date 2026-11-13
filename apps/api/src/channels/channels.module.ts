import { Module } from '@nestjs/common';
import { InstagramClient } from '@wacrm/whatsapp';
import { API_ENV, type ApiEnv } from '../env';
import {
  ChannelsController,
  InstagramCallbackController,
  InstagramWebhooksController,
  WebchatController,
} from './channels.controller';
import { ChannelsService } from './channels.service';
import { INSTAGRAM } from './channels.tokens';
import { WebchatGateway } from './webchat.gateway';
import { WebchatService } from './webchat.service';

@Module({
  controllers: [
    ChannelsController,
    InstagramCallbackController,
    InstagramWebhooksController,
    WebchatController,
  ],
  providers: [
    {
      provide: INSTAGRAM,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) =>
        env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET
          ? new InstagramClient({
              appId: env.INSTAGRAM_APP_ID,
              appSecret: env.INSTAGRAM_APP_SECRET,
              apiVersion: env.META_GRAPH_API_VERSION,
              baseUrl: env.INSTAGRAM_BASE_URL,
            })
          : null,
    },
    ChannelsService,
    WebchatService,
    WebchatGateway,
  ],
  exports: [ChannelsService],
})
export class ChannelsModule {}
