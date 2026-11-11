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
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AppError,
  createCampaignSchema,
  type CreateCampaignParsed,
  createContactSchema,
  createTagSchema,
  ErrorCode,
  launchCampaignSchema,
  type LaunchCampaignInput,
  listCampaignsSchema,
  type ListCampaignsQuery,
  listTemplatesSchema,
  type ListTemplatesQuery,
  publicCampaignReportSchema,
  publicHookEventSchema,
  publicHookSampleParamsSchema,
  publicHookSchema,
  publicHookSubscribeSchema,
  type PublicHookSubscribeParsed,
  publicCampaignSchema,
  publicContactSchema,
  publicConversationSchema,
  publicListContactsSchema,
  publicListConversationsSchema,
  type PublicListConversationsQuery,
  publicListMessagesSchema,
  type PublicListMessagesQuery,
  publicMessageSchema,
  publicPage,
  publicSendMessageSchema,
  type PublicSendMessageParsed,
  publicTagSchema,
  publicTemplateSchema,
  type SetConsentInput,
  setConsentSchema,
  type SetContactTagsInput,
  setContactTagsSchema,
  toPublicCampaign,
  toPublicCampaignCounts,
  toPublicContact,
  toPublicConversation,
  toPublicMessage,
  toPublicTemplate,
  type UpdateContactInput,
  updateContactSchema,
} from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiKeyRoute, CurrentAuth, RequireFeature } from '../auth/decorators';
import { CampaignsService } from '../campaigns/campaigns.service';
import { requestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import { ContactsService } from '../contacts/contacts.service';
import { DeveloperService } from '../developer/developer.service';
import { InboxService } from '../inbox/inbox.service';
import type { AuthContext } from '../tenancy/request-context';
import { TemplatesService } from '../templates/templates.service';
import { Documented } from './openapi';
import { PublicApiService } from './public-api.service';

function actor(auth: AuthContext, req: FastifyRequest) {
  if (!auth.orgId || !auth.role) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return {
    userId: auth.userId,
    orgId: auth.orgId,
    role: auth.role,
    // Sent by software, so not counted as a person answering a customer.
    automated: true,
    meta: requestMeta(req),
  };
}

const idParam = z.object({ id: z.uuid() });

@ApiTags('Contacts')
@ApiBearerAuth()
@Controller('v1/contacts')
export class PublicContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @ApiKeyRoute('contacts:read')
  @ApiOperation({ summary: 'List contacts' })
  @Documented({ query: publicListContactsSchema, response: publicPage(publicContactSchema) })
  async list(@Query(zod(publicListContactsSchema)) q: z.infer<typeof publicListContactsSchema>) {
    const page = await this.contacts.list(q);
    return { items: page.items.map(toPublicContact), nextCursor: page.nextCursor };
  }

  @Post()
  @ApiKeyRoute('contacts:write')
  @ApiOperation({ summary: 'Create a contact' })
  @Documented({ body: createContactSchema, response: publicContactSchema, status: 201 })
  async create(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(createContactSchema)) body: z.infer<typeof createContactSchema>,
  ) {
    return toPublicContact(await this.contacts.create(actor(auth, req), body));
  }

  @Get(':id')
  @ApiKeyRoute('contacts:read')
  @ApiOperation({ summary: 'Get a contact' })
  @Documented({ params: idParam, response: publicContactSchema })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return toPublicContact(await this.contacts.get(id));
  }

  @Patch(':id')
  @ApiKeyRoute('contacts:write')
  @ApiOperation({ summary: 'Change a contact' })
  @Documented({ params: idParam, body: updateContactSchema, response: publicContactSchema })
  async update(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateContactSchema)) body: UpdateContactInput,
  ) {
    return toPublicContact(await this.contacts.update(actor(auth, req), id, body));
  }

  @Post(':id/consent')
  @HttpCode(200)
  @ApiKeyRoute('contacts:write')
  @ApiOperation({
    summary: 'Record marketing consent',
    description: 'Opting in needs a source and proof, which are kept as the record of consent.',
  })
  @Documented({ params: idParam, body: setConsentSchema, response: publicContactSchema })
  async consent(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(setConsentSchema)) body: SetConsentInput,
  ) {
    return toPublicContact(await this.contacts.setConsent(actor(auth, req), id, body));
  }

  @Post(':id/tags')
  @HttpCode(200)
  @ApiKeyRoute('contacts:write')
  @ApiOperation({ summary: 'Set a contact’s tags', description: 'Replaces the existing tags.' })
  @Documented({ params: idParam, body: setContactTagsSchema, response: publicContactSchema })
  async setTags(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(setContactTagsSchema)) body: SetContactTagsInput,
  ) {
    return toPublicContact(await this.contacts.setTags(actor(auth, req), id, body.tagIds));
  }
}

