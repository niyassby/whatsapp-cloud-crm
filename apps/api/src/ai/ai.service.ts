import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AiProviderError,
  type AiProviders,
  knowledgeReply,
  rewriteText,
  summarizeConversation,
} from '@wacrm/ai';
import {
  aiLogToDto,
  chargeAi,
  getAiSettings,
  knowledgeDocumentToDto,
  searchKnowledge,
  type TenantTx,
  writeAiLog,
} from '@wacrm/db';
import {
  type AiKind,
  type AiLogDto,
  type AiSettingsDto,
  type AiSuggestionDto,
  type AiTextDto,
  AppError,
  type CreateKnowledgeTextInput,
  type CursorPage,
  ErrorCode,
  KNOWLEDGE_MAX_DOCUMENTS,
  KNOWLEDGE_MAX_FILE_BYTES,
  KNOWLEDGE_MIME_TYPES,
  KNOWLEDGE_TOP_K,
  type KnowledgeDocumentDto,
  type KnowledgeHitDto,
  type ListAiLogQuery,
  type RewriteInput,
  type UpdateAiSettingsInput,
} from '@wacrm/shared';
import type { ObjectStorage } from '@wacrm/shared/server';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { PrismaService } from '../db/prisma.service';
import { OBJECT_STORAGE } from '../infra/infra.tokens';
import { QueuesService } from '../infra/queues.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { AI_PROVIDERS } from './ai.tokens';

export interface AiActor {
  userId: string;
  orgId: string;
  meta?: RequestMeta;
}

