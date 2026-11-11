import { Module } from '@nestjs/common';
import { ApiKeysController, WebhookEndpointsController } from './developer.controller';
import { DeveloperService } from './developer.service';

@Module({
  controllers: [ApiKeysController, WebhookEndpointsController],
  providers: [DeveloperService],
  exports: [DeveloperService],
})
export class DeveloperModule {}
