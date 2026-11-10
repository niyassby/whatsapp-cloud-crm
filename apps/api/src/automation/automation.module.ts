import { Module } from '@nestjs/common';
import { AutomationController, NotificationsController } from './automation.controller';
import { AutomationService } from './automation.service';

/** Settings for rules and routing. The rules themselves run in the worker. */
@Module({
  controllers: [AutomationController, NotificationsController],
  providers: [AutomationService],
})
export class AutomationModule {}
