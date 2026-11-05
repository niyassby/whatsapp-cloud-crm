import { Module } from '@nestjs/common';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

@Module({
  imports: [WhatsAppModule],
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
