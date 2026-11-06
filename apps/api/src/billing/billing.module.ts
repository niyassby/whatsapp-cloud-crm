import { Module } from '@nestjs/common';
import { createPaymentProviders } from '@wacrm/billing';
import { API_ENV, type ApiEnv } from '../env';
import { WalletModule } from '../wallet/wallet.module';
import { BillingWebhooksController } from './billing-webhooks.controller';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PAYMENT_PROVIDERS } from './billing.tokens';

@Module({
  imports: [WalletModule],
  controllers: [BillingController, BillingWebhooksController],
  providers: [
    BillingService,
    {
      provide: PAYMENT_PROVIDERS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createPaymentProviders(env),
    },
  ],
})
export class BillingModule {}
