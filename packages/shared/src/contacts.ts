import { z } from 'zod';

export const OPT_IN_STATUSES = ['unknown', 'opted_in', 'opted_out'] as const;
export type OptInStatus = (typeof OPT_IN_STATUSES)[number];

export const CONTACT_FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select'] as const;
export type ContactFieldType = (typeof CONTACT_FIELD_TYPES)[number];

/** Marketing templates need recorded consent. Unknown is not consent. */
export const canReceiveMarketing = (status: OptInStatus) => status === 'opted_in';
export const isMarketingCategory = (category: string | null | undefined) =>
  category?.toUpperCase() === 'MARKETING';

// ------------------------------------------------------------------ opt-out keywords

/** Used until a workspace sets its own list. */
export const DEFAULT_OPT_OUT_KEYWORDS = [
  'stop',
  'stop all',
  'stop promotions',
  'unsubscribe',
  'opt out',
  'optout',
  'quit',
] as const;

const normalizeKeyword = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * True only when the whole message is a keyword, so "please don't stop sending" or "stop by the
 * shop" keep their consent. Ignores case, punctuation and extra spaces.
 */
export function isOptOutMessage(text: string | null | undefined, keywords: readonly string[]) {
  if (!text) return false;
  const message = normalizeKeyword(text);
  if (!message) return false;
  const list = keywords.length ? keywords : DEFAULT_OPT_OUT_KEYWORDS;
  return list.some((k) => normalizeKeyword(k) === message);
}

export const updateOptOutKeywordsSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(40)).min(1).max(50),
});
export type UpdateOptOutKeywordsInput = z.infer<typeof updateOptOutKeywordsSchema>;

// ------------------------------------------------------------------ custom fields

export const contactFieldKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Start with a letter; use letters, numbers and _ only');

export const createContactFieldSchema = z
  .object({
    key: contactFieldKey,
    label: z.string().trim().min(1, 'Required').max(60),
    type: z.enum(CONTACT_FIELD_TYPES),
    options: z.array(z.string().trim().min(1).max(60)).max(100).default([]),
  })
  .refine((v) => v.type !== 'select' || v.options.length > 0, {
    message: 'A select field needs at least one option',
    path: ['options'],
  });
export type CreateContactFieldInput = z.input<typeof createContactFieldSchema>;

export interface ContactFieldDto {
  id: string;
  key: string;
  label: string;
  type: ContactFieldType;
  options: string[];
}

export type FieldValue = string | number | boolean;

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0']);

/** Validate a value against its field type. Accepts raw CSV text as well as typed JSON. */
export function coerceFieldValue(
  field: Pick<ContactFieldDto, 'type' | 'options' | 'label'>,
  raw: unknown,
): { ok: true; value: FieldValue } | { ok: false; error: string } {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  const bad = (what: string) => ({ ok: false as const, error: `${field.label}: ${what}` });
  switch (field.type) {
    case 'text':
      if (typeof text !== 'string' && typeof text !== 'number') return bad('must be text');
      if (String(text).length > 1000) return bad('is over 1000 characters');
      return { ok: true, value: String(text) };
    case 'number': {
      const n = typeof text === 'number' ? text : Number(text);
      if (text === '' || typeof text === 'boolean' || !Number.isFinite(n)) {
        return bad('must be a number');
      }
      return { ok: true, value: n };
    }
    case 'date': {
      if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return bad('must be a date like 2026-01-31');
      }
      const d = new Date(`${text}T00:00:00Z`);
      // Rejects dates that roll over, such as 2026-02-31.
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) {
        return bad('is not a real date');
      }
      return { ok: true, value: text };
    }
    case 'boolean': {
      if (typeof text === 'boolean') return { ok: true, value: text };
      const word = String(text).toLowerCase();
      if (TRUE_WORDS.has(word)) return { ok: true, value: true };
      if (FALSE_WORDS.has(word)) return { ok: true, value: false };
      return bad('must be yes or no');
    }
    case 'select':
      if (typeof text !== 'string' || !field.options.includes(text)) {
        return bad(`must be one of: ${field.options.join(', ')}`);
      }
      return { ok: true, value: text };
  }
}

// ------------------------------------------------------------------ contacts

const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use a two-letter country code');

