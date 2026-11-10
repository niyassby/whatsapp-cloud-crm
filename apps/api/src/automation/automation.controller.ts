import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  AppError,
  type AssignmentRuleDto,
  type AssignmentRuleParsed,
  assignmentRuleSchema,
  type AutomationSettingsDto,
  type AutomationSettingsInput,
  automationSettingsSchema,
  type AutoReplyRuleDto,
  type AutoReplyRuleParsed,
  autoReplyRuleSchema,
  type CursorPage,
  ErrorCode,
  type ListNotificationsQuery,
  listNotificationsSchema,
  type MarkNotificationsReadInput,
  markNotificationsReadSchema,
  type NotificationDto,
  Permission,
  setAvailabilitySchema,
  setSkillsSchema,
} from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { requestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { type AutomationActor, AutomationService } from './automation.service';

function actor(auth: AuthContext, req?: FastifyRequest): AutomationActor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, meta: req ? requestMeta(req) : undefined };
}

@Controller('automation')
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get('settings')
  @RequirePermission(Permission.AUTOMATION_MANAGE)
  settings(@CurrentAuth() auth: AuthContext): Promise<AutomationSettingsDto> {
    return this.automation.getSettings(actor(auth));
  }

  @Put('settings')
  @RequirePermission(Permission.AUTOMATION_MANAGE)
  saveSettings(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(automationSettingsSchema)) body: AutomationSettingsInput,
  ): Promise<AutomationSettingsDto> {
    return this.automation.saveSettings(actor(auth, req), body);
  }

  @Get('auto-replies')
  @RequirePermission(Permission.AUTOMATION_MANAGE)
  autoReplies(): Promise<AutoReplyRuleDto[]> {
    return this.automation.listAutoReplies();
  }

  @Post('auto-replies')
  @RequirePermission(Permission.AUTOMATION_MANAGE)
  createAutoReply(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(autoReplyRuleSchema)) body: AutoReplyRuleParsed,
  ): Promise<AutoReplyRuleDto> {
    return this.automation.createAutoReply(actor(auth, req), body);
  }

  @Put('auto-replies/:id')
  @RequirePermission(Permission.AUTOMATION_MANAGE)
  updateAutoReply(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(autoReplyRuleSchema)) body: AutoReplyRuleParsed,
  ): Promise<AutoReplyRuleDto> {
    return this.automation.updateAutoReply(actor(auth, req), id, body);
  }

  @Delete('auto-replies/:id')
  @HttpCode(204)
  @RequirePermission(Permission.AUTOMATION_MANAGE)
  async deleteAutoReply(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.automation.deleteAutoReply(actor(auth, req), id);
  }

  @Get('assignment-rules')
  @RequirePermission(Permission.AUTOMATION_MANAGE)
  assignmentRules(): Promise<AssignmentRuleDto[]> {
    return this.automation.listAssignmentRules();
  }

  @Post('assignment-rules')
  @RequirePermission(Permission.AUTOMATION_MANAGE)
  createAssignmentRule(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(assignmentRuleSchema)) body: AssignmentRuleParsed,
  ): Promise<AssignmentRuleDto> {
    return this.automation.createAssignmentRule(actor(auth, req), body);
  }

  @Put('assignment-rules/:id')
  @RequirePermission(Permission.AUTOMATION_MANAGE)
  updateAssignmentRule(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(assignmentRuleSchema)) body: AssignmentRuleParsed,
  ): Promise<AssignmentRuleDto> {
    return this.automation.updateAssignmentRule(actor(auth, req), id, body);
  }

  @Delete('assignment-rules/:id')
  @HttpCode(204)
  @RequirePermission(Permission.AUTOMATION_MANAGE)
  async deleteAssignmentRule(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.automation.deleteAssignmentRule(actor(auth, req), id);
  }

  /** Anyone who answers customers can say whether they are taking new conversations. */
  @Patch('me/availability')
  @RequirePermission(Permission.INBOX_REPLY)
  availability(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(setAvailabilitySchema)) body: z.infer<typeof setAvailabilitySchema>,
  ): Promise<{ available: boolean }> {
    return this.automation.setAvailability(actor(auth), body.available);
  }

  @Put('members/:id/skills')
  @RequirePermission(Permission.AUTOMATION_MANAGE)
  skills(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(setSkillsSchema)) body: z.infer<typeof setSkillsSchema>,
  ): Promise<{ skills: string[] }> {
    return this.automation.setSkills(actor(auth, req), id, body.skills);
  }
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly automation: AutomationService) {}

  /** Everyone sees their own, so no permission beyond being a member. */
  @Get()
  list(
    @Query(zod(listNotificationsSchema)) q: ListNotificationsQuery,
  ): Promise<CursorPage<NotificationDto> & { unread: number }> {
    return this.automation.listNotifications(q);
  }

  @Post('read')
  @HttpCode(200)
  read(
    @Body(zod(markNotificationsReadSchema)) body: MarkNotificationsReadInput,
  ): Promise<{ marked: number }> {
    return this.automation.markRead(body);
  }
}
