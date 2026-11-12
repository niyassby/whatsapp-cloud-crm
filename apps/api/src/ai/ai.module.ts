import { Module } from '@nestjs/common';
import { createAiProviders } from '@wacrm/ai';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AI_PROVIDERS } from './ai.tokens';

/** Settings, knowledge base and inbox help. Indexing and the flow AI step run in the worker. */
@Module({
  controllers: [AiController],
  providers: [
    AiService,
    { provide: AI_PROVIDERS, useFactory: () => createAiProviders(process.env) },
  ],
})
export class AiModule {}