/**
 * Settings, the knowledge base and the inbox assistant. Provider calls happen outside any
 * transaction; the log entry and the charge are written together afterwards. A failed call is
 * logged and charges nothing.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queues: QueuesService,
    private readonly realtime: RealtimeGateway,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(AI_PROVIDERS) private readonly ai: AiProviders,
  ) {}

  // ------------------------------------------------------------------ settings

  async settings(): Promise<AiSettingsDto> {
    const s = await this.db.run((tx) => getAiSettings(tx));
    return {
      ...s,
      available: { chat: Boolean(this.ai.chat), knowledge: Boolean(this.ai.embeddings) },
      model: this.ai.chat?.model ?? null,
    };
  }

  async updateSettings(actor: AiActor, input: UpdateAiSettingsInput): Promise<AiSettingsDto> {
    await this.db.run(async (tx) => {
      const current = await getAiSettings(tx);
      const next = { ...current, ...input };
      await tx.aiSettings.upsert({
        where: { orgId: actor.orgId },
        create: { orgId: actor.orgId, ...next, updatedById: actor.userId },
        update: { ...next, updatedById: actor.userId },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.AI_CHANGED,
        actorUserId: actor.userId,
        targetType: 'ai_settings',
        targetId: actor.orgId,
        // What changed, not the instructions' text.
        metadata: Object.fromEntries(
          Object.entries(input).map(([k, v]) => [k, k === 'instructions' ? 'changed' : v]),
        ),
        meta: actor.meta,
      });
    });
    return this.settings();
  }

  /** Chat configured, AI on, and for the inbox, its assist switch on. */
  private async assertUsable(feature: 'inbox' | 'any'): Promise<void> {
    if (!this.ai.chat) {
      throw new AppError(ErrorCode.AI_NOT_AVAILABLE, 'AI is not set up on this installation');
    }
    const s = await this.db.run((tx) => getAiSettings(tx));
    if (!s.enabled) {
      throw new AppError(ErrorCode.AI_NOT_AVAILABLE, 'AI is turned off for this workspace');
    }
    if (feature === 'inbox' && !s.inboxAssist) {
      throw new AppError(ErrorCode.AI_NOT_AVAILABLE, 'AI help in the inbox is turned off');
    }
  }

  // ------------------------------------------------------------------ knowledge base

  async listDocuments(): Promise<KnowledgeDocumentDto[]> {
    const rows = await this.db.run((tx) =>
      tx.knowledgeDocument.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: KNOWLEDGE_MAX_DOCUMENTS,
      }),
    );
    return rows.map(knowledgeDocumentToDto);
  }

  async addText(actor: AiActor, input: CreateKnowledgeTextInput): Promise<KnowledgeDocumentDto> {
    return this.addDocument(actor, {
      title: input.title,
      source: 'text',
      mimeType: 'text/plain',
      bytes: Buffer.from(input.content, 'utf8'),
    });
  }

  async upload(
    actor: AiActor,
    file: { bytes: Buffer; mimeType: string; filename: string | null },
  ): Promise<KnowledgeDocumentDto> {
    const byExtension = Object.entries(KNOWLEDGE_MIME_TYPES).find(([, ext]) =>
      file.filename?.toLowerCase().endsWith(ext),
    )?.[0];
    const mimeType = KNOWLEDGE_MIME_TYPES[file.mimeType] ? file.mimeType : byExtension;
    if (!mimeType) {
      throw new AppError(
        ErrorCode.KNOWLEDGE_INVALID,
        'Upload a text file: .txt, .md, .csv or .json. PDF and Word files are not read yet.',
      );
    }
    if (file.bytes.length > KNOWLEDGE_MAX_FILE_BYTES) {
      throw new AppError(ErrorCode.KNOWLEDGE_INVALID, 'Files can be up to 5 MB');
    }
    const text = file.bytes.toString('utf8');
    if (text.includes('\u0000') || text.includes('�')) {
      throw new AppError(ErrorCode.KNOWLEDGE_INVALID, 'This file is not readable text (UTF-8)');
    }
    return this.addDocument(actor, {
      title: (file.filename ?? 'Document').replace(/\.[a-z0-9]+$/i, '').slice(0, 200) || 'Document',
      source: 'upload',
      mimeType,
      bytes: file.bytes,
    });
  }

  private async addDocument(
    actor: AiActor,
    doc: { title: string; source: 'text' | 'upload'; mimeType: string; bytes: Buffer },
  ): Promise<KnowledgeDocumentDto> {
    if (!this.ai.embeddings) {
      throw new AppError(
        ErrorCode.AI_NOT_AVAILABLE,
        'The knowledge base is not set up on this installation',
      );
    }
    const id = randomUUID();
    const fileKey = `orgs/${actor.orgId}/knowledge/${id}`;
    // Stored before the row, so a row never points at a missing file.
    await this.storage.put(fileKey, doc.bytes, doc.mimeType);
    const row = await this.db.run(async (tx) => {
      const count = await tx.knowledgeDocument.count({ where: { deletedAt: null } });
      if (count >= KNOWLEDGE_MAX_DOCUMENTS) {
        throw new AppError(
          ErrorCode.KNOWLEDGE_INVALID,
          `A workspace can have up to ${KNOWLEDGE_MAX_DOCUMENTS} documents`,
        );
      }
      const created = await tx.knowledgeDocument.create({
        data: {
          id,
          orgId: actor.orgId,
          title: doc.title,
          source: doc.source,
          mimeType: doc.mimeType,
          sizeBytes: doc.bytes.length,
          fileKey,
          createdById: actor.userId,
        },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.AI_CHANGED,
        actorUserId: actor.userId,
        targetType: 'knowledge_document',
        targetId: id,
        metadata: { change: 'added', title: doc.title },
        meta: actor.meta,
      });
      return created;
    });
    await this.queueIndex(actor.orgId, id);
    return knowledgeDocumentToDto(row);
  }

  private async queueIndex(orgId: string, documentId: string): Promise<void> {
    try {
      await this.queues.enqueueAiJob({ kind: 'index', orgId, documentId });
    } catch (err) {
      this.logger.error(`could not queue indexing: ${String(err)}`);
      await this.db.run((tx) =>
        tx.knowledgeDocument.update({
          where: { id: documentId },
          data: { status: 'failed', error: 'Could not start indexing; try again' },
        }),
      );
    }
    this.realtime.emit(orgId, 'knowledge:updated', { documentId });
  }

  private async loadDocument(tx: TenantTx, id: string) {
    const row = await tx.knowledgeDocument.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Document not found');
    return row;
  }

  async reindex(actor: AiActor, id: string): Promise<KnowledgeDocumentDto> {
    const row = await this.db.run(async (tx) => {
      await this.loadDocument(tx, id);
      return tx.knowledgeDocument.update({
        where: { id },
        data: { status: 'pending', error: null },
      });
    });
    await this.queueIndex(actor.orgId, id);
    return knowledgeDocumentToDto(row);
  }

  /** The document stops being searched at once; its passages go with it. */
  async deleteDocument(actor: AiActor, id: string): Promise<void> {
    await this.db.run(async (tx) => {
      const doc = await this.loadDocument(tx, id);
      await tx.knowledgeChunk.deleteMany({ where: { documentId: id } });
      await tx.knowledgeDocument.update({
        where: { id },
        data: { deletedAt: new Date(), chunkCount: 0 },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.AI_CHANGED,
        actorUserId: actor.userId,
        targetType: 'knowledge_document',
        targetId: id,
        metadata: { change: 'deleted', title: doc.title },
        meta: actor.meta,
      });
    });
    this.realtime.emit(actor.orgId, 'knowledge:updated', { documentId: id });
  }

  /** Try the knowledge base: the passages a question would find. Not charged; not logged. */
  async search(actor: AiActor, query: string): Promise<KnowledgeHitDto[]> {
    if (!this.ai.embeddings) {
      throw new AppError(ErrorCode.AI_NOT_AVAILABLE, 'The knowledge base is not set up');
    }
    const embedded = await this.ai.embeddings.embed([query], 'query').catch((err: unknown) => {
      throw providerError(err);
    });
    return this.db.run((tx) =>
      searchKnowledge(tx, {
        orgId: actor.orgId,
        vector: embedded.vectors[0]!,
        model: this.ai.embeddings!.model,
        limit: KNOWLEDGE_TOP_K,
      }),
    );
  }

  // ------------------------------------------------------------------ inbox assist

  private async ensureConversation(id: string): Promise<void> {
    const found = await this.db.run((tx) =>
      tx.conversation.findUnique({ where: { id }, select: { id: true } }),
    );
    if (!found) throw new AppError(ErrorCode.NOT_FOUND, 'Conversation not found');
  }

  /** A failed call is logged with no cost, then reported. */
  private async logFailure(
    actor: AiActor,
    kind: AiKind,
    conversationId: string | null,
    input: string,
    err: unknown,
  ): Promise<never> {
    const error = providerError(err);
    await this.db
      .run((tx) =>
        writeAiLog(tx, {
          orgId: actor.orgId,
          kind,
          status: 'failed',
          model: this.ai.chat?.model ?? 'none',
          conversationId,
          userId: actor.userId,
          input,
          output: '',
          inputTokens: 0,
          outputTokens: 0,
          error: error.message,
        }),
      )
      .catch(() => undefined);
    throw error;
  }

  async suggest(actor: AiActor, conversationId: string): Promise<AiSuggestionDto> {
    await this.assertUsable('inbox');
    await this.ensureConversation(conversationId);
    const instructions = (await this.db.run((tx) => getAiSettings(tx))).instructions;
    let reply;
    try {
      reply = await knowledgeReply(this.prisma.client, this.ai, {
        orgId: actor.orgId,
        conversationId,
        instructions: [instructions],
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      return this.logFailure(actor, 'suggestion', conversationId, '', err);
    }
    const logId = randomUUID();
    await this.db.run(async (tx) => {
      const cost = await chargeAi(tx, { orgId: actor.orgId, logId, usage: reply.usage });
      await writeAiLog(tx, {
        id: logId,
        orgId: actor.orgId,
        kind: 'suggestion',
        status: reply.refused ? 'refused' : reply.answer ? 'answered' : 'handoff',
        model: reply.model,
        conversationId,
        userId: actor.userId,
        input: reply.question,
        output: reply.answer,
        confidence: reply.confidence,
        sources: reply.sources,
        inputTokens: reply.usage.inputTokens,
        outputTokens: reply.usage.outputTokens,
        costMicros: cost,
      });
    });
    this.realtime.emit(actor.orgId, 'wallet:updated', {});
    return {
      text: reply.answer,
      confidence: reply.confidence,
      sources: reply.sources,
      note: reply.refused
        ? 'The assistant would not answer this one.'
        : !reply.answer
          ? (reply.handoffReason ?? 'The knowledge base does not cover this.')
          : reply.handoffReason,
      logId,
    };
  }

  async summarize(actor: AiActor, conversationId: string): Promise<AiTextDto> {
    await this.assertUsable('inbox');
    await this.ensureConversation(conversationId);
    let r;
    try {
      r = await summarizeConversation(this.prisma.client, this.ai, {
        orgId: actor.orgId,
        conversationId,
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      return this.logFailure(actor, 'summary', conversationId, '', err);
    }
    const logId = await this.record(actor, 'summary', conversationId, r.input, r);
    return { text: r.text, logId };
  }

  async rewrite(actor: AiActor, input: RewriteInput): Promise<AiTextDto> {
    await this.assertUsable('inbox');
    let r;
    try {
      r = await rewriteText(this.prisma.client, this.ai, { orgId: actor.orgId, ...input });
    } catch (err) {
      if (err instanceof AppError) throw err;
      return this.logFailure(actor, 'rewrite', null, input.text, err);
    }
    const logId = await this.record(actor, 'rewrite', null, `${input.tone}: ${input.text}`, r);
    return { text: r.text, logId };
  }

  private async record(
    actor: AiActor,
    kind: AiKind,
    conversationId: string | null,
    input: string,
    r: {
      text: string;
      refused: boolean;
      model: string;
      usage: { inputTokens: number; outputTokens: number; embeddingTokens: number };
    },
  ): Promise<string> {
    const logId = randomUUID();
    await this.db.run(async (tx) => {
      const cost = await chargeAi(tx, { orgId: actor.orgId, logId, usage: r.usage });
      await writeAiLog(tx, {
        id: logId,
        orgId: actor.orgId,
        kind,
        status: r.refused ? 'refused' : 'answered',
        model: r.model,
        conversationId,
        userId: actor.userId,
        input,
        output: r.text,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        costMicros: cost,
      });
    });
    this.realtime.emit(actor.orgId, 'wallet:updated', {});
    if (r.refused) {
      throw new AppError(ErrorCode.AI_PROVIDER_ERROR, 'The assistant would not do this one');
    }
    return logId;
  }

  // ------------------------------------------------------------------ the log

  async log(query: ListAiLogQuery): Promise<CursorPage<AiLogDto>> {
    const rows = await this.db.run((tx) =>
      tx.aiLog.findMany({
        where: query.kind ? { kind: query.kind } : {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    );
    const items = rows.slice(0, query.limit).map(aiLogToDto);
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }
}

function providerError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const msg = err instanceof AiProviderError ? err.message : 'The AI request failed';
  return new AppError(ErrorCode.AI_PROVIDER_ERROR, msg);
}
