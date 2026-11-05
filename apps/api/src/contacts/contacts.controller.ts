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
  type BulkContactsInput,
  bulkContactsSchema,
  type ConsentEventDto,
  type ContactConversationDto,
  type ContactDto,
  type ContactExportInput,
  contactExportSchema,
  type ContactFieldDto,
  contactImportOptionsSchema,
  type ContactJobDto,
  type ContactNoteDto,
  type CreateContactNoteInput,
  createContactFieldSchema,
  createContactNoteSchema,
  createContactSchema,
  createSegmentSchema,
  createTagSchema,
  type CursorPage,
  ErrorCode,
  hasPermission,
  type ListContactsQuery,
  listContactsSchema,
  MAX_CONTACT_IMPORT_BYTES,
  type MediaUrlDto,
  type MergeContactsInput,
  mergeContactsSchema,
  Permission,
  previewSegmentSchema,
  type SegmentDto,
  type SetConsentInput,
  setConsentSchema,
  type SetContactTagsInput,
  setContactTagsSchema,
  type TagDto,
  type UpdateContactInput,
  updateContactSchema,
  type UpdateOptOutKeywordsInput,
  updateOptOutKeywordsSchema,
  updateSegmentSchema,
} from '@wacrm/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { requestMeta } from '../common/request-meta';
import { zod } from '../common/zod.pipe';
import type { AuthContext } from '../tenancy/request-context';
import { ContactJobsService } from './contact-jobs.service';
import { type ContactActor, ContactsService } from './contacts.service';

function actor(auth: AuthContext, req?: FastifyRequest): ContactActor {
  if (!auth.orgId) {
    throw new AppError(ErrorCode.TENANT_CONTEXT_MISSING, 'An organization context is required');
  }
  return { userId: auth.userId, orgId: auth.orgId, meta: req ? requestMeta(req) : undefined };
}

const contactCountSchema = listContactsSchema.omit({ cursor: true, limit: true });

@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @RequirePermission(Permission.CONTACTS_READ)
  list(@Query(zod(listContactsSchema)) query: ListContactsQuery): Promise<CursorPage<ContactDto>> {
    return this.contacts.list(query);
  }

  @Get('count')
  @RequirePermission(Permission.CONTACTS_READ)
  count(
    @Query(zod(contactCountSchema)) query: z.infer<typeof contactCountSchema>,
  ): Promise<{ count: number }> {
    return this.contacts.count(query);
  }

  @Post()
  @RequirePermission(Permission.CONTACTS_WRITE)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createContactSchema)) body: z.infer<typeof createContactSchema>,
  ): Promise<ContactDto> {
    return this.contacts.create(actor(auth), body);
  }

  @Post('merge')
  @HttpCode(200)
  @RequirePermission(Permission.CONTACTS_MANAGE)
  merge(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(mergeContactsSchema)) body: MergeContactsInput,
  ): Promise<ContactDto> {
    return this.contacts.merge(actor(auth, req), body);
  }

  @Post('bulk')
  @HttpCode(200)
  @RequirePermission(Permission.CONTACTS_MANAGE)
  bulk(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(bulkContactsSchema)) body: BulkContactsInput,
  ): Promise<{ affected: number }> {
    return this.contacts.bulk(actor(auth, req), body);
  }

  @Get(':id')
  @RequirePermission(Permission.CONTACTS_READ)
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ContactDto> {
    return this.contacts.get(id);
  }

  @Patch(':id')
  @RequirePermission(Permission.CONTACTS_WRITE)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateContactSchema)) body: UpdateContactInput,
  ): Promise<ContactDto> {
    return this.contacts.update(actor(auth), id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.CONTACTS_MANAGE)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.contacts.remove(actor(auth, req), id);
  }

  @Put(':id/tags')
  @RequirePermission(Permission.CONTACTS_WRITE)
  setTags(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(setContactTagsSchema)) body: SetContactTagsInput,
  ): Promise<ContactDto> {
    return this.contacts.setTags(actor(auth), id, body.tagIds);
  }

  @Post(':id/consent')
  @HttpCode(200)
  @RequirePermission(Permission.CONTACTS_WRITE)
  setConsent(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(setConsentSchema)) body: SetConsentInput,
  ): Promise<ContactDto> {
    return this.contacts.setConsent(actor(auth, req), id, body);
  }

  @Get(':id/consent')
  @RequirePermission(Permission.CONTACTS_READ)
  consent(@Param('id', ParseUUIDPipe) id: string): Promise<ConsentEventDto[]> {
    return this.contacts.consentHistory(id);
  }

  @Get(':id/conversations')
  @RequirePermission(Permission.CONTACTS_READ)
  conversations(@Param('id', ParseUUIDPipe) id: string): Promise<ContactConversationDto[]> {
    return this.contacts.conversations(id);
  }

  @Get(':id/notes')
  @RequirePermission(Permission.CONTACTS_READ)
  notes(@Param('id', ParseUUIDPipe) id: string): Promise<ContactNoteDto[]> {
    return this.contacts.listNotes(id);
  }

  @Post(':id/notes')
  @RequirePermission(Permission.CONTACTS_WRITE)
  addNote(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(createContactNoteSchema)) body: CreateContactNoteInput,
  ): Promise<ContactNoteDto> {
    return this.contacts.addNote(actor(auth), id, body.body);
  }

  @Delete(':id/notes/:noteId')
  @HttpCode(204)
  @RequirePermission(Permission.CONTACTS_WRITE)
  async deleteNote(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
  ): Promise<void> {
    await this.contacts.deleteNote(
      actor(auth),
      id,
      noteId,
      hasPermission(auth.role, Permission.CONTACTS_MANAGE),
    );
  }
}

