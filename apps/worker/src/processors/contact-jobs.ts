import { Readable } from 'node:stream';
import {
  contactInclude,
  contactJobToDto,
  contactListWhere,
  type ContactListFilter,
  type Prisma,
  type TenantTx,
  withTenant,
} from '@wacrm/db';
import {
  coerceFieldValue,
  type ContactImportOptions,
  contactImportOptionsSchema,
  type ContactJobQueueData,
  csvCell,
  type FieldValue,
} from '@wacrm/shared';
import { contactJobKey, normalizePhone } from '@wacrm/shared/server';
import { parse } from 'csv-parse';
import { z } from 'zod';
import type { WorkerDeps } from '../deps';

const IMPORT_BATCH = 1000;
const EXPORT_PAGE = 2000;
/** The report is a sample past this point; errorCount still counts every row. */
const MAX_REPORTED_ERRORS = 100_000;
const MAX_TAGS_PER_ROW = 20;

const email = z.email();

interface PendingRow {
  rowNumber: number;
  waId: string;
  phone: string;
  name: string | null;
  email: string | null;
  fields: Record<string, FieldValue>;
  tags: string[];
}

interface RowError {
  rowNumber: number;
  phone: string;
  error: string;
}

interface Totals {
  processed: number;
  created: number;
  updated: number;
  errors: number;
}

/**
 * Run one import or export. Safe to run again after a crash: imports upsert by number, so a retry
 * repeats work without duplicating contacts. After a retry, rows from the first attempt count as
 * updated rather than created.
 */
export async function processContactJob(
  deps: WorkerDeps,
  data: ContactJobQueueData,
  opts: { finalAttempt: boolean },
): Promise<void> {
  const { orgId, jobId } = data;
  const update = async (patch: Prisma.ContactJobUpdateInput) => {
    const row = await withTenant(deps.db, { orgId }, (tx) =>
      tx.contactJob.update({ where: { id: jobId }, data: patch }),
    );
    deps.publisher.emit(orgId, 'contact-job:updated', { job: contactJobToDto(row) });
  };

  const job = await withTenant(deps.db, { orgId }, (tx) =>
    tx.contactJob.findUnique({ where: { id: jobId } }),
  );
  if (!job || job.status === 'completed' || job.status === 'failed') return;

  await update({
    status: 'processing',
    startedAt: new Date(),
    processedRows: 0,
    createdCount: 0,
    updatedCount: 0,
    errorCount: 0,
  });

  try {
    if (job.kind === 'import') {
      const options = contactImportOptionsSchema.parse(job.options);
      await runImport(deps, orgId, jobId, options, update);
    } else {
      await runExport(deps, orgId, jobId, job.options as unknown as ContactListFilter, update);
    }
  } catch (err) {
    if (opts.finalAttempt) {
      await update({
        status: 'failed',
        error: err instanceof Error ? err.message.slice(0, 500) : 'This job failed',
        finishedAt: new Date(),
      });
    }
    throw err;
  }
}

