import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { contactJobToDto, type Prisma } from '@wacrm/db';
import {
  AppError,
  type ContactExportInput,
  type ContactImportOptions,
  type ContactJobDto,
  ErrorCode,
  type MediaUrlDto,
  parseCsvHeader,
} from '@wacrm/shared';
import { contactJobKey, type ObjectStorage } from '@wacrm/shared/server';
import { AuditAction, AuditService } from '../audit/audit.service';
import { OBJECT_STORAGE } from '../infra/infra.tokens';
import { QueuesService } from '../infra/queues.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import type { ContactActor } from './contacts.service';
import { ContactsService } from './contacts.service';

const DOWNLOAD_TTL_SECONDS = 300;
/** Enough for any header row; the rest of the file is the worker's job. */
const HEADER_SCAN_BYTES = 64 * 1024;

@Injectable()
export class ContactJobsService {
  private readonly logger = new Logger(ContactJobsService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly queues: QueuesService,
    private readonly realtime: RealtimeGateway,
    private readonly contacts: ContactsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async list(): Promise<ContactJobDto[]> {
    const rows = await this.db.run((tx) =>
      tx.contactJob.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    );
    return rows.map(contactJobToDto);
  }

  async get(id: string): Promise<ContactJobDto> {
    const row = await this.db.run((tx) => tx.contactJob.findUnique({ where: { id } }));
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found');
    return contactJobToDto(row);
  }

  /** The API only stores the file. Parsing happens in the worker, so nothing blocks here. */
  async startImport(
    actor: ContactActor,
    file: { bytes: Buffer; filename: string | null },
    options: ContactImportOptions,
  ): Promise<ContactJobDto> {
    const headers = parseCsvHeader(file.bytes.subarray(0, HEADER_SCAN_BYTES).toString('utf8'));
    const mapped = [
      options.columns.phone,
      options.columns.name,
      options.columns.email,
      options.columns.tags,
      ...Object.values(options.columns.fields),
    ].filter((c): c is string => Boolean(c));
    const missing = mapped.filter((c) => !headers.includes(c));
    if (missing.length) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `These columns are not in the file: ${missing.join(', ')}`,
      );
    }
    const fieldKeys = Object.keys(options.columns.fields);
    if (fieldKeys.length) {
      const known = await this.db.run((tx) =>
        tx.contactField.count({ where: { key: { in: fieldKeys } } }),
      );
      if (known !== fieldKeys.length) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Unknown custom field in the mapping');
      }
    }

    const id = randomUUID();
    await this.storage.put(contactJobKey(actor.orgId, id, 'source'), file.bytes, 'text/csv');
    return this.createAndQueue(actor, {
      id,
      kind: 'import',
      filename: file.filename?.slice(0, 200) ?? null,
      options: options as unknown as Prisma.InputJsonValue,
      action: AuditAction.CONTACTS_IMPORT_STARTED,
      metadata: { attestedConsent: Boolean(options.consent), bytes: file.bytes.length },
    });
  }

  async startExport(actor: ContactActor, input: ContactExportInput): Promise<ContactJobDto> {
    // Resolved now, so editing the segment later cannot change a running export.
    const filter = await this.contacts.resolveFilter(input);
    return this.createAndQueue(actor, {
      id: randomUUID(),
      kind: 'export',
      filename: `contacts-${new Date().toISOString().slice(0, 10)}.csv`,
      options: filter as unknown as Prisma.InputJsonValue,
      action: AuditAction.CONTACTS_EXPORT_STARTED,
      metadata: {},
    });
  }

  private async createAndQueue(
    actor: ContactActor,
    job: {
      id: string;
      kind: 'import' | 'export';
      filename: string | null;
      options: Prisma.InputJsonValue;
      action: AuditAction;
      metadata: Prisma.InputJsonObject;
    },
  ): Promise<ContactJobDto> {
    const row = await this.db.run(async (tx) => {
      await this.audit.record(tx, actor.orgId, {
        action: job.action,
        actorUserId: actor.userId,
        targetType: 'contact_job',
        targetId: job.id,
        metadata: job.metadata,
        meta: actor.meta,
      });
      return tx.contactJob.create({
        data: {
          id: job.id,
          orgId: actor.orgId,
          kind: job.kind,
          filename: job.filename,
          options: job.options,
          createdById: actor.userId,
        },
      });
    });
    try {
      await this.queues.enqueueContactJob({ orgId: actor.orgId, jobId: job.id });
    } catch (err) {
      // Never leave a job looking like it is about to run.
      this.logger.error(`could not queue a contact job: ${String(err)}`);
      const failed = await this.db.run((tx) =>
        tx.contactJob.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            error: 'Could not start this job. Please try again.',
            finishedAt: new Date(),
          },
        }),
      );
      return contactJobToDto(failed);
    }
    const dto = contactJobToDto(row);
    this.realtime.emit(actor.orgId, 'contact-job:updated', { job: dto });
    return dto;
  }

  async downloadUrl(actor: ContactActor, id: string): Promise<MediaUrlDto> {
    const row = await this.db.run(async (tx) => {
      const job = await tx.contactJob.findUnique({
        where: { id },
        select: { kind: true, resultKey: true, filename: true },
      });
      if (job?.kind === 'export' && job.resultKey) {
        // A whole contact list leaving the system should leave a trace.
        await this.audit.record(tx, actor.orgId, {
          action: AuditAction.CONTACTS_EXPORT_DOWNLOADED,
          actorUserId: actor.userId,
          targetType: 'contact_job',
          targetId: id,
          meta: actor.meta,
        });
      }
      return job;
    });
    if (!row?.resultKey) throw new AppError(ErrorCode.NOT_FOUND, 'No file for this job');
    const filename =
      row.kind === 'export' ? row.filename : `errors-${row.filename ?? 'import.csv'}`;
    return {
      url: await this.storage.signedUrl(row.resultKey, {
        expiresIn: DOWNLOAD_TTL_SECONDS,
        filename,
        inline: false,
      }),
      expiresIn: DOWNLOAD_TTL_SECONDS,
    };
  }
}