@Controller('contact-tags')
export class ContactTagsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @RequirePermission(Permission.CONTACTS_READ)
  list(): Promise<TagDto[]> {
    return this.contacts.listTags();
  }

  @Post()
  @RequirePermission(Permission.CONTACTS_WRITE)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createTagSchema)) body: z.infer<typeof createTagSchema>,
  ): Promise<TagDto> {
    return this.contacts.createTag(actor(auth), body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.CONTACTS_MANAGE)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.contacts.deleteTag(id);
  }
}

@Controller('contact-fields')
export class ContactFieldsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @RequirePermission(Permission.CONTACTS_READ)
  list(): Promise<ContactFieldDto[]> {
    return this.contacts.listFields();
  }

  @Post()
  @RequirePermission(Permission.CONTACTS_MANAGE)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createContactFieldSchema)) body: z.infer<typeof createContactFieldSchema>,
  ): Promise<ContactFieldDto> {
    return this.contacts.createField(actor(auth), body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.CONTACTS_MANAGE)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.contacts.deleteField(id);
  }
}

@Controller('contact-settings')
export class ContactSettingsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get('opt-out-keywords')
  @RequirePermission(Permission.CONTACTS_READ)
  keywords(@CurrentAuth() auth: AuthContext) {
    return this.contacts.getOptOutKeywords(actor(auth));
  }

  @Put('opt-out-keywords')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  setKeywords(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(updateOptOutKeywordsSchema)) body: UpdateOptOutKeywordsInput,
  ) {
    return this.contacts.setOptOutKeywords(actor(auth, req), body.keywords);
  }
}

@Controller('segments')
export class SegmentsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @RequirePermission(Permission.CONTACTS_READ)
  list(): Promise<SegmentDto[]> {
    return this.contacts.listSegments();
  }

  /** Count for a filter that has not been saved yet. */
  @Post('preview')
  @HttpCode(200)
  @RequirePermission(Permission.CONTACTS_READ)
  preview(
    @Body(zod(previewSegmentSchema)) body: z.infer<typeof previewSegmentSchema>,
  ): Promise<{ count: number }> {
    return this.contacts.segmentCount(body.filter);
  }

  @Post()
  @RequirePermission(Permission.CONTACTS_MANAGE)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(zod(createSegmentSchema)) body: z.infer<typeof createSegmentSchema>,
  ): Promise<SegmentDto> {
    return this.contacts.createSegment(actor(auth), body);
  }

  @Get(':id/count')
  @RequirePermission(Permission.CONTACTS_READ)
  async count(@Param('id', ParseUUIDPipe) id: string): Promise<{ count: number }> {
    const segment = await this.contacts.getSegment(id);
    return this.contacts.segmentCount(segment.filter);
  }

  @Patch(':id')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateSegmentSchema)) body: z.infer<typeof updateSegmentSchema>,
  ): Promise<SegmentDto> {
    return this.contacts.updateSegment(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.CONTACTS_MANAGE)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.contacts.deleteSegment(id);
  }
}

@Controller('contact-jobs')
export class ContactJobsController {
  constructor(private readonly jobs: ContactJobsService) {}

  @Get()
  @RequirePermission(Permission.CONTACTS_MANAGE)
  list(): Promise<ContactJobDto[]> {
    return this.jobs.list();
  }

  /** multipart/form-data with `options` (JSON), then `file` last. */
  @Post('import')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  async import(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
  ): Promise<ContactJobDto> {
    const part = await req
      .file({ limits: { fileSize: MAX_CONTACT_IMPORT_BYTES } })
      .catch(() => undefined);
    if (!part) throw new AppError(ErrorCode.VALIDATION_FAILED, 'A CSV file is required');
    if (!part.filename?.toLowerCase().endsWith('.csv')) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Please upload a .csv file');
    }
    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'This file is over the 50 MB limit');
    }
    const field = part.fields.options;
    const raw = field && !Array.isArray(field) && field.type === 'field' ? field.value : undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Import options are missing');
    }
    const options = zod(contactImportOptionsSchema).transform(parsed);
    return this.jobs.startImport(
      actor(auth, req),
      { bytes, filename: part.filename ?? null },
      options,
    );
  }

  @Post('export')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  export(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Body(zod(contactExportSchema)) body: ContactExportInput,
  ): Promise<ContactJobDto> {
    return this.jobs.startExport(actor(auth, req), body);
  }

  @Get(':id')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ContactJobDto> {
    return this.jobs.get(id);
  }

  /** Signed link to the export, or to an import's per-row error report. */
  @Post(':id/download')
  @HttpCode(200)
  @RequirePermission(Permission.CONTACTS_MANAGE)
  download(
    @CurrentAuth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MediaUrlDto> {
    return this.jobs.downloadUrl(actor(auth, req), id);
  }
}