const contactName = z.string().trim().max(200);
const contactEmail = z.email().max(320);

/** Values are checked against the workspace's field definitions in the service. */
const customFieldValues = z.record(contactFieldKey, z.unknown());

export const createContactSchema = z.object({
  phone: z.string().trim().min(5, 'Enter a phone number').max(32),
  defaultCountry: countryCode.optional(),
  name: contactName.optional(),
  email: contactEmail.optional(),
  customFields: customFieldValues.optional(),
  tagIds: z.array(z.uuid()).max(50).optional(),
});
export type CreateContactInput = z.input<typeof createContactSchema>;

export const updateContactSchema = z
  .object({
    name: contactName.nullable().optional(),
    email: contactEmail.nullable().optional(),
    /** Merged over current values. A null removes that field. */
    customFields: customFieldValues.optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.email !== undefined || v.customFields !== undefined,
    'Nothing to update',
  );
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

export const listContactsSchema = z.object({
  q: z.string().trim().max(100).optional(),
  tagId: z.uuid().optional(),
  optIn: z.enum(OPT_IN_STATUSES).optional(),
  segmentId: z.uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListContactsQuery = z.infer<typeof listContactsSchema>;

export const setContactTagsSchema = z.object({ tagIds: z.array(z.uuid()).max(50) });
export type SetContactTagsInput = z.infer<typeof setContactTagsSchema>;

export const createTagSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour')
    .default('#64748b'),
});
export type CreateTagInput = z.input<typeof createTagSchema>;

export const createContactNoteSchema = z.object({
  body: z.string().trim().min(1, 'Note is empty').max(4000),
});
export type CreateContactNoteInput = z.infer<typeof createContactNoteSchema>;

/** Opting someone in needs a record of how they agreed. Opting out never needs a reason. */
export const setConsentSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('opted_in'),
    source: z.string().trim().min(1, 'Say where the consent came from').max(100),
    proof: z.string().trim().min(3, 'Describe the proof of consent').max(1000),
  }),
  z.object({
    status: z.literal('opted_out'),
    source: z.string().trim().max(100).optional(),
    proof: z.string().trim().max(1000).optional(),
  }),
]);
export type SetConsentInput = z.infer<typeof setConsentSchema>;

export const mergeContactsSchema = z.object({
  primaryId: z.uuid(),
  duplicateIds: z.array(z.uuid()).min(1).max(10),
});
export type MergeContactsInput = z.infer<typeof mergeContactsSchema>;

/**
 * Bulk changes apply to the selected rows. There is deliberately no bulk opt-in: consent is
 * recorded per person, or attested for a whole file during an import.
 */
export const bulkContactsSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(1000),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('add_tag'), tagId: z.uuid() }),
    z.object({ type: z.literal('remove_tag'), tagId: z.uuid() }),
    z.object({ type: z.literal('opt_out') }),
    z.object({ type: z.literal('delete') }),
  ]),
});
export type BulkContactsInput = z.infer<typeof bulkContactsSchema>;

export interface TagDto {
  id: string;
  name: string;
  color: string;
}

export interface ContactDto {
  id: string;
  waId: string;
  name: string | null;
  email: string | null;
  customFields: Record<string, FieldValue>;
  tags: TagDto[];
  optInStatus: OptInStatus;
  optInSource: string | null;
  optInProof: string | null;
  optInAt: string | null;
  optOutAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
}

export interface ContactNoteDto {
  id: string;
  body: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
}

