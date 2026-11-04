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
  Res,
} from '@nestjs/common';
import {
  type AcceptInvitationInput,
  acceptInvitationSchema,
  type AuthTokensResponse,
  type CreateInvitationInput,
  createInvitationSchema,
  type InvitationDto,
  type InvitationPreviewDto,
  type MemberDto,
  Permission,
  type UpdateMemberRoleInput,
  updateMemberRoleSchema,
} from '@wacrm/shared';
import type { FastifyReply } from 'fastify';
import { SessionCookies } from '../auth/session-cookies';
import { CurrentAuth, OptionalAuth, Public, RequirePermission } from '../auth/decorators';
import { Meta, type RequestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { actorOf, TeamService } from './team.service';

@Controller('team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('members')
  @RequirePermission(Permission.TEAM_READ)
  listMembers(): Promise<MemberDto[]> {
    return this.team.listMembers();
  }

  @Patch('members/:id')
  @RequirePermission(Permission.TEAM_UPDATE_ROLE)
  changeRole(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateMemberRoleSchema)) body: UpdateMemberRoleInput,
    @Meta() meta: RequestMeta,
  ): Promise<MemberDto> {
    return this.team.changeRole(actorOf(auth), id, body.role, meta);
  }

  @Delete('members/:id')
  @HttpCode(204)
  @RequirePermission(Permission.TEAM_REMOVE)
  async removeMember(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.team.removeMember(actorOf(auth), id, meta);
  }

  @Get('invitations')
  @RequirePermission(Permission.TEAM_READ)
  listInvitations(): Promise<InvitationDto[]> {
    return this.team.listInvitations();
  }

  @Post('invitations')
  @RequirePermission(Permission.TEAM_INVITE)
  invite(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createInvitationSchema)) body: CreateInvitationInput,
    @Meta() meta: RequestMeta,
  ): Promise<InvitationDto> {
    return this.team.invite(actorOf(auth), body, meta);
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  @RequirePermission(Permission.TEAM_INVITE)
  async revokeInvitation(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.team.revokeInvitation(actorOf(auth), id, meta);
  }
}

/** Invitation links are opened before the invitee has an org (or an account). */
@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly team: TeamService,
    private readonly cookies: SessionCookies,
  ) {}

  @Public()
  @Post('preview')
  @HttpCode(200)
  preview(
    @Body(zod(acceptInvitationSchema.pick({ token: true }))) body: { token: string },
  ): Promise<InvitationPreviewDto> {
    return this.team.previewInvitation(body.token);
  }

  @Public({ optionalAuth: true })
  @Post('accept')
  @HttpCode(200)
  async accept(
    @OptionalAuth() auth: AuthContext | undefined,
    @Body(zod(acceptInvitationSchema)) body: AcceptInvitationInput,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthTokensResponse> {
    const result = await this.team.accept(body, auth, meta);
    return 'refreshToken' in result ? this.cookies.issue(reply, result) : result;
  }
}
