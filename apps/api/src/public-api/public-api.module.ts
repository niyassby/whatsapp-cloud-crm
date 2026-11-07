import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { ContactsModule } from '../contacts/contacts.module';
import { InboxModule } from '../inbox/inbox.module';
import { TemplatesModule } from '../templates/templates.module';
import {
  PublicCampaignsController,
  PublicContactsController,
  PublicConversationsController,
  PublicMessagesController,
  PublicTagsController,
  PublicTemplatesController,
} from './public-api.controller';
import { PublicApiService } from './public-api.service';

/** REST /v1: thin controllers over the same services the dashboard uses. */
@Module({
  imports: [ContactsModule, InboxModule, TemplatesModule, CampaignsModule],
  controllers: [
    PublicContactsController,
    PublicTagsController,
    PublicConversationsController,
    PublicMessagesController,
    PublicTemplatesController,
    PublicCampaignsController,
  ],
  providers: [PublicApiService],
})
export class PublicApiModule {}
