/** The only module (with webhook.ts) allowed to import wapi-cloud. */
import { Whatsapp, type WhatsappResponse } from 'wapi-cloud';
import { type GatewayResult, mapError, result } from './errors';
import type {
  CreatedTemplate,
  CreateTemplateInput,
  DeleteTemplateInput,
  DownloadedMedia,
  ListTemplatesInput,
  MediaInfo,
  MessageTemplate,
  PhoneCredentials,
  PhoneInfo,
  SendInteractiveInput,
  SendMediaInput,
  SendOpts,
  SendTemplateInput,
  SendTextInput,
  SentMessage,
  TemplatePage,
  UpdateTemplateInput,
  UploadMediaInput,
  WabaInfo,
  WhatsAppGateway,
} from './gateway';
import { GraphClient, type GraphConfig } from './graph';

type SdkConfig = ConstructorParameters<typeof Whatsapp>[0];
type SdkTemplateInput = Parameters<Whatsapp['messages']['sendTemplate']>[1];
type SdkCreateTemplate = Parameters<Whatsapp['templates']['create']>[0];
type SdkUpdateTemplate = Parameters<Whatsapp['templates']['update']>[1];
type SdkTemplate = NonNullable<Awaited<ReturnType<Whatsapp['templates']['get']>>['data']>;

/** Convert the SDK's `{ data, error }` to our result, mapping errors to internal codes. */
function convert<T, U>(res: WhatsappResponse<T>, map: (data: T) => U): GatewayResult<U> {
  if (res.error) {
    return result.fail(
      mapError({
        message: res.error.message,
        code: res.error.code,
        httpStatus: res.error.httpStatus,
        fbtraceId: res.error.fbtraceId,
        isRetryable: res.error.isRetryable,
      }),
    );
  }
  if (res.data === null) {
    return result.fail(mapError({ message: 'Empty response from Meta', httpStatus: res.status }));
  }
  return result.ok(map(res.data));
}

const sent = (d: { messageId: string; waId: string }): SentMessage => ({
  messageId: d.messageId,
  waId: d.waId,
});

const toTemplate = (t: SdkTemplate): MessageTemplate => ({
  id: t.id,
  name: t.name,
  language: t.language,
  category: t.category,
  status: t.status,
  components: t.components as unknown as MessageTemplate['components'],
  rejectedReason: t.rejected_reason,
});

const toMediaInfo = (m: {
  id: string;
  mime_type: string;
  sha256: string;
  file_size: number;
}): MediaInfo => ({
  id: m.id,
  mimeType: m.mime_type,
  sha256: m.sha256,
  fileSize: m.file_size,
});

const sdkOpts = (opts?: SendOpts) => ({
  replyToMessageId: opts?.replyToMessageId,
  bizOpaqueCallbackData: opts?.callbackData,
});

export interface WapiGatewayOptions {
  phoneNumberId: string;
  credentials: PhoneCredentials;
  graph: GraphConfig;
}

export class WapiCloudGateway implements WhatsAppGateway {
  readonly phoneNumberId: string;
  readonly wabaId: string;
  private readonly sdk: Whatsapp;
  private readonly graph: GraphClient;
  private readonly token: string;

  constructor({ phoneNumberId, credentials, graph }: WapiGatewayOptions) {
    this.phoneNumberId = phoneNumberId;
    this.wabaId = credentials.wabaId;
    this.token = credentials.accessToken;
    this.graph = new GraphClient(graph);
    const config: SdkConfig = {
      accessToken: credentials.accessToken,
      phoneNumberId,
      businessAccountId: credentials.wabaId,
      apiVersion: graph.apiVersion,
      baseUrl: graph.baseUrl,
      fetch: graph.fetch,
      timeoutMs: graph.timeoutMs,
      // BullMQ owns retries, so a job's attempts and backoff are the only retry policy.
      maxRetries: 0,
    };
    this.sdk = new Whatsapp(config);
  }

  async sendText(to: string, input: SendTextInput, opts?: SendOpts) {
    const res = await this.sdk.messages.sendText(
      to,
      { body: input.body, previewUrl: input.previewUrl },
      sdkOpts(opts),
    );
    return convert(res, sent);
  }

