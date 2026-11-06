import { z } from 'zod';
import type { FieldValue } from './contacts';

/** Categories people can create here. Authentication templates need Meta's OTP buttons. */
export const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY'] as const;
export type BuildableTemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
  'in_appeal',
  'pending_deletion',
  'deleted',
  'archived',
  'limit_exceeded',
  'locked',
] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/** Meta's rule: edits are accepted in these states. */
export const EDITABLE_AT_META: readonly string[] = ['approved', 'rejected', 'paused'];

/** Language codes Meta accepts for templates. The server accepts any code of this shape. */
export const TEMPLATE_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'en_US', label: 'English (US)' },
  { code: 'en_GB', label: 'English (UK)' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'kn', label: 'Kannada' },
  { code: 'mr', label: 'Marathi' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'bn', label: 'Bengali' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'ur', label: 'Urdu' },
  { code: 'ar', label: 'Arabic' },
  { code: 'fa', label: 'Persian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ms', label: 'Malay' },
  { code: 'fil', label: 'Filipino' },
  { code: 'th', label: 'Thai' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'zh_CN', label: 'Chinese (China)' },
  { code: 'zh_HK', label: 'Chinese (Hong Kong)' },
  { code: 'zh_TW', label: 'Chinese (Taiwan)' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'es_ES', label: 'Spanish (Spain)' },
  { code: 'es_MX', label: 'Spanish (Mexico)' },
  { code: 'es_AR', label: 'Spanish (Argentina)' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'pt_BR', label: 'Portuguese (Brazil)' },
  { code: 'pt_PT', label: 'Portuguese (Portugal)' },
  { code: 'ro', label: 'Romanian' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'sv', label: 'Swedish' },
  { code: 'da', label: 'Danish' },
  { code: 'nb', label: 'Norwegian' },
  { code: 'fi', label: 'Finnish' },
  { code: 'el', label: 'Greek' },
  { code: 'he', label: 'Hebrew' },
  { code: 'sw', label: 'Swahili' },
  { code: 'af', label: 'Afrikaans' },
  { code: 'zu', label: 'Zulu' },
];

/** Plain-language versions of Meta's rejection reasons. */
export const REJECTION_EXPLANATIONS: Record<string, string> = {
  ABUSIVE_CONTENT: 'Meta found content that breaks its policies.',
  INCORRECT_CATEGORY: 'The category does not match the content. Check marketing versus utility.',
  INVALID_FORMAT: 'The format is not valid, for example misplaced variables or an unclear sample.',
  PROMOTIONAL: 'This reads as promotional, so it cannot be a utility template.',
  SCAM: 'Meta suspects this message is misleading or a scam.',
  TAG_CONTENT_MISMATCH: 'The content does not match the template type or tags.',
  CATEGORY_NOT_AVAILABLE: 'This category is not available for this account.',
  NONE: 'Meta gave no specific reason.',
};

// ------------------------------------------------------------------ definition

const label = z.string().trim().min(1, 'Required').max(25, 'Use 25 characters or fewer');

const buttonSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('QUICK_REPLY'), text: label }),
  z.object({
    type: z.literal('URL'),
    text: label,
    url: z.string().trim().min(1, 'Required').max(2000),
  }),
  z.object({
    type: z.literal('PHONE_NUMBER'),
    text: label,
    phoneNumber: z
      .string()
      .trim()
      .regex(/^\+?\d{5,20}$/, 'Use digits, with the country code'),
  }),
  z.object({
    type: z.literal('COPY_CODE'),
    example: z
      .string()
      .trim()
      .min(1, 'Required')
      .max(20, 'Use 20 characters or fewer')
      .regex(/^[A-Za-z0-9]+$/, 'Use letters and numbers only'),
  }),
]);
export type TemplateButton = z.infer<typeof buttonSchema>;

const headerSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('TEXT'),
    text: z.string().trim().min(1, 'Required').max(60, 'Use 60 characters or fewer'),
  }),
  z.object({ format: z.literal('IMAGE') }),
  z.object({ format: z.literal('VIDEO') }),
  z.object({ format: z.literal('DOCUMENT') }),
]);
export type TemplateHeader = z.infer<typeof headerSchema>;
export type MediaHeaderFormat = 'IMAGE' | 'VIDEO' | 'DOCUMENT';

