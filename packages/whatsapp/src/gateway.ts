import type { GatewayResult } from './errors';

/**
 * The only WhatsApp surface the rest of the app sees. One gateway is bound to one phone
 * number (and its WABA + token); get instances from WhatsAppClientFactory.
 * Methods never throw for API failures: check `error`, and if `error.retryable` throw inside
 * the BullMQ job so it retries.
 */
export interface WhatsAppGateway {
  readonly phoneNumberId: string;
  readonly wabaId: string;

  // ---------------------------------------------------------------- sending
  sendText(to: string, input: SendTextInput, opts?: SendOpts): Promise<GatewayResult<SentMessage>>;
  sendTemplate(
    to: string,
    input: SendTemplateInput,
    opts?: SendOpts,
  ): Promise<GatewayResult<SentMessage>>;
  sendMedia(
    to: string,
    input: SendMediaInput,
    opts?: SendOpts,
  ): Promise<GatewayResult<SentMessage>>;
  sendInteractive(
    to: string,
    input: SendInteractiveInput,
    opts?: SendOpts,
  ): Promise<GatewayResult<SentMessage>>;

  // ---------------------------------------------------------------- templates (WABA level)
  listTemplates(params?: ListTemplatesInput): Promise<GatewayResult<TemplatePage>>;
  getTemplate(templateId: string): Promise<GatewayResult<MessageTemplate>>;
  createTemplate(input: CreateTemplateInput): Promise<GatewayResult<CreatedTemplate>>;
  updateTemplate(
    templateId: string,
    patch: UpdateTemplateInput,
  ): Promise<GatewayResult<{ success: boolean }>>;
  /** Deletes one language of a template. Meta's name-only form would delete all of them. */
  deleteTemplate(input: DeleteTemplateInput): Promise<GatewayResult<{ success: boolean }>>;
  /** Upload a media header sample for review. Returns the handle Meta asks for on create. */
  uploadTemplateSample(input: UploadMediaInput): Promise<GatewayResult<{ handle: string }>>;

  // ---------------------------------------------------------------- media
  uploadMedia(input: UploadMediaInput): Promise<GatewayResult<{ mediaId: string }>>;
  getMediaInfo(mediaId: string): Promise<GatewayResult<MediaInfo>>;
  /** Meta's URLs expire: always copy the bytes to object storage in a background job. */
  downloadMedia(mediaId: string): Promise<GatewayResult<DownloadedMedia>>;

  // ---------------------------------------------------------------- account
  getPhoneInfo(): Promise<GatewayResult<PhoneInfo>>;
  getWabaInfo(): Promise<GatewayResult<WabaInfo>>;
  register(pin: string): Promise<GatewayResult<{ success: boolean }>>;
}

export interface SendOpts {
  /** Quote this inbound message. */
  replyToMessageId?: string;
  /** Echoed back on status webhooks. Used to correlate sends (max 512 chars). */
  callbackData?: string;
}

export interface SentMessage {
  /** wamid */
  messageId: string;
  /** Recipient wa_id; empty when Meta only returned a business-scoped user id. */
  waId: string;
}

export interface SendTextInput {
  body: string;
  previewUrl?: boolean;
}

export interface TemplateParameter {
  type:
    'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video' | 'payload' | 'coupon_code';
  text?: string;
  /** Required for templates created with named parameters. */
  parameterName?: string;
  /** Extra Graph fields for non-text parameters (image, currency, ...). */
  extra?: Record<string, unknown>;
}

export interface TemplateComponentInput {
  type: 'header' | 'body' | 'button';
  subType?: 'quick_reply' | 'url' | 'copy_code';
  index?: number;
  parameters: TemplateParameter[];
}

export interface SendTemplateInput {
  name: string;
  language: string;
  components?: TemplateComponentInput[];
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export interface SendMediaInput {
  kind: MediaKind;
  /** Exactly one of mediaId or link. */
  mediaId?: string;
  link?: string;
  caption?: string;
  filename?: string;
}

export type SendInteractiveInput =
  | {
      type: 'button';
      body: string;
      header?: string;
      footer?: string;
      buttons: { id: string; title: string }[];
    }
  | {
      type: 'list';
      body: string;
      header?: string;
      footer?: string;
      buttonText: string;
      sections: {
        title?: string;
        rows: { id: string; title: string; description?: string }[];
      }[];
    }
  | {
      type: 'cta_url';
      body: string;
      header?: string;
      footer?: string;
      displayText: string;
      url: string;
    };

export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

/** Component definitions pass through as Meta defines them; Section 2 adds Zod schemas. */
export type TemplateComponentDefinition = Record<string, unknown>;

export interface MessageTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: TemplateComponentDefinition[];
  rejectedReason?: string;
  qualityScore?: string;
  parameterFormat?: string;
}

export interface ListTemplatesInput {
  limit?: number;
  after?: string;
  status?: string;
  name?: string;
}

export interface TemplatePage {
  items: MessageTemplate[];
  nextCursor?: string;
}

export interface CreateTemplateInput {
  name: string;
  language: string;
  category: TemplateCategory;
  components: TemplateComponentDefinition[];
  parameterFormat?: 'positional' | 'named';
}

export interface CreatedTemplate {
  id: string;
  status: string;
  category: string;
}

export interface UpdateTemplateInput {
  category?: TemplateCategory;
  components?: TemplateComponentDefinition[];
  parameterFormat?: 'positional' | 'named';
}

export interface DeleteTemplateInput {
  name: string;
  templateId: string;
}

export interface UploadMediaInput {
  bytes: Buffer;
  mimeType: string;
  filename?: string;
}

export interface MediaInfo {
  id: string;
  mimeType: string;
  sha256: string;
  fileSize: number;
}

export interface DownloadedMedia extends MediaInfo {
  bytes: Buffer;
}

export interface PhoneInfo {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  /** e.g. TIER_250. Stored as a string: Meta's tiers change, so nothing branches on the enum. */
  messagingTier: string | null;
  codeVerificationStatus: string | null;
  nameStatus: string | null;
  platformType: string | null;
  status: string | null;
}

export interface WabaInfo {
  id: string;
  name: string | null;
  currency: string | null;
  timezoneId: string | null;
  templateNamespace: string | null;
}

export interface PhoneCredentials {
  accessToken: string;
  wabaId: string;
}