async function runImport(
  deps: WorkerDeps,
  orgId: string,
  jobId: string,
  options: ContactImportOptions,
  update: (patch: Prisma.ContactJobUpdateInput) => Promise<void>,
): Promise<void> {
  const bytes = await deps.storage.get(contactJobKey(orgId, jobId, 'source'));
  const defs = await withTenant(deps.db, { orgId }, (tx) => tx.contactField.findMany());
  const { columns } = options;

  const totals: Totals = { processed: 0, created: 0, updated: 0, errors: 0 };
  const errors: RowError[] = [];
  const addError = (e: RowError) => {
    totals.errors++;
    if (errors.length < MAX_REPORTED_ERRORS) errors.push(e);
  };

  /** Number -> the row it first appeared on. A later row with that number is a duplicate. */
  const seen = new Map<string, number>();
  const tagIds = new Map<string, string>();
  let batch: PendingRow[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    await withTenant(
      deps.db,
      { orgId },
      async (tx) => {
        await applyBatch(tx, orgId, rows, options, tagIds, totals, addError);
        await tx.contactJob.update({
          where: { id: jobId },
          data: {
            processedRows: totals.processed,
            createdCount: totals.created,
            updatedCount: totals.updated,
            errorCount: totals.errors,
          },
        });
      },
      { timeout: 60_000 },
    );
    const row = await withTenant(deps.db, { orgId }, (tx) =>
      tx.contactJob.findUniqueOrThrow({ where: { id: jobId } }),
    );
    deps.publisher.emit(orgId, 'contact-job:updated', { job: contactJobToDto(row) });
  };

  let rowNumber = 1; // The header is row 1, as in a spreadsheet.
  const parser = Readable.from(bytes).pipe(
    parse({
      bom: true,
      columns: true,
      relax_column_count: true,
      skip_empty_lines: true,
      skip_records_with_error: true,
      trim: true,
    }),
  );
  parser.on('skip', (err: Error) => {
    totals.processed++;
    addError({
      rowNumber: rowNumber + 1,
      phone: '',
      error: `Could not read this row: ${err.message}`,
    });
  });

  for await (const record of parser as AsyncIterable<Record<string, string | undefined>>) {
    rowNumber++;
    const phone = record[columns.phone] ?? '';
    const fail = (error: string) => {
      totals.processed++;
      addError({ rowNumber, phone, error });
    };

    const waId = normalizePhone(phone, options.defaultCountry);
    if (!waId) {
      fail(phone ? 'Not a valid phone number' : 'Phone number is empty');
      continue;
    }
    const firstRow = seen.get(waId);
    if (firstRow !== undefined) {
      fail(`Same number as row ${firstRow}`);
      continue;
    }

    const rawEmail = columns.email ? record[columns.email] : undefined;
    if (rawEmail && !email.safeParse(rawEmail).success) {
      fail('Not a valid email address');
      continue;
    }

    const fields: Record<string, FieldValue> = {};
    let fieldError: string | null = null;
    for (const [key, column] of Object.entries(columns.fields)) {
      const raw = record[column];
      if (!raw) continue;
      const def = defs.find((d) => d.key === key);
      if (!def) continue;
      const res = coerceFieldValue(def, raw);
      if (!res.ok) {
        fieldError = res.error;
        break;
      }
      fields[key] = res.value;
    }
    if (fieldError) {
      fail(fieldError);
      continue;
    }

    seen.set(waId, rowNumber);
    const rawTags = columns.tags ? record[columns.tags] : undefined;
    batch.push({
      rowNumber,
      waId,
      phone,
      name: (columns.name ? record[columns.name]?.slice(0, 200) : undefined) || null,
      email: rawEmail || null,
      fields,
      tags: [
        ...new Set(
          (rawTags ?? '')
            .split(/[;|,]/)
            .map((t) => t.trim().slice(0, 40))
            .filter(Boolean),
        ),
      ].slice(0, MAX_TAGS_PER_ROW),
    });
    if (batch.length >= IMPORT_BATCH) await flush();
  }
  await flush();

  let resultKey: string | null = null;
  if (errors.length) {
    const lines = ['row,phone,error'];
    for (const e of errors) lines.push(`${e.rowNumber},${csvCell(e.phone)},${csvCell(e.error)}`);
    resultKey = contactJobKey(orgId, jobId, 'result');
    await deps.storage.put(resultKey, Buffer.from(`${lines.join('\r\n')}\r\n`), 'text/csv');
  }
  await update({
    status: 'completed',
    resultKey,
    processedRows: totals.processed,
    createdCount: totals.created,
    updatedCount: totals.updated,
    errorCount: totals.errors,
    finishedAt: new Date(),
  });
}

interface UpsertResult {
  id: string;
  wa_id: string;
  inserted: boolean;
  status: string;
  previous: string | null;
}

/**
 * One set-based upsert per batch. Rules:
 * - An import fills in or overwrites values the file provides, and never blanks anything.
 * - Consent can only move from unknown to opted_in: an opt-out is never overwritten by a file.
 * - A deleted contact comes back with its consent record. A merged one is refused, so its row
 *   is reported rather than silently changing a hidden record.
 */
