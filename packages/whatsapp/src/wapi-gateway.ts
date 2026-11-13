/** The only module (with webhook.ts) allowed to import wapi-cloud. */
import { Whatsapp, type WhatsappResponse } from 'wapi-cloud';
import { type GatewayResult, mapError, result } from './errors';
import type {
  CallingSettings,
  CallPermission,
  CreateGroupGatewayInput,
  CreatedTemplate,
  CreateTemplateInput,
  DeleteTemplateInput,
  DownloadedMedia,
  GroupInfo,
  GroupJoinRequest,
  ListTemplatesInput,
  MediaInfo,
  MessageTemplate,
  PhoneCredentials,
  PhoneInfo,
  ProductPage,
  QrCodeInfo,
  SendInteractiveInput,
  SendMediaInput,
  SendOpts,
  SendProductsGatewayInput,
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

  // ---------------------------------------------------------------- QR codes and short links

  async createQrCode(prefilledMessage: string): Promise<GatewayResult<QrCodeInfo>> {
    return convert(await this.sdk.qrCodes.create({ prefilledMessage }), toQr);
  }

  async updateQrCode(code: string, prefilledMessage: string): Promise<GatewayResult<QrCodeInfo>> {
    return convert(await this.sdk.qrCodes.update(code, { prefilledMessage }), toQr);
  }

  async deleteQrCode(code: string) {
    return convert(await this.sdk.qrCodes.delete(code), (d) => ({ success: d.success }));
  }

  // ---------------------------------------------------------------- catalog

  async getConnectedCatalog() {
    const res = await this.sdk.catalogs.listConnectedToWaba(this.wabaId);
    return convert(res, (d) => {
      const first = d.data[0];
      return first ? { id: first.id, name: first.name } : null;
    });
  }

  async listProducts(catalogId: string, after?: string): Promise<GatewayResult<ProductPage>> {
    const res = await this.sdk.products.list(catalogId, { limit: 100, after });
    return convert(res, (d) => ({
      items: d.items.map((p) => ({
        retailerId: p.retailer_id,
        name: p.name,
        description: p.description ?? null,
        price: p.price ?? null,
        currency: p.currency ?? null,
        imageUrl: p.image_url ?? null,
        availability: p.availability ?? null,
      })),
      nextCursor: d.pageInfo.hasNext ? d.pageInfo.nextCursor : undefined,
    }));
  }

  async sendProducts(to: string, input: SendProductsGatewayInput, opts?: SendOpts) {
    const m = this.sdk.messages;
    const o = sdkOpts(opts);
    if (input.kind === 'product') {
      const res = await m.sendProduct(
        to,
        { catalogId: input.catalogId, productRetailerId: input.retailerId, body: input.body },
        o,
      );
      return convert(res, sent);
    }
    if (input.kind === 'product_list') {
      const res = await m.sendProductList(
        to,
        {
          catalogId: input.catalogId,
          header: input.header,
          body: input.body,
          sections: input.sections.map((s) => ({
            title: s.title,
            productRetailerIds: s.retailerIds,
          })),
        },
        o,
      );
      return convert(res, sent);
    }
    const res = await m.sendCatalog(
      to,
      { body: input.body, thumbnailProductRetailerId: input.thumbnailRetailerId },
      o,
    );
    return convert(res, sent);
  }

  // ---------------------------------------------------------------- groups

  async createGroup(input: CreateGroupGatewayInput) {
    const res = await this.sdk.groups.create({
      subject: input.subject,
      description: input.description,
      joinApprovalMode: input.joinApprovalMode,
    });
    return convert(res, (d) => ({ groupId: typeof d.id === 'string' ? d.id : null }));
  }

  async getGroup(groupId: string): Promise<GatewayResult<GroupInfo>> {
    const res = await this.sdk.groups.get(groupId, [
      'subject',
      'description',
      'total_participant_count',
      'join_approval_mode',
    ]);
    return convert(res, (g) => ({
      id: g.id,
      subject: g.subject ?? null,
      description: g.description ?? null,
      participantCount: g.total_participant_count ?? null,
      joinApprovalMode: g.join_approval_mode ?? null,
    }));
  }

  async getGroupInviteLink(groupId: string) {
    return convert(await this.sdk.groups.getInviteLink(groupId), (d) => ({
      inviteLink: d.invite_link,
    }));
  }

  async listGroupJoinRequests(groupId: string): Promise<GatewayResult<GroupJoinRequest[]>> {
    return convert(await this.sdk.groups.listJoinRequests(groupId), (d) =>
      d.data.map((r) => ({
        id: r.join_request_id,
        waId: r.wa_id ?? null,
        requestedAt: new Date(Number(r.creation_timestamp) * 1000),
      })),
    );
  }

  async answerGroupJoinRequests(groupId: string, input: { approve: string[]; reject: string[] }) {
    if (input.approve.length) {
      const res = await this.sdk.groups.approveJoinRequests(groupId, input.approve);
      if (res.error) return convert(res, () => ({ success: false }));
    }
    if (input.reject.length) {
      const res = await this.sdk.groups.rejectJoinRequests(groupId, input.reject);
      if (res.error) return convert(res, () => ({ success: false }));
    }
    return result.ok({ success: true });
  }

  async removeGroupParticipants(groupId: string, users: string[]) {
    return convert(await this.sdk.groups.removeParticipants(groupId, users), (d) => ({
      success: d.success !== false,
    }));
  }

  async deleteGroup(groupId: string) {
    return convert(await this.sdk.groups.delete(groupId), (d) => ({
      success: d.success !== false,
    }));
  }

  async sendGroupText(groupId: string, body: string, opts?: SendOpts) {
    const res = await this.sdk.messages.sendText(
      groupId,
      { body },
      { ...sdkOpts(opts), recipientType: 'group' },
    );
    return convert(res, sent);
  }

  // ---------------------------------------------------------------- calling

  async getCallingSettings(): Promise<GatewayResult<CallingSettings>> {
    return convert(await this.sdk.calls.getSettings(), (s) => ({
      enabled: s.status === 'ENABLED',
      iconVisible: s.call_icon_visibility !== 'DISABLE_ALL',
      callbackPermission: s.callback_permission_status === 'ENABLED',
    }));
  }

  async updateCallingSettings(settings: CallingSettings) {
    const res = await this.sdk.calls.updateSettings({
      status: settings.enabled ? 'ENABLED' : 'DISABLED',
      call_icon_visibility: settings.iconVisible ? 'DEFAULT' : 'DISABLE_ALL',
      callback_permission_status: settings.callbackPermission ? 'ENABLED' : 'DISABLED',
    });
    return convert(res, (d) => ({ success: d.success }));
  }

  async getCallPermission(waId: string): Promise<GatewayResult<CallPermission>> {
    return convert(await this.sdk.calls.getPermission(waId), (p) => ({
      status: p.permission.status,
      canCall: p.actions.some((a) => a.action_name === 'start_call' && a.can_perform_action),
      canRequest: p.actions.some(
        (a) => a.action_name === 'send_call_permission_request' && a.can_perform_action,
      ),
    }));
  }

  async sendCallPermissionRequest(to: string, body: string, opts?: SendOpts) {
    const res = await this.sdk.messages.sendCallPermissionRequest(
      to,
      { bodyText: body },
      sdkOpts(opts),
    );
    return convert(res, sent);
  }

  async connectCall(to: string, sdpOffer: string, callbackData?: string) {
    const res = await this.sdk.calls.connect(
      to,
      { sdp: sdpOffer, sdpType: 'offer' },
      { bizOpaqueCallbackData: callbackData },
    );
    return convert(res, (d) => ({ callId: d.calls[0]?.id ?? '' }));
  }

  async acceptCall(callId: string, sdpAnswer: string) {
    const session = { sdpType: 'answer' as const, sdp: sdpAnswer };
    // Pre-accept lets media start as soon as the call is accepted.
    const pre = await this.sdk.calls.preAccept(callId, session);
    if (pre.error) return convert(pre, (d) => ({ success: d.success }));
    return convert(await this.sdk.calls.accept(callId, session), (d) => ({ success: d.success }));
  }

  async rejectCall(callId: string) {
    return convert(await this.sdk.calls.reject(callId), (d) => ({ success: d.success }));
  }

  async terminateCall(callId: string) {
    return convert(await this.sdk.calls.terminate(callId), (d) => ({ success: d.success }));
  }
}

const toQr = (q: {
  code: string;
  prefilled_message: string;
  deep_link_url: string;
}): QrCodeInfo => ({
  code: q.code,
  prefilledMessage: q.prefilled_message,
  deepLinkUrl: q.deep_link_url,
});