@ApiTags('Tags')
@ApiBearerAuth()
@Controller('v1/tags')
export class PublicTagsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @ApiKeyRoute('tags:read')
  @ApiOperation({ summary: 'List tags' })
  @Documented({ response: z.array(publicTagSchema) })
  list() {
    return this.contacts.listTags();
  }

  @Post()
  @ApiKeyRoute('tags:write')
  @ApiOperation({ summary: 'Create a tag' })
  @Documented({ body: createTagSchema, response: publicTagSchema, status: 201 })
  create(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(createTagSchema)) body: z.infer<typeof createTagSchema>,
  ) {
    return this.contacts.createTag(actor(auth, req), body);
  }
}

@ApiTags('Conversations')
@ApiBearerAuth()
@Controller('v1/conversations')
export class PublicConversationsController {
  constructor(
    private readonly api: PublicApiService,
    private readonly inbox: InboxService,
  ) {}

  @Get()
  @ApiKeyRoute('conversations:read')
  @ApiOperation({ summary: 'List conversations' })
  @Documented({
    query: publicListConversationsSchema,
    response: publicPage(publicConversationSchema),
  })
  async list(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Query(zod(publicListConversationsSchema)) q: PublicListConversationsQuery,
  ) {
    const page = await this.api.listConversations(actor(auth, req), q);
    return { items: page.items.map(toPublicConversation), nextCursor: page.nextCursor };
  }

  @Get(':id')
  @ApiKeyRoute('conversations:read')
  @ApiOperation({ summary: 'Get a conversation' })
  @Documented({ params: idParam, response: publicConversationSchema })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return toPublicConversation(await this.api.getConversation(id));
  }

  @Get(':id/messages')
  @ApiKeyRoute('conversations:read')
  @ApiOperation({ summary: 'List a conversation’s messages, newest first' })
  @Documented({
    params: idParam,
    query: publicListMessagesSchema,
    response: publicPage(publicMessageSchema),
  })
  async messages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zod(publicListMessagesSchema)) q: PublicListMessagesQuery,
  ) {
    const page = await this.inbox.listMessages(id, q);
    return {
      // Internal notes are for the team, and never leave through the API.
      items: page.items.filter((m) => m.direction !== 'internal').map(toPublicMessage),
      nextCursor: page.nextCursor,
    };
  }
}

@ApiTags('Messages')
@ApiBearerAuth()
@Controller('v1/messages')
export class PublicMessagesController {
  constructor(private readonly api: PublicApiService) {}

  @Post()
  @ApiKeyRoute('messages:send')
  @ApiOperation({
    summary: 'Send a message',
    description:
      'Queues a message and answers straight away. Status changes arrive as message.status webhooks. ' +
      'Text needs an open 24-hour window, marketing templates need recorded consent, and paid ' +
      'sends need wallet balance.',
  })
  @Documented({ body: publicSendMessageSchema, response: publicMessageSchema, status: 201 })
  async send(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(publicSendMessageSchema)) body: PublicSendMessageParsed,
  ) {
    return toPublicMessage(await this.api.send(actor(auth, req), body));
  }
}

@ApiTags('Templates')
@ApiBearerAuth()
@Controller('v1/templates')
export class PublicTemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @ApiKeyRoute('templates:read')
  @ApiOperation({ summary: 'List templates' })
  @Documented({ query: listTemplatesSchema, response: publicPage(publicTemplateSchema) })
  async list(@Query(zod(listTemplatesSchema)) q: ListTemplatesQuery) {
    const page = await this.templates.list(q);
    return { items: page.items.map(toPublicTemplate), nextCursor: page.nextCursor };
  }

  @Get(':id')
  @ApiKeyRoute('templates:read')
  @ApiOperation({ summary: 'Get a template' })
  @Documented({ params: idParam, response: publicTemplateSchema })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return toPublicTemplate(await this.templates.get(id));
  }
}

