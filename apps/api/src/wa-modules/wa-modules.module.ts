import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import {
  CallsController,
  CatalogController,
  GroupsController,
  ProductsAndAdsController,
  QrCodesController,
} from './wa-modules.controller';
import { WaModulesService } from './wa-modules.service';

@Module({
  imports: [InboxModule, WhatsAppModule],
  controllers: [
    QrCodesController,
    CatalogController,
    GroupsController,
    CallsController,
    ProductsAndAdsController,
  ],
  providers: [WaModulesService],
})
export class WaModulesModule {}
