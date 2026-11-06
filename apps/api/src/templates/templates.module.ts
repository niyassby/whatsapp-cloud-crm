import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  imports: [WhatsAppModule, WalletModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