  async sendTemplate(to: string, input: SendTemplateInput, opts?: SendOpts) {
    const components = input.components?.map((c) => ({
      type: c.type,
      sub_type: c.subType,
      index: c.index,
      parameters: c.parameters.map((p) => ({
        type: p.type,
        text: p.text,
        parameter_name: p.parameterName,
        ...p.extra,
      })),
    })) as SdkTemplateInput['components'];
    const res = await this.sdk.messages.sendTemplate(
      to,
      { name: input.name, language: input.language, components },
      sdkOpts(opts),
    );
    return convert(res, sent);
  }

  async sendMedia(to: string, input: SendMediaInput, opts?: SendOpts) {
    const ref = {
      mediaId: input.mediaId,
      link: input.link,
      caption: input.caption,
      filename: input.filename,
    };
    const m = this.sdk.messages;
    const o = sdkOpts(opts);
    const res = await {
      image: () => m.sendImage(to, ref, o),
      video: () => m.sendVideo(to, ref, o),
      audio: () => m.sendAudio(to, ref, o),
      document: () => m.sendDocument(to, ref, o),
      sticker: () => m.sendSticker(to, ref, o),
    }[input.kind]();
    return convert(res, sent);
  }

  async sendInteractive(to: string, input: SendInteractiveInput, opts?: SendOpts) {
    return convert(await this.sdk.messages.sendInteractive(to, input, sdkOpts(opts)), sent);
  }

  /** Through Graph directly: the SDK cannot ask for rejection reasons and quality scores. */
  listTemplates(params?: ListTemplatesInput): Promise<GatewayResult<TemplatePage>> {
    return this.graph.listTemplates(this.wabaId, this.token, params);
  }

  async getTemplate(templateId: string) {
    return convert(await this.sdk.templates.get(templateId), toTemplate);
  }

  async createTemplate(input: CreateTemplateInput): Promise<GatewayResult<CreatedTemplate>> {
    const res = await this.sdk.templates.create({
      name: input.name,
      language: input.language,
      category: input.category,
      components: input.components,
      parameter_format: input.parameterFormat,
    } as unknown as SdkCreateTemplate);
    return convert(res, (d) => ({ id: d.id, status: d.status, category: d.category }));
  }

  async updateTemplate(templateId: string, patch: UpdateTemplateInput) {
    const res = await this.sdk.templates.update(templateId, {
      ...(patch.category ? { category: patch.category } : {}),
      ...(patch.components ? { components: patch.components } : {}),
      ...(patch.parameterFormat ? { parameter_format: patch.parameterFormat } : {}),
    } as unknown as SdkUpdateTemplate);
    return convert(res, (d) => d);
  }

  deleteTemplate(input: DeleteTemplateInput) {
    return this.graph.deleteTemplate(this.wabaId, input, this.token);
  }

  uploadTemplateSample(input: UploadMediaInput) {
    return this.graph.uploadTemplateSample(input, this.token);
  }

  async uploadMedia(input: UploadMediaInput) {
    const res = await this.sdk.media.upload(input.bytes, {
      type: input.mimeType,
      filename: input.filename,
    });
    return convert(res, (d) => ({ mediaId: d.id }));
  }

  async getMediaInfo(mediaId: string) {
    return convert(await this.sdk.media.get(mediaId), toMediaInfo);
  }

  async downloadMedia(mediaId: string): Promise<GatewayResult<DownloadedMedia>> {
    const info = await this.getMediaInfo(mediaId);
    if (info.error) return info;
    const res = await this.sdk.media.download(mediaId);
    return convert(res, (bytes) => ({ ...info.data, bytes: Buffer.from(bytes) }));
  }

  getPhoneInfo(): Promise<GatewayResult<PhoneInfo>> {
    return this.graph.getPhoneNumber(this.phoneNumberId, this.token);
  }

  getWabaInfo(): Promise<GatewayResult<WabaInfo>> {
    return this.graph.getWaba(this.wabaId, this.token);
  }

  async register(pin: string) {
    return convert(await this.sdk.phoneNumbers.register({ pin }), (d) => d);
  }
}