async function applyBatch(
  tx: TenantTx,
  orgId: string,
  rows: PendingRow[],
  options: ContactImportOptions,
  tagIds: Map<string, string>,
  totals: Totals,
  addError: (e: RowError) => void,
): Promise<void> {
  const payload = JSON.stringify(
    rows.map((r) => ({
      wa_id: r.waId,
      name: r.name,
      email: r.email,
      custom_fields: r.fields,
    })),
  );
  const waIds = rows.map((r) => r.waId);
  const consent = options.consent ?? null;
  const status = consent ? 'opted_in' : 'unknown';
  const source = consent?.source ?? null;
  const proof = consent?.proof ?? null;
  const stamp = consent ? new Date() : null;

  // Reviewed raw SQL: all values are bound parameters, and it runs under the tenant's RLS context.
  const results = await tx.$queryRaw<UpsertResult[]>`
    WITH old AS (
      SELECT wa_id, opt_in_status FROM contacts WHERE org_id = ${orgId}::uuid AND wa_id = ANY(${waIds}::text[])
    ), up AS (
      INSERT INTO contacts (
        id, org_id, wa_id, name, email, custom_fields,
        opt_in_status, opt_in_source, opt_in_proof, opt_in_at, updated_at
      )
      SELECT
        gen_random_uuid(), ${orgId}::uuid, r.wa_id, r.name, r.email, r.custom_fields,
        ${status}::"ContactOptInStatus", ${source}, ${proof}, ${stamp}::timestamptz, now()
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS r(wa_id text, name text, email text, custom_fields jsonb)
      ON CONFLICT (org_id, wa_id) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, contacts.name),
        email = COALESCE(EXCLUDED.email, contacts.email),
        custom_fields = contacts.custom_fields || EXCLUDED.custom_fields,
        deleted_at = NULL,
        updated_at = now(),
        opt_in_source = CASE WHEN contacts.opt_in_status = 'unknown' THEN EXCLUDED.opt_in_source ELSE contacts.opt_in_source END,
        opt_in_proof = CASE WHEN contacts.opt_in_status = 'unknown' THEN EXCLUDED.opt_in_proof ELSE contacts.opt_in_proof END,
        opt_in_at = CASE WHEN contacts.opt_in_status = 'unknown' THEN EXCLUDED.opt_in_at ELSE contacts.opt_in_at END,
        opt_in_status = CASE WHEN contacts.opt_in_status = 'unknown' THEN EXCLUDED.opt_in_status ELSE contacts.opt_in_status END
      WHERE contacts.merged_into_id IS NULL
      RETURNING id, wa_id, (xmax::text = '0') AS inserted, opt_in_status
    )
    SELECT up.id::text AS id, up.wa_id, up.inserted, up.opt_in_status::text AS status,
           old.opt_in_status::text AS previous
    FROM up LEFT JOIN old ON old.wa_id = up.wa_id`;

  const byWaId = new Map(results.map((r) => [r.wa_id, r]));
  for (const row of rows) {
    totals.processed++;
    const res = byWaId.get(row.waId);
    if (!res) {
      addError({
        rowNumber: row.rowNumber,
        phone: row.phone,
        error: 'This number was merged into another contact',
      });
    } else if (res.inserted) {
      totals.created++;
    } else {
      totals.updated++;
    }
  }

  if (consent) {
    const changed = results.filter((r) => r.status === 'opted_in' && r.previous !== 'opted_in');
    await tx.contactConsentEvent.createMany({
      data: changed.map((r) => ({
        orgId,
        contactId: r.id,
        status: 'opted_in' as const,
        source: consent.source,
        proof: consent.proof,
      })),
    });
  }

  const names = [...new Set(rows.flatMap((r) => r.tags))];
  if (names.length === 0) return;
  const unknown = names.filter((n) => !tagIds.has(n));
  if (unknown.length) {
    await tx.tag.createMany({
      data: unknown.map((name) => ({ orgId, name })),
      skipDuplicates: true,
    });
    const found = await tx.tag.findMany({
      where: { name: { in: unknown } },
      select: { id: true, name: true },
    });
    for (const t of found) tagIds.set(t.name, t.id);
  }
  const links: Prisma.ContactTagCreateManyInput[] = [];
  for (const row of rows) {
    const contact = byWaId.get(row.waId);
    if (!contact) continue;
    for (const name of row.tags) {
      const tagId = tagIds.get(name);
      if (tagId) links.push({ orgId, contactId: contact.id, tagId });
    }
  }
  await tx.contactTag.createMany({ data: links, skipDuplicates: true });
}

async function runExport(
  deps: WorkerDeps,
  orgId: string,
  jobId: string,
  filter: ContactListFilter,
  update: (patch: Prisma.ContactJobUpdateInput) => Promise<void>,
): Promise<void> {
  const defs = await withTenant(deps.db, { orgId }, (tx) =>
    tx.contactField.findMany({ orderBy: { createdAt: 'asc' } }),
  );
  const where = contactListWhere(filter);
  const header = [
    'phone',
    'name',
    'email',
    'opt_in_status',
    'opt_in_source',
    'opt_in_at',
    'opt_out_at',
    'tags',
    'last_activity_at',
    'created_at',
    ...defs.map((d) => d.key),
  ];
  const chunks: string[] = [`${header.map(csvCell).join(',')}\r\n`];

  const fetchPage = (after: { createdAt: Date; id: string } | null) =>
    withTenant(deps.db, { orgId }, (tx) =>
      tx.contact.findMany({
        where: after
          ? {
              AND: [
                where,
                {
                  OR: [
                    { createdAt: { lt: after.createdAt } },
                    { createdAt: after.createdAt, id: { lt: after.id } },
                  ],
                },
              ],
            }
          : where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: EXPORT_PAGE,
        include: contactInclude,
      }),
    );

  let cursor: { createdAt: Date; id: string } | null = null;
  let count = 0;
  for (;;) {
    const page = await fetchPage(cursor);
    for (const c of page) {
      const fields = c.customFields as Record<string, FieldValue>;
      const cells = [
        // Validated digits, written directly: csvCell would treat the plus as a formula.
        `+${c.waId}`,
        csvCell(c.name),
        csvCell(c.email),
        c.optInStatus,
        csvCell(c.optInSource),
        c.optInAt?.toISOString() ?? '',
        c.optOutAt?.toISOString() ?? '',
        csvCell(c.tags.map((t) => t.tag.name).join(';')),
        c.lastActivityAt?.toISOString() ?? '',
        c.createdAt.toISOString(),
        ...defs.map((d) => csvCell(fields[d.key])),
      ];
      chunks.push(`${cells.join(',')}\r\n`);
    }
    count += page.length;
    const last = page.at(-1);
    if (!last || page.length < EXPORT_PAGE) break;
    cursor = { createdAt: last.createdAt, id: last.id };
    await update({ processedRows: count });
  }

  const resultKey = contactJobKey(orgId, jobId, 'result');
  await deps.storage.put(resultKey, Buffer.from(chunks.join('')), 'text/csv');
  await update({ status: 'completed', resultKey, processedRows: count, finishedAt: new Date() });
}
