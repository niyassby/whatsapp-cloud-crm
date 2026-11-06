import { Module } from '@nestjs/common';
import { TemplatesModule } from '../templates/templates.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

@Module({
  imports: [WhatsAppModule, TemplatesModule],
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
