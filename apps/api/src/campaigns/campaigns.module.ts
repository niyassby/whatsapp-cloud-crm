import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController, CampaignsController, DripsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { DripsService } from './drips.service';

@Module({
  imports: [WhatsAppModule, WalletModule],
  controllers: [CampaignsController, DripsController, AnalyticsController],
  providers: [CampaignsService, DripsService, AnalyticsService],
})
export class CampaignsModule {}