@ApiTags('Campaigns')
@ApiBearerAuth()
@Controller('v1/campaigns')
export class PublicCampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  private async report(auth: AuthContext, req: FastifyRequest, id: string) {
    const r = await this.campaigns.report(actor(auth, req), id);
    return {
      ...toPublicCampaign(r.campaign),
      counts: toPublicCampaignCounts(r.counts),
      costMicros: r.costMicros,
      currency: r.currency,
    };
  }

  @Get()
  @ApiKeyRoute('campaigns:read')
  @ApiOperation({ summary: 'List campaigns' })
  @Documented({ query: listCampaignsSchema, response: publicPage(publicCampaignSchema) })
  async list(@Query(zod(listCampaignsSchema)) q: ListCampaignsQuery) {
    const page = await this.campaigns.list(q);
    return { items: page.items.map(toPublicCampaign), nextCursor: page.nextCursor };
  }

  @Post()
  @RequireFeature('campaigns')
  @ApiKeyRoute('campaigns:write')
  @ApiOperation({ summary: 'Create a campaign draft' })
  @Documented({ body: createCampaignSchema, response: publicCampaignSchema, status: 201 })
  async create(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(createCampaignSchema)) body: CreateCampaignParsed,
  ) {
    return toPublicCampaign(await this.campaigns.create(actor(auth, req), body));
  }

  @Get(':id')
  @ApiKeyRoute('campaigns:read')
  @ApiOperation({ summary: 'Get a campaign and its report' })
  @Documented({ params: idParam, response: publicCampaignReportSchema })
  get(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.report(auth, req, id);
  }

  @Post(':id/launch')
  @HttpCode(200)
  @RequireFeature('campaigns')
  @ApiKeyRoute('campaigns:write')
  @ApiOperation({ summary: 'Start a draft now, or schedule it' })
  @Documented({ params: idParam, body: launchCampaignSchema, response: publicCampaignSchema })
  async launch(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(launchCampaignSchema)) body: LaunchCampaignInput,
  ) {
    return toPublicCampaign(await this.campaigns.launch(actor(auth, req), id, body));
  }

  @Post(':id/pause')
  @HttpCode(200)
  @ApiKeyRoute('campaigns:write')
  @ApiOperation({ summary: 'Pause a running campaign' })
  @Documented({ params: idParam, response: publicCampaignSchema })
  async pause(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return toPublicCampaign(await this.campaigns.pause(actor(auth, req), id));
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequireFeature('campaigns')
  @ApiKeyRoute('campaigns:write')
  @ApiOperation({ summary: 'Resume a paused campaign' })
  @Documented({ params: idParam, response: publicCampaignSchema })
  async resume(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return toPublicCampaign(await this.campaigns.resume(actor(auth, req), id));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiKeyRoute('campaigns:write')
  @ApiOperation({ summary: 'Cancel a campaign and return the money held for it' })
  @Documented({ params: idParam, response: publicCampaignSchema })
  async cancel(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return toPublicCampaign(await this.campaigns.cancel(actor(auth, req), id));
  }
}

@ApiTags('Hooks')
@ApiBearerAuth()
@Controller('v1/hooks')
export class PublicHooksController {
  constructor(private readonly developer: DeveloperService) {}

  @Get()
  @ApiKeyRoute('hooks:manage')
  @ApiOperation({
    summary: 'List subscriptions',
    description: 'Subscriptions made through the API. Also a cheap way to test a key.',
  })
  @Documented({ response: z.array(publicHookSchema) })
  list() {
    return this.developer.listHooks();
  }

  @Post()
  @ApiKeyRoute('hooks:manage')
  @ApiOperation({
    summary: 'Subscribe to an event',
    description:
      'For Zapier, Make and similar REST hooks: each event of this type is POSTed to the URL, with ' +
      'the same body, retries and X-Wacrm-Signature as dashboard webhooks. The subscription ' +
      'lasts as long as the key; revoking the key removes it.',
  })
  @Documented({ body: publicHookSubscribeSchema, response: publicHookSchema, status: 201 })
  subscribe(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(publicHookSubscribeSchema)) body: PublicHookSubscribeParsed,
  ) {
    return this.developer.subscribeHook(hookActor(auth, req), body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiKeyRoute('hooks:manage')
  @ApiOperation({ summary: 'Unsubscribe', description: 'When a Zap or scenario is turned off.' })
  @Documented({ params: idParam, response: z.null(), status: 204 })
  async unsubscribe(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.developer.unsubscribeHook(hookActor(auth, req), id);
  }

  @Get('samples/:event')
  @ApiKeyRoute('hooks:manage')
  @ApiOperation({
    summary: 'Sample events',
    description:
      'Up to three recent events of this type, newest first, or a documented sample when there ' +
      'are none yet. Integration platforms use it to map fields and as a polling fallback.',
  })
  @Documented({ params: publicHookSampleParamsSchema, response: z.array(publicHookEventSchema) })
  samples(
    @Param(zod(publicHookSampleParamsSchema)) params: z.infer<typeof publicHookSampleParamsSchema>,
  ) {
    return this.developer.hookSamples(params.event);
  }
}

function hookActor(auth: AuthContext, req: FastifyRequest) {
  const { userId, orgId } = actor(auth, req);
  if (!auth.apiKeyId) throw new AppError(ErrorCode.UNAUTHENTICATED, 'An API key is required');
  return { userId, orgId, apiKeyId: auth.apiKeyId, meta: requestMeta(req) };
}