export const templateDefinitionSchema = z.object({
  header: headerSchema.nullable().default(null),
  body: z.string().trim().min(1, 'The body is required').max(1024, 'Use 1024 characters or fewer'),
  footer: z.string().trim().max(60, 'Use 60 characters or fewer').nullable().default(null),
  buttons: z.array(buttonSchema).max(10, 'Use 10 buttons or fewer').default([]),
});
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;

/** Where a variable's value comes from when a template is sent to a contact. */
export const variableSourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('static'), value: z.string().max(1024) }),
  z.object({
    source: z.literal('contact'),
    field: z.enum(['first_name', 'name', 'phone', 'email']),
  }),
  z.object({ source: z.literal('custom'), key: z.string().min(1).max(40) }),
]);
export type VariableSource = z.infer<typeof variableSourceSchema>;

// ------------------------------------------------------------------ variables

const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g;

export const placeholdersIn = (text: string) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);

export interface TemplateVariable {
  /** header.<name>, body.<name>, button.<index>.<name>, or button.<index>.code */
  key: string;
  part: 'header' | 'body' | 'button';
  name: string;
  /** The button's position among all buttons, which is what Meta's send call uses. */
  buttonIndex?: number;
  subType?: 'url' | 'copy_code';
  label: string;
}

export function templateVariables(def: TemplateDefinition): TemplateVariable[] {
  const vars: TemplateVariable[] = [];
  if (def.header?.format === 'TEXT') {
    for (const name of new Set(placeholdersIn(def.header.text))) {
      vars.push({ key: `header.${name}`, part: 'header', name, label: `Header {{${name}}}` });
    }
  }
  for (const name of new Set(placeholdersIn(def.body))) {
    vars.push({ key: `body.${name}`, part: 'body', name, label: `Body {{${name}}}` });
  }
  def.buttons.forEach((button, buttonIndex) => {
    if (button.type === 'URL') {
      for (const name of new Set(placeholdersIn(button.url))) {
        vars.push({
          key: `button.${buttonIndex}.${name}`,
          part: 'button',
          name,
          buttonIndex,
          subType: 'url',
          label: `“${button.text}” link {{${name}}}`,
        });
      }
    }
    if (button.type === 'COPY_CODE') {
      vars.push({
        key: `button.${buttonIndex}.code`,
        part: 'button',
        name: 'code',
        buttonIndex,
        subType: 'copy_code',
        label: 'Offer code',
      });
    }
  });
  return vars;
}

export type ParameterFormat = 'positional' | 'named';

/** Header and body decide the format. Link buttons always use {{1}}. */
export function parameterFormatOf(def: TemplateDefinition): ParameterFormat {
  const names = [
    ...(def.header?.format === 'TEXT' ? placeholdersIn(def.header.text) : []),
    ...placeholdersIn(def.body),
  ];
  return names.some((n) => !/^\d+$/.test(n)) ? 'named' : 'positional';
}

// ------------------------------------------------------------------ validation

export interface TemplateIssue {
  path: (string | number)[];
  message: string;
}

function checkVariables(text: string, path: (string | number)[], issues: TemplateIssue[]) {
  const withoutValid = text.replace(PLACEHOLDER, '');
  if (/\{\{|\}\}/.test(withoutValid)) {
    issues.push({
      path,
      message: 'Write variables like {{1}} or {{first_name}}, in lowercase with no spaces',
    });
  }
  const names = placeholdersIn(text);
  if (new Set(names).size !== names.length) {
    issues.push({ path, message: 'Use each variable only once' });
  }
  const numbers = names.filter((n) => /^\d+$/.test(n)).map(Number);
  if (numbers.length && numbers.length !== names.length) {
    issues.push({ path, message: 'Use either numbers or names for variables, not both' });
  } else if (numbers.length && !numbers.every((n, i) => n === i + 1)) {
    issues.push({ path, message: 'Number variables in order, starting at {{1}}' });
  }
  if (names.some((n) => /^\d/.test(n) && !/^\d+$/.test(n))) {
    issues.push({ path, message: 'Variable names must start with a letter' });
  }
}

