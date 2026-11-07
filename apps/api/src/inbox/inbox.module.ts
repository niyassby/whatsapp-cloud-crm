import { Module } from '@nestjs/common';
import { TemplatesModule } from '../templates/templates.module';
import { WalletModule } from '../wallet/wallet.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

@Module({
  imports: [WhatsAppModule, TemplatesModule, WalletModule],
  controllers: [InboxController],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
