import { Module } from '@nestjs/common';
import { FlowsController } from './flows.controller';
import { FlowsService } from './flows.service';

/** Flow definitions, versions and run history. Runs themselves happen in the worker. */
@Module({
  controllers: [FlowsController],
  providers: [FlowsService],
})
export class FlowsModule {}