/** Meta's documented rules, checked before anything is submitted. */
export function templateIssues(
  def: TemplateDefinition,
  samples: Record<string, string>,
): TemplateIssue[] {
  const issues: TemplateIssue[] = [];

  checkVariables(def.body, ['definition', 'body'], issues);
  const body = def.body.trim();
  if (/^\{\{/.test(body) || /\}\}$/.test(body)) {
    issues.push({
      path: ['definition', 'body'],
      message: 'The body cannot start or end with a variable',
    });
  }
  if (/\}\}\s*\{\{/.test(body)) {
    issues.push({
      path: ['definition', 'body'],
      message: 'Put some text between variables',
    });
  }

  if (def.header?.format === 'TEXT') {
    checkVariables(def.header.text, ['definition', 'header', 'text'], issues);
    if (placeholdersIn(def.header.text).length > 1) {
      issues.push({
        path: ['definition', 'header', 'text'],
        message: 'A header can have only one variable',
      });
    }
  }

  if (def.footer && /\{\{/.test(def.footer)) {
    issues.push({ path: ['definition', 'footer'], message: 'A footer cannot have variables' });
  }

  const names = [
    ...(def.header?.format === 'TEXT' ? placeholdersIn(def.header.text) : []),
    ...placeholdersIn(def.body),
  ];
  const styles = new Set(names.map((n) => /^\d+$/.test(n)));
  if (styles.size > 1) {
    issues.push({
      path: ['definition', 'body'],
      message: 'Use either numbers or names for variables across the header and body, not both',
    });
  }

  const count = (type: TemplateButton['type']) => def.buttons.filter((b) => b.type === type).length;
  if (count('URL') > 2) {
    issues.push({ path: ['definition', 'buttons'], message: 'Use at most 2 link buttons' });
  }
  if (count('PHONE_NUMBER') > 1) {
    issues.push({ path: ['definition', 'buttons'], message: 'Use at most 1 call button' });
  }
  if (count('COPY_CODE') > 1) {
    issues.push({ path: ['definition', 'buttons'], message: 'Use at most 1 copy-code button' });
  }
  // Quick replies must sit together: QR, QR, URL is fine, and QR, URL, QR is not.
  const runs = def.buttons
    .map((b) => b.type === 'QUICK_REPLY')
    .filter((isQuick, i, all) => i === 0 || isQuick !== all[i - 1]);
  if (runs.filter(Boolean).length > 1) {
    issues.push({
      path: ['definition', 'buttons'],
      message: 'Keep quick replies next to each other',
    });
  }
  def.buttons.forEach((button, i) => {
    if (button.type !== 'URL') return;
    const path = ['definition', 'buttons', i, 'url'];
    if (!/^https?:\/\/[^\s]+\.[^\s]+/.test(button.url)) {
      issues.push({ path, message: 'Enter a full web address, starting with https://' });
    }
    const vars = placeholdersIn(button.url);
    if (vars.length > 1 || (vars.length === 1 && vars[0] !== '1')) {
      issues.push({ path, message: 'A link can have only one variable, written {{1}}' });
    }
    if (vars.length === 1 && !button.url.endsWith('{{1}}')) {
      issues.push({ path, message: 'A link variable must be at the very end' });
    }
  });

  for (const v of templateVariables(def)) {
    if (v.subType === 'copy_code') continue;
    if (!samples[v.key]?.trim()) {
      issues.push({ path: ['samples', v.key], message: `Add a sample for ${v.label}` });
    }
  }
  return issues;
}

/** Advice that does not block submitting, but is a common reason for rejection. */
export function templateWarnings(def: TemplateDefinition): string[] {
  const warnings: string[] = [];
  const vars = placeholdersIn(def.body).length;
  const words = def.body.replace(PLACEHOLDER, ' ').trim().split(/\s+/).filter(Boolean).length;
  if (vars > 0 && words < vars * 3) {
    warnings.push('This has many variables for its length, and Meta may reject it. Add more text.');
  }
  return warnings;
}

const addIssues = (ctx: z.RefinementCtx, issues: TemplateIssue[]) => {
  for (const issue of issues) ctx.addIssue({ code: 'custom', ...issue });
};

const samplesSchema = z.record(z.string(), z.string().trim().max(1024)).default({});
const mappingSchema = z.record(z.string(), variableSourceSchema).default({});

export const templateName = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(512)
  .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores only');

export const createTemplateSchema = z
  .object({
    wabaAccountId: z.uuid().optional(),
    name: templateName,
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Choose a language'),
    category: z.enum(TEMPLATE_CATEGORIES),
    definition: templateDefinitionSchema,
    samples: samplesSchema,
    variableMapping: mappingSchema,
  })
  .superRefine((v, ctx) => addIssues(ctx, templateIssues(v.definition, v.samples)));
export type CreateTemplateInput = z.input<typeof createTemplateSchema>;
export type CreateTemplateParsed = z.infer<typeof createTemplateSchema>;

/** Name and language are fixed: at Meta they identify the template. */
export const updateTemplateSchema = z
  .object({
    category: z.enum(TEMPLATE_CATEGORIES),
    definition: templateDefinitionSchema,
    samples: samplesSchema,
    variableMapping: mappingSchema,
    /** Only drafts can rename, since a submitted template's name cannot change at Meta. */
    name: templateName.optional(),
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Choose a language')
      .optional(),
  })
  .superRefine((v, ctx) => addIssues(ctx, templateIssues(v.definition, v.samples)));
export type UpdateTemplateInput = z.input<typeof updateTemplateSchema>;
export type UpdateTemplateParsed = z.infer<typeof updateTemplateSchema>;

export const listTemplatesSchema = z.object({
  status: z.enum(TEMPLATE_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListTemplatesQuery = z.infer<typeof listTemplatesSchema>;

/** Meta's limits for header samples, which are also what gets sent to customers. */
const MB = 1024 * 1024;
export const HEADER_MEDIA_RULES: Record<MediaHeaderFormat, { types: string[]; maxBytes: number }> =
  {
    IMAGE: { types: ['image/jpeg', 'image/png'], maxBytes: 5 * MB },
    VIDEO: { types: ['video/mp4'], maxBytes: 16 * MB },
    DOCUMENT: { types: ['application/pdf'], maxBytes: 25 * MB },
  };

export const headerMediaKind = (format: MediaHeaderFormat) =>
  format.toLowerCase() as 'image' | 'video' | 'document';

/**
 * Compare JSON by content. Postgres reorders the keys of stored jsonb, so comparing strings would
 * report a change every time.
 */
export function sameJsonValue(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      const record = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .filter((k) => record[k] !== undefined && record[k] !== null)
          .sort()
          .map((k) => [k, canonical(record[k])]),
      );
    }
    return v ?? null;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// ------------------------------------------------------------------ DTOs

export interface TemplateDto {
  id: string;
  wabaAccountId: string;
  metaTemplateId: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  parameterFormat: ParameterFormat;
  definition: TemplateDefinition | null;
  samples: Record<string, string>;
  variableMapping: Record<string, VariableSource>;
  /** False for templates made elsewhere that use parts this app cannot send yet. */
  supported: boolean;
  rejectedReason: string | null;
  statusDetail: string | null;
  qualityScore: string | null;
  headerMedia: { mimeType: string; filename: string | null } | null;
  updatedAt: string;
  createdAt: string;
}

export interface TemplateWabaDto {
  id: string;
  name: string | null;
  connected: boolean;
}

export interface InboxTemplateVariable {
  key: string;
  label: string;
  /** Filled in from the contact where the template maps one. Agents can change it. */
  value: string;
}

export interface InboxTemplateDto {
  id: string;
  name: string;
  language: string;
  category: string;
  definition: TemplateDefinition;
  samples: Record<string, string>;
  variables: InboxTemplateVariable[];
  /** Set when this template cannot be sent yet, with what is missing. */
  sendIssue: string | null;
}

// ------------------------------------------------------------------ rendering

const fill = (text: string, part: string, values: Record<string, string>) =>
  text.replace(PLACEHOLDER, (all, name: string) => values[`${part}.${name}`] || all);

export interface RenderedTemplate {
  header: string | null;
  body: string;
  footer: string | null;
}

/** The same text the customer sees. Unfilled variables stay visible as {{name}}. */
export function renderTemplate(
  def: TemplateDefinition,
  values: Record<string, string>,
): RenderedTemplate {
  return {
    header: def.header?.format === 'TEXT' ? fill(def.header.text, 'header', values) : null,
    body: fill(def.body, 'body', values),
    footer: def.footer || null,
  };
}

/** Stored on the message, so the thread shows what was sent. */
export function renderedText(rendered: RenderedTemplate): string {
  return [rendered.header, rendered.body, rendered.footer].filter(Boolean).join('\n\n');
}

// ------------------------------------------------------------------ variable values

export interface ContactForTemplate {
  name: string | null;
  waId: string;
  email: string | null;
  customFields: Record<string, FieldValue>;
}

export function resolveVariable(source: VariableSource | undefined, c: ContactForTemplate): string {
  if (!source) return '';
  if (source.source === 'static') return source.value;
  if (source.source === 'custom') {
    const value = c.customFields[source.key];
    return value === undefined || value === null ? '' : String(value);
  }
  switch (source.field) {
    case 'first_name':
      return c.name?.trim().split(/\s+/)[0] ?? '';
    case 'name':
      return c.name ?? '';
    case 'phone':
      return `+${c.waId}`;
    case 'email':
      return c.email ?? '';
  }
}

// ------------------------------------------------------------------ Meta's format

type MetaComponent = Record<string, unknown>;

/** Build the components array for Meta's create and edit calls. */
export function toMetaComponents(
  def: TemplateDefinition,
  samples: Record<string, string>,
  headerHandle: string | null,
): MetaComponent[] {
  const named = parameterFormatOf(def) === 'named';
  const out: MetaComponent[] = [];

  if (def.header?.format === 'TEXT') {
    const vars = placeholdersIn(def.header.text);
    const example = vars.length
      ? named
        ? {
            header_text_named_params: vars.map((n) => ({
              param_name: n,
              example: samples[`header.${n}`] ?? '',
            })),
          }
        : { header_text: vars.map((n) => samples[`header.${n}`] ?? '') }
      : undefined;
    out.push({
      type: 'HEADER',
      format: 'TEXT',
      text: def.header.text,
      ...(example && { example }),
    });
  } else if (def.header) {
    out.push({
      type: 'HEADER',
      format: def.header.format,
      example: { header_handle: [headerHandle ?? ''] },
    });
  }

  const bodyVars = placeholdersIn(def.body);
  const bodyExample = bodyVars.length
    ? named
      ? {
          body_text_named_params: bodyVars.map((n) => ({
            param_name: n,
            example: samples[`body.${n}`] ?? '',
          })),
        }
      : { body_text: [bodyVars.map((n) => samples[`body.${n}`] ?? '')] }
    : undefined;
  out.push({ type: 'BODY', text: def.body, ...(bodyExample && { example: bodyExample }) });

  if (def.footer) out.push({ type: 'FOOTER', text: def.footer });

  if (def.buttons.length) {
    out.push({
      type: 'BUTTONS',
      buttons: def.buttons.map((b, i) => {
        switch (b.type) {
          case 'QUICK_REPLY':
            return { type: b.type, text: b.text };
          case 'URL': {
            const sample = samples[`button.${i}.1`];
            return {
              type: b.type,
              text: b.text,
              url: b.url,
              ...(placeholdersIn(b.url).length ? { example: [sample ?? ''] } : {}),
            };
          }
          case 'PHONE_NUMBER':
            return { type: b.type, text: b.text, phone_number: b.phoneNumber };
          case 'COPY_CODE':
            return { type: b.type, example: b.example };
        }
      }),
    });
  }
  return out;
}

interface RawComponent {
  type?: string;
  format?: string;
  text?: string;
  example?: {
    header_text?: string[];
    body_text?: string[][];
    header_text_named_params?: { param_name: string; example: string }[];
    body_text_named_params?: { param_name: string; example: string }[];
  };
  buttons?: {
    type?: string;
    text?: string;
    url?: string;
    phone_number?: string;
    example?: string | string[];
  }[];
}

export interface ParsedMetaTemplate {
  definition: TemplateDefinition | null;
  samples: Record<string, string>;
  supported: boolean;
}

/**
 * Read a template Meta returned, including ones made in Meta's own tools. Anything this app cannot
 * send (carousels, OTP, flows, location headers, ...) comes back as unsupported rather than
 * being half understood.
 */
export function fromMetaComponents(raw: unknown, category: string): ParsedMetaTemplate {
  const parts = (Array.isArray(raw) ? raw : []) as RawComponent[];
  const type = (p: RawComponent) => p.type?.toUpperCase();
  const samples: Record<string, string> = {};
  let supported = category.toUpperCase() !== 'AUTHENTICATION';

  const bodyPart = parts.find((p) => type(p) === 'BODY');
  if (!bodyPart?.text) return { definition: null, samples, supported: false };
  const known = new Set(['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
  if (parts.some((p) => !known.has(type(p) ?? ''))) supported = false;

  const named = (list: { param_name: string; example: string }[] | undefined, prefix: string) => {
    for (const p of list ?? []) samples[`${prefix}.${p.param_name}`] = p.example;
  };

  let header: TemplateHeader | null = null;
  const headerPart = parts.find((p) => type(p) === 'HEADER');
  if (headerPart) {
    const format = headerPart.format?.toUpperCase();
    if (format === 'TEXT' && headerPart.text) {
      header = { format: 'TEXT', text: headerPart.text };
      placeholdersIn(headerPart.text).forEach((n, i) => {
        const value = headerPart.example?.header_text?.[i];
        if (value) samples[`header.${n}`] = value;
      });
      named(headerPart.example?.header_text_named_params, 'header');
    } else if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT') {
      header = { format };
    } else {
      supported = false;
    }
  }

  placeholdersIn(bodyPart.text).forEach((n, i) => {
    const value = bodyPart.example?.body_text?.[0]?.[i];
    if (value) samples[`body.${n}`] = value;
  });
  named(bodyPart.example?.body_text_named_params, 'body');

  const buttons: TemplateButton[] = [];
  for (const b of parts.find((p) => type(p) === 'BUTTONS')?.buttons ?? []) {
    const index = buttons.length;
    const kind = b.type?.toUpperCase();
    if (kind === 'QUICK_REPLY' && b.text) {
      buttons.push({ type: 'QUICK_REPLY', text: b.text });
    } else if (kind === 'URL' && b.text && b.url) {
      buttons.push({ type: 'URL', text: b.text, url: b.url });
      const value = Array.isArray(b.example) ? b.example[0] : b.example;
      if (value && placeholdersIn(b.url).length) samples[`button.${index}.1`] = value;
    } else if (kind === 'PHONE_NUMBER' && b.text && b.phone_number) {
      buttons.push({ type: 'PHONE_NUMBER', text: b.text, phoneNumber: b.phone_number });
    } else if (kind === 'COPY_CODE') {
      const value = Array.isArray(b.example) ? b.example[0] : b.example;
      buttons.push({ type: 'COPY_CODE', example: value ?? '' });
    } else {
      // A button index must match Meta's, so one unknown button rules out the whole template.
      supported = false;
    }
  }

  return {
    definition: {
      header,
      body: bodyPart.text,
      footer: parts.find((p) => type(p) === 'FOOTER')?.text ?? null,
      buttons,
    },
    samples,
    supported,
  };
}

// ------------------------------------------------------------------ send payload

export interface TemplateSendParameter {
  type: 'text' | 'coupon_code';
  text?: string;
  parameterName?: string;
  extra?: Record<string, unknown>;
}

export interface TemplateSendComponent {
  type: 'header' | 'body' | 'button';
  subType?: 'url' | 'copy_code';
  index?: number;
  parameters: TemplateSendParameter[];
}

/** Meta refuses text parameters containing line breaks, tabs or long runs of spaces. */
export const cleanVariableValue = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Everything Meta needs at send time apart from a media header, added once it is uploaded. */
export function buildSendComponents(
  def: TemplateDefinition,
  values: Record<string, string>,
): TemplateSendComponent[] {
  const named = parameterFormatOf(def) === 'named';
  const param = (name: string, key: string): TemplateSendParameter => ({
    type: 'text',
    text: values[key] ?? '',
    ...(named ? { parameterName: name } : {}),
  });
  const out: TemplateSendComponent[] = [];
  const vars = templateVariables(def);
  const headerVars = vars.filter((v) => v.part === 'header');
  if (headerVars.length) {
    out.push({ type: 'header', parameters: headerVars.map((v) => param(v.name, v.key)) });
  }
  const bodyVars = vars.filter((v) => v.part === 'body');
  if (bodyVars.length) {
    out.push({ type: 'body', parameters: bodyVars.map((v) => param(v.name, v.key)) });
  }
  for (const v of vars.filter((x) => x.part === 'button')) {
    out.push({
      type: 'button',
      subType: v.subType,
      index: v.buttonIndex,
      parameters:
        v.subType === 'copy_code'
          ? [{ type: 'coupon_code', extra: { coupon_code: values[v.key] ?? '' } }]
          : [{ type: 'text', text: encodeURIComponent(values[v.key] ?? '') }],
    });
  }
  return out;
}