export interface ConsentEventDto {
  id: string;
  status: OptInStatus;
  source: string | null;
  proof: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface ContactConversationDto {
  id: string;
  status: string;
  phoneDisplay: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

// ------------------------------------------------------------------ segments

const customRule = z.discriminatedUnion('op', [
  z.object({
    field: z.literal('custom'),
    key: contactFieldKey,
    op: z.literal('eq'),
    value: z.union([z.string().max(1000), z.number(), z.boolean()]),
  }),
  z.object({
    field: z.literal('custom'),
    key: contactFieldKey,
    op: z.literal('neq'),
    value: z.union([z.string().max(1000), z.number(), z.boolean()]),
  }),
  z.object({
    field: z.literal('custom'),
    key: contactFieldKey,
    op: z.literal('contains'),
    value: z.string().min(1).max(200),
  }),
  z.object({
    field: z.literal('custom'),
    key: contactFieldKey,
    op: z.literal('gt'),
    value: z.union([z.string().max(40), z.number()]),
  }),
  z.object({
    field: z.literal('custom'),
    key: contactFieldKey,
    op: z.literal('lt'),
    value: z.union([z.string().max(40), z.number()]),
  }),
  z.object({ field: z.literal('custom'), key: contactFieldKey, op: z.literal('is_set') }),
  z.object({ field: z.literal('custom'), key: contactFieldKey, op: z.literal('not_set') }),
]);

const days = z.number().int().min(1).max(3650);

export const segmentRuleSchema = z.union([
  z.object({ field: z.literal('tag'), op: z.enum(['has', 'not_has']), tagId: z.uuid() }),
  z.object({
    field: z.literal('opt_in'),
    op: z.enum(['is', 'is_not']),
    value: z.enum(OPT_IN_STATUSES),
  }),
  z.object({
    field: z.literal('last_activity'),
    op: z.enum(['within_days', 'older_than_days']),
    days,
  }),
  z.object({ field: z.literal('last_activity'), op: z.literal('never') }),
  customRule,
]);
export type SegmentRule = z.infer<typeof segmentRuleSchema>;

export const segmentFilterSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  rules: z.array(segmentRuleSchema).max(20).default([]),
});
export type SegmentFilter = z.infer<typeof segmentFilterSchema>;

export const createSegmentSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(80),
  filter: segmentFilterSchema,
});
export type CreateSegmentInput = z.input<typeof createSegmentSchema>;

export const updateSegmentSchema = createSegmentSchema.partial();
export type UpdateSegmentInput = z.input<typeof updateSegmentSchema>;

export const previewSegmentSchema = z.object({ filter: segmentFilterSchema });

export interface SegmentDto {
  id: string;
  name: string;
  filter: SegmentFilter;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------ import and export

export const MAX_CONTACT_IMPORT_BYTES = 50 * 1024 * 1024;

export const CONTACT_IMPORT_TYPES = [
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/octet-stream',
];

/** Maps CSV column headers onto contact properties. */
export const contactImportOptionsSchema = z
  .object({
    columns: z.object({
      phone: z.string().min(1, 'Choose the phone column').max(200),
      name: z.string().max(200).optional(),
      email: z.string().max(200).optional(),
      tags: z.string().max(200).optional(),
      /** Custom field key -> CSV column. */
      fields: z.record(contactFieldKey, z.string().max(200)).default({}),
    }),
    /** For numbers written without a country code. */
    defaultCountry: countryCode.optional(),
    /** The uploader states that everyone in this file agreed to marketing. */
    consent: z
      .object({
        source: z.string().trim().min(1, 'Say where the consent came from').max(100),
        proof: z.string().trim().min(3, 'Describe the proof of consent').max(1000),
      })
      .optional(),
  })
  .strict();
export type ContactImportOptions = z.infer<typeof contactImportOptionsSchema>;
export type ContactImportOptionsInput = z.input<typeof contactImportOptionsSchema>;

export const contactExportSchema = z.object({
  q: z.string().trim().max(100).optional(),
  tagId: z.uuid().optional(),
  optIn: z.enum(OPT_IN_STATUSES).optional(),
  segmentId: z.uuid().optional(),
});
export type ContactExportInput = z.infer<typeof contactExportSchema>;

export const contactJobDownloadSchema = z.object({ file: z.enum(['result']).default('result') });

export type ContactJobKind = 'import' | 'export';
export type ContactJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface ContactJobDto {
  id: string;
  kind: ContactJobKind;
  status: ContactJobStatus;
  filename: string | null;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  errorCount: number;
  /** Import: a per-row error report. Export: the contacts file. */
  hasFile: boolean;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Read the header row in the browser, to offer column mapping before uploading. */
export function parseCsvHeader(text: string): string[] {
  const clean = text.replace(/^\uFEFF/, '');
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      break;
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((c) => c.trim()).filter(Boolean);
}

/**
 * One CSV cell. Spreadsheets run cells starting with = + - @ as formulas, and these values come
 * from customers, so such cells get a leading quote.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
