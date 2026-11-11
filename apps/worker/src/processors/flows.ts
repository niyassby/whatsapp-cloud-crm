/**
 * The flow engine. A run moves one node at a time; each node's work, the pointer move and the
 * history row commit in one transaction under a row lock, so a crash or a second worker resumes at
 * exactly the node that had not finished. Waits (a delay, a question) park the run with `wake_at`;
 * a delayed job wakes it on time and the `flow-tick` schedule catches anything a lost job missed.
 *
 * Calls that leave the database (HTTP, connectors, AI) run between two transactions, so no
 * connection is held while they wait. A crash between the call and the commit repeats the call:
 * those steps are at least once.
 */
import { randomUUID } from 'node:crypto';
import {
  chargeMessage,
  conversationInclude,
  conversationToDto,
  messageInclude,
  messageToDto,
  Prisma,
  type TenantTx,
  withTenant,
} from '@wacrm/db';
import {
  ACTIVE_FLOW_RUN_STATUSES,
  AppError,
  buildSendComponents,
  canReceiveMarketing,
  checkAnswer,
  choiceHandle,
  chooseBranch,
  cleanVariableValue,
  coerceFieldValue,
  type DefaultAssignment,
  delayMinutes,
  edgeTarget,
  ErrorCode,
  FLOW_DEFAULT_WAIT_MINUTES,
  FLOW_HTTP_MAX_BODY,
  FLOW_HTTP_TIMEOUT_MS,
  FLOW_MAX_STARTS_PER_HOUR,
  FLOW_MAX_STEPS_PER_RUN,
  FLOW_MAX_STEPS_WITHOUT_WAIT,
  type BusinessHours,
  type FlowDefinition,
  flowDefinitionSchema,
  type FlowEvent,
  type FlowJob,
  type FlowNode,
  type FlowReply,
  type FlowRunStatus,
  type FlowScope,
  type FlowTrigger,
  flowTriggerSchema,
  headerMediaKind,
  interpolate,
  isMarketingCategory,
  isWithinBusinessHours,
  type MediaHeaderFormat,
  MESSAGE_TRIGGER_ORDER,
  messageMatchesTrigger,
  messagePreview,
  readPath,
  renderedText,
  renderTemplate,
  templateDefinitionSchema,
  templateVariables,
} from '@wacrm/shared';
import { countryOfWaId } from '@wacrm/shared/server';
import type { SendInteractiveInput } from '@wacrm/whatsapp';
import type { WorkerDeps } from '../deps';
import { chooseAgent } from './automation';
import { runConnectorAction } from './integrations';

const MINUTE_MS = 60_000;
/** A run still `running` this long after its last change lost its job, and is picked up again. */
const STALLED_MS = 60_000;

// ------------------------------------------------------------------ types

interface Awaiting {
  nodeId: string;
  kind: 'reply' | 'timer';
  attempts: number;
}

type RunInput = { kind: 'reply'; reply: FlowReply } | { kind: 'timeout' };

/** A node failed in a way its flow should hear about: its failure exit, or the flow's onError. */
export class FlowNodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowNodeError';
  }
}

type Detail = Record<string, unknown>;

type Outcome =
  | { kind: 'go'; handle: string; vars?: Record<string, unknown>; detail?: Detail }
  | {
      kind: 'wait';
      waitKind: 'reply' | 'timer';
      minutes: number;
      attempts?: number;
      detail?: Detail;
    }
  | {
      kind: 'end';
      status: 'completed' | 'failed' | 'cancelled';
      reason: string;
      error?: string;
      detail?: Detail;
    };

/** What happened inside a transaction, done after it commits. */
interface Effects {
  queued: { messageId: string; createdAt: Date }[];
  conversationId: string | null;
  conversationChanged: boolean;
  notify: string[];
  events: FlowEvent[];
  advance: string[];
  /** A template was charged, so the wallet changed. */
  charged: boolean;
  /** The step being tried, so a failure is recorded against it and nothing newer. */
  at: { steps: number; nodeId: string } | null;
  wake: { runId: string; at: Date } | null;
}

const noEffects = (): Effects => ({
  queued: [],
  conversationId: null,
  conversationChanged: false,
  notify: [],
  events: [],
  advance: [],
  charged: false,
  at: null,
  wake: null,
});

/** The result of a call outside the database, applied by the next transaction. */
type External =
  | { kind: 'http'; ok: boolean; status: number; body: string; json: unknown; error?: string }
  | { kind: 'integration'; ok: boolean; data: Record<string, unknown>; error?: string }
  | { kind: 'ai'; handoff: true; reason: string };

const EXTERNAL_TYPES = new Set(['http_request', 'integration_action', 'ai_reply']);

// ------------------------------------------------------------------ loading

const runInclude = {
  version: { select: { definition: true, version: true } },
  contact: { include: { tags: { select: { tagId: true } } } },
  conversation: {
    include: { phone: { select: { id: true, status: true, wabaAccountId: true } } },
  },
} as const satisfies Prisma.FlowRunInclude;

type LoadedRun = Prisma.FlowRunGetPayload<{ include: typeof runInclude }>;

function scopeOf(run: LoadedRun): FlowScope {
  const c = run.contact;
  return {
    contact: {
      id: c.id,
      name: c.name,
      phone: c.waId,
      email: c.email,
      fields: (c.customFields ?? {}) as FlowScope['contact']['fields'],
    },
    vars: (run.variables ?? {}) as Record<string, unknown>,
    trigger: (run.trigger ?? {}) as Record<string, unknown>,
  };
}

async function lockRun(tx: TenantTx, runId: string): Promise<LoadedRun | null> {
  // Reviewed raw SQL: a row lock under the tenant's RLS context. One step at a time per run.
  await tx.$queryRaw`SELECT 1 FROM flow_runs WHERE id = ${runId}::uuid FOR UPDATE`;
  return tx.flowRun.findUnique({ where: { id: runId }, include: runInclude });
}

// ------------------------------------------------------------------ starting runs

/** Starts a run, or says why not. Caller holds the conversation lock. */
async function startRun(
  tx: TenantTx,
  input: {
    orgId: string;
    flow: { id: string; publishedVersionId: string; definition: FlowDefinition };
    contactId: string;
    conversationId: string | null;
    trigger: Record<string, unknown>;
  },
): Promise<string | null> {
  const { flow, contactId } = input;
  if (!flow.definition.startNodeId) return null;
  if (flow.definition.settings.reentry === 'once') {
    const before = await tx.flowRun.count({ where: { flowId: flow.id, contactId } });
    if (before > 0) return null;
  }
  // Two bots answering each other could start runs forever; this caps it.
  const recent = await tx.flowRun.count({
    where: { flowId: flow.id, contactId, startedAt: { gt: new Date(Date.now() - 3_600_000) } },
  });
  if (recent >= FLOW_MAX_STARTS_PER_HOUR) return null;

  const id = randomUUID();
  await tx.flowRun.create({
    data: {
      id,
      orgId: input.orgId,
      flowId: flow.id,
      versionId: flow.publishedVersionId,
      contactId,
      conversationId: input.conversationId,
      status: 'running',
      currentNodeId: flow.definition.startNodeId,
      trigger: input.trigger as Prisma.InputJsonValue,
    },
  });
  await tx.flowRunStep.create({
    data: {
      orgId: input.orgId,
      runId: id,
      nodeId: flow.definition.startNodeId,
      nodeType: 'trigger',
      outcome: 'started',
      detail: input.trigger as Prisma.InputJsonValue,
    },
  });
  return id;
}

async function endRun(
  tx: TenantTx,
  orgId: string,
  run: { id: string; currentNodeId: string | null },
  status: FlowRunStatus,
  reason: string,
): Promise<void> {
  await tx.flowRun.update({
    where: { id: run.id },
    data: {
      status,
      endReason: reason,
      endedAt: new Date(),
      awaiting: Prisma.DbNull,
      input: Prisma.DbNull,
      wakeAt: null,
    },
  });
  await tx.flowRunStep.create({
    data: {
      orgId,
      runId: run.id,
      nodeId: run.currentNodeId ?? '',
      nodeType: 'run',
      outcome: status,
      detail: { reason },
    },
  });
}

type PublishedFlow = {
  id: string;
  createdAt: Date;
  publishedVersionId: string;
  trigger: FlowTrigger;
  definition: FlowDefinition;
};

async function activeFlows(tx: TenantTx, where: Prisma.FlowWhereInput): Promise<PublishedFlow[]> {
  const rows = await tx.flow.findMany({
    where: { ...where, active: true, deletedAt: null, publishedVersionId: { not: null } },
    include: { publishedVersion: { select: { definition: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const flows: PublishedFlow[] = [];
  for (const row of rows) {
    const trigger = flowTriggerSchema.safeParse(row.trigger);
    const definition = flowDefinitionSchema.safeParse(row.publishedVersion?.definition);
    if (!trigger.success || !definition.success || !row.publishedVersionId) continue;
    flows.push({
      id: row.id,
      createdAt: row.createdAt,
      publishedVersionId: row.publishedVersionId,
      trigger: trigger.data,
      definition: definition.data,
    });
  }
  return flows;
}

/** The inbound message, as the flow handling in the automation job sees it. */
export interface FlowInboundMessage {
  id: string;
  type: string;
  body: string | null;
  content: unknown;
  conversationId: string;
  contactId: string;
  contactOptedOut: boolean;
}

const MATCHABLE = new Set(['text', 'button', 'interactive']);

/**
 * Runs inside the automation job's transaction, after it claimed the message, so a redelivery acts
 * once. A run waiting for a reply takes the message. Otherwise the first matching trigger starts a
 * run. `consumed` tells the caller to leave auto-replies, assignment and the SLA to the flow.
 */
export async function handleInboundForFlows(
  tx: TenantTx,
  orgId: string,
  msg: FlowInboundMessage,
): Promise<{ consumed: boolean; advance: string[] }> {
  // Reviewed raw SQL: serializes flow work on one conversation, so two messages cannot both start
  // a run or both answer one question.
  await tx.$queryRaw`SELECT 1 FROM conversations WHERE id = ${msg.conversationId}::uuid FOR UPDATE`;
  const content = (msg.content ?? {}) as Record<string, unknown>;
  const reply: FlowReply = {
    messageId: msg.id,
    type: msg.type,
    text: msg.body,
    replyId: (readPath(content, 'reply.id') as string | undefined) ?? null,
  };

  const active = await tx.flowRun.findFirst({
    where: { conversationId: msg.conversationId, status: { in: ACTIVE_FLOW_RUN_STATUSES } },
  });
  const awaiting = active?.awaiting as Awaiting | null | undefined;
  if (active && active.status === 'waiting' && awaiting?.kind === 'reply') {
    // Opted-out contacts are ended by the engine on its next step.
    await tx.flowRun.update({
      where: { id: active.id },
      data: {
        status: 'running',
        input: { kind: 'reply', reply } as unknown as Prisma.InputJsonValue,
        wakeAt: null,
      },
    });
    return { consumed: true, advance: [active.id] };
  }
  if (msg.contactOptedOut) return { consumed: false, advance: [] };
  // A run busy between steps keeps going; the message is left to the usual rules.
  if (active?.status === 'running') return { consumed: false, advance: [] };

  const flows = (await activeFlows(tx, { triggerType: { in: MESSAGE_TRIGGER_ORDER } })).sort(
    (x, y) =>
      MESSAGE_TRIGGER_ORDER.indexOf(x.trigger.type) - MESSAGE_TRIGGER_ORDER.indexOf(y.trigger.type),
  );
  // Most workspaces have few flows; with none listening, this message costs nothing more.
  if (flows.length === 0) return { consumed: false, advance: [] };
  const types = new Set(flows.map((f) => f.trigger.type));

  const text = MATCHABLE.has(msg.type) ? msg.body : null;
  // Only looked up when a flow listens for it: it reads every partition of the contact's messages.
  const isNewContact = types.has('new_contact')
    ? !(await tx.message.findFirst({
        where: {
          direction: 'inbound',
          conversation: { contactId: msg.contactId },
          id: { not: msg.id },
        },
        select: { id: true },
      }))
    : false;
  let templateButton: { text: string; templateId: string | null } | null = null;
  const contextId = readPath(content, 'context.id');
  if (msg.type === 'button' && types.has('template_button')) {
    let templateId: string | null = null;
    if (typeof contextId === 'string') {
      const ref = await tx.messageRef.findFirst({ where: { kind: 'wamid', ref: contextId } });
      if (ref) {
        const original = await tx.message.findUnique({
          where: { id_createdAt: { id: ref.messageId, createdAt: ref.messageCreatedAt } },
          select: { content: true },
        });
        const id = readPath(original?.content, 'templateId');
        templateId = typeof id === 'string' ? id : null;
      }
    }
    templateButton = { text: msg.body ?? '', templateId };
  }
  const adSource = readPath(content, 'referral.source_id');
  const facts = {
    text,
    isNewContact,
    templateButton,
    adSourceId: typeof adSource === 'string' ? adSource : null,
  };

  for (const flow of flows) {
    if (!messageMatchesTrigger(flow.trigger, facts)) continue;
    // Only a keyword replaces a run that is in a delay; nothing else interrupts a run.
    if (active && flow.trigger.type !== 'keyword') continue;
    const trigger = {
      type: flow.trigger.type,
      messageId: msg.id,
      text: msg.body,
      ...(facts.adSourceId ? { adSourceId: facts.adSourceId } : {}),
    };
    if (active) await endRun(tx, orgId, active, 'cancelled', 'replaced');
    const runId = await startRun(tx, {
      orgId,
      flow,
      contactId: msg.contactId,
      conversationId: msg.conversationId,
      trigger,
    });
    if (runId) return { consumed: true, advance: [runId] };
  }
  return { consumed: false, advance: [] };
}

/** The conversation an event-started run speaks in: the newest one, or a new closed one. */
async function conversationFor(
  tx: TenantTx,
  orgId: string,
  contactId: string,
  phoneId: string | null,
): Promise<string | null> {
  const existing = await tx.conversation.findFirst({
    where: { contactId, ...(phoneId ? { phoneId } : {}), phone: { status: 'connected' } },
    orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
    select: { id: true },
  });
  if (existing) return existing.id;
  const phone = await tx.phoneNumber.findFirst({
    where: { status: 'connected', ...(phoneId ? { id: phoneId } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!phone) return null;
  const created = await tx.conversation.upsert({
    where: { orgId_phoneId_contactId: { orgId, phoneId: phone.id, contactId } },
    create: { orgId, phoneId: phone.id, contactId, status: 'closed' },
    update: {},
    select: { id: true },
  });
  return created.id;
}

/**
 * Start the flows an event triggers, inside the caller's transaction, so the caller can claim the
 * event in the same commit. Returns the runs to advance once it commits.
 */
export async function startFlowsForEventTx(
  tx: TenantTx,
  orgId: string,
  event: FlowEvent,
): Promise<string[]> {
  const contact = await tx.contact.findUnique({
    where: { id: event.contactId },
    select: { id: true, optInStatus: true, deletedAt: true, mergedIntoId: true },
  });
  if (!contact || contact.deletedAt || contact.mergedIntoId) return [];
  if (contact.optInStatus === 'opted_out') return [];

  const flows =
    event.type === 'manual'
      ? await activeFlows(tx, { id: event.flowId })
      : await activeFlows(tx, { triggerType: event.type });
  const matching = flows.filter((f) => {
    if (event.type === 'manual') return true;
    if (event.type === 'tag_added') {
      return f.trigger.type === 'tag_added' && f.trigger.tagId === event.tagId;
    }
    return (
      f.trigger.type === 'integration_event' &&
      f.trigger.connector === event.connector &&
      f.trigger.event === event.event
    );
  });
  const runIds: string[] = [];
  for (const flow of matching) {
    const conversationId = await conversationFor(
      tx,
      orgId,
      contact.id,
      flow.definition.settings.phoneId,
    );
    if (!conversationId) continue;
    await tx.$queryRaw`SELECT 1 FROM conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
    // Events never interrupt a run that is under way.
    const busy = await tx.flowRun.count({
      where: { conversationId, status: { in: ACTIVE_FLOW_RUN_STATUSES } },
    });
    if (busy) continue;
    const trigger: Record<string, unknown> =
      event.type === 'integration_event'
        ? {
            type: event.type,
            connector: event.connector,
            event: event.event,
            data: event.data,
            ...(event.correlation ? { correlation: event.correlation } : {}),
          }
        : event.type === 'tag_added'
          ? { type: event.type, tagId: event.tagId }
          : { type: 'manual' };
    const runId = await startRun(tx, {
      orgId,
      flow,
      contactId: contact.id,
      conversationId,
      trigger,
    });
    if (runId) runIds.push(runId);
  }
  return runIds;
}

/** Start the flows an event triggers: a tag added, a connector event, or an explicit start. */
export async function startFlowsForEvent(
  deps: WorkerDeps,
  orgId: string,
  event: FlowEvent,
): Promise<string[]> {
  const started = await withTenant(
    deps.db,
    { orgId },
    (tx) => startFlowsForEventTx(tx, orgId, event),
    {
      timeout: 20_000,
      maxWait: 10_000,
    },
  );
  for (const runId of started) await deps.enqueueFlowJob({ kind: 'advance', orgId, runId });
  return started;
}

// ------------------------------------------------------------------ sending

interface StepCtx {
  deps: WorkerDeps;
  tx: TenantTx;
  orgId: string;
  run: LoadedRun;
  def: FlowDefinition;
  node: FlowNode;
  scope: FlowScope;
  input: RunInput | null;
  awaiting: Awaiting | null;
  effects: Effects;
  now: Date;
  clock: number;
  lastPreview: string | null;
}

function conversationOf(ctx: StepCtx) {
  const conv = ctx.run.conversation;
  if (!conv) throw new FlowNodeError('This contact has no conversation to write in');
  if (conv.phone.status !== 'connected') {
    throw new FlowNodeError('The WhatsApp number is not connected');
  }
  return conv;
}

/** Free-form messages: only inside the 24-hour window. */
async function sendFreeForm(
  ctx: StepCtx,
  msg: {
    type: string;
    body: string | null;
    content?: Record<string, unknown>;
    media?: { key: string; mime: string; filename?: string };
  },
): Promise<string> {
  const conv = conversationOf(ctx);
  if (!conv.windowExpiresAt || conv.windowExpiresAt <= ctx.now) {
    throw new FlowNodeError('The 24-hour window is closed, so only a template can be sent');
  }
  return createOutbound(ctx, conv.id, msg);
}

async function createOutbound(
  ctx: StepCtx,
  conversationId: string,
  msg: {
    type: string;
    body: string | null;
    content?: Record<string, unknown>;
    media?: { key: string; mime: string; filename?: string };
  },
): Promise<string> {
  const id = randomUUID();
  // A millisecond apart, so messages show in the order the flow sent them.
  const createdAt = new Date(ctx.clock++);
  await ctx.tx.message.create({
    data: {
      id,
      createdAt,
      orgId: ctx.orgId,
      conversationId,
      direction: 'outbound',
      type: msg.type,
      status: 'queued',
      body: msg.body,
      content: {
        ...msg.content,
        flow: { runId: ctx.run.id, flowId: ctx.run.flowId, nodeId: ctx.node.id },
      } as Prisma.InputJsonValue,
      ...(msg.media
        ? {
            mediaKey: msg.media.key,
            mediaMime: msg.media.mime,
            mediaFilename: msg.media.filename ?? null,
            mediaStatus: 'stored' as const,
          }
        : {}),
    },
  });
  ctx.effects.queued.push({ messageId: id, createdAt });
  ctx.effects.conversationId = conversationId;
  ctx.lastPreview = messagePreview(msg.type, msg.body);
  return id;
}

const say = (ctx: StepCtx, template: string) => interpolate(template, ctx.scope).trim();

async function sendTemplate(
  ctx: StepCtx,
  node: Extract<FlowNode, { type: 'send_template' }>,
): Promise<string> {
  const conv = conversationOf(ctx);
  const template = await ctx.tx.messageTemplate.findUnique({ where: { id: node.data.templateId } });
  if (!template || template.status !== 'approved' || !template.supported) {
    throw new FlowNodeError('The template is missing or not approved');
  }
  if (template.wabaAccountId !== conv.phone.wabaAccountId) {
    throw new FlowNodeError('The template belongs to another WhatsApp account than this number');
  }
  const contact = ctx.run.contact;
  if (isMarketingCategory(template.category) && !canReceiveMarketing(contact.optInStatus)) {
    throw new FlowNodeError('This contact has not opted in to marketing');
  }
  const parsed = templateDefinitionSchema.safeParse(template.definition);
  if (!parsed.success) throw new FlowNodeError('The template cannot be sent from here');
  const definition = parsed.data;
  const values: Record<string, string> = {};
  for (const v of templateVariables(definition)) {
    const button = definition.buttons[v.buttonIndex ?? -1];
    const value = cleanVariableValue(
      say(ctx, node.data.variables[v.key] ?? '') ||
        (button?.type === 'COPY_CODE' ? button.example : ''),
    );
    if (!value) throw new FlowNodeError(`No value for the template variable ${v.key}`);
    values[v.key] = value;
  }

  const id = randomUUID();
  const createdAt = new Date(ctx.clock++);
  const wallet = await ctx.tx.wallet.findUnique({
    where: { orgId: ctx.orgId },
    select: { currency: true },
  });
  // Throws INSUFFICIENT_BALANCE or RATE_NOT_CONFIGURED, which roll this step back.
  await chargeMessage(ctx.tx, {
    orgId: ctx.orgId,
    messageId: id,
    category: template.category,
    country: countryOfWaId(contact.waId),
    windowOpen: Boolean(conv.windowExpiresAt && conv.windowExpiresAt > ctx.now),
    defaults: { currency: wallet?.currency ?? ctx.deps.defaultCurrency, thresholdMicros: null },
  });
  const mediaHeader =
    definition.header && definition.header.format !== 'TEXT'
      ? (definition.header.format as MediaHeaderFormat)
      : null;
  const body = renderedText(renderTemplate(definition, values));
  await ctx.tx.message.create({
    data: {
      id,
      createdAt,
      orgId: ctx.orgId,
      conversationId: conv.id,
      direction: 'outbound',
      type: 'template',
      status: 'queued',
      body,
      content: {
        templateId: template.id,
        templateName: template.name,
        language: template.language,
        components: buildSendComponents(definition, values),
        category: template.category,
        flow: { runId: ctx.run.id, flowId: ctx.run.flowId, nodeId: ctx.node.id },
        ...(mediaHeader ? { headerKind: headerMediaKind(mediaHeader) } : {}),
      } as unknown as Prisma.InputJsonValue,
      ...(mediaHeader && template.headerMediaKey
        ? {
            mediaKey: template.headerMediaKey,
            mediaMime: template.headerMediaMime,
            mediaFilename: template.headerMediaName,
            mediaStatus: 'stored' as const,
          }
        : {}),
    },
  });
  ctx.effects.queued.push({ messageId: id, createdAt });
  ctx.effects.conversationId = conv.id;
  ctx.lastPreview = messagePreview('template', body);
  ctx.effects.charged = true;
  return id;
}

// ------------------------------------------------------------------ people

async function automationContext(ctx: StepCtx) {
  const [settings, org] = await Promise.all([
    ctx.tx.automationSettings.findUnique({ where: { orgId: ctx.orgId } }),
    ctx.tx.organization.findUniqueOrThrow({
      where: { id: ctx.orgId },
      select: { timezone: true },
    }),
  ]);
  return { settings, timezone: org.timezone };
}

/** The named person if they are an active member, else whoever the assignment rules pick. */
async function pickAssignee(ctx: StepCtx, userId: string | null): Promise<string | null> {
  if (userId) {
    const member = await ctx.tx.membership.findFirst({
      where: { orgId: ctx.orgId, userId, status: 'active' },
      select: { userId: true },
    });
    if (member) return member.userId;
  }
  const conv = conversationOf(ctx);
  const { settings } = await automationContext(ctx);
  return chooseAgent(ctx.tx, {
    orgId: ctx.orgId,
    phoneId: conv.phoneId,
    tagIds: ctx.run.contact.tags.map((t) => t.tagId),
    text: null,
    defaultAssignment: (settings?.defaultAssignment ?? 'none') as DefaultAssignment,
  });
}

async function assign(ctx: StepCtx, agent: string): Promise<void> {
  const conv = conversationOf(ctx);
  if (conv.assigneeId === agent) return;
  await ctx.tx.conversation.update({ where: { id: conv.id }, data: { assigneeId: agent } });
  const c = ctx.run.contact;
  await ctx.tx.notification.create({
    data: {
      orgId: ctx.orgId,
      userId: agent,
      kind: 'conversation_assigned',
      title: `New conversation with ${c.name ?? `+${c.waId}`}`,
      body: 'Handed over by a flow',
      conversationId: conv.id,
    },
  });
  ctx.effects.notify.push(agent);
  ctx.effects.conversationChanged = true;
  ctx.effects.conversationId = conv.id;
}

/** Give the conversation to a person: open it, assign it, start the SLA clock. */
async function handOff(ctx: StepCtx, userId: string | null): Promise<Detail> {
  const conv = conversationOf(ctx);
  const agent = conv.assigneeId && !userId ? conv.assigneeId : await pickAssignee(ctx, userId);
  const { settings } = await automationContext(ctx);
  await ctx.tx.conversation.update({
    where: { id: conv.id },
    data: {
      status: 'open',
      ...(settings?.slaEnabled && !conv.awaitingReplySince
        ? {
            awaitingReplySince: ctx.now,
            slaDueAt: new Date(ctx.now.getTime() + settings.slaFirstResponseMinutes * MINUTE_MS),
            slaStage: 0,
          }
        : {}),
    },
  });
  ctx.effects.conversationChanged = true;
  ctx.effects.conversationId = conv.id;
  if (agent) await assign(ctx, agent);
  return { assignedTo: agent };
}

// ------------------------------------------------------------------ nodes

function waitFor(
  node: { data: { timeoutMinutes: number | null } },
  attempts = 0,
  detail?: Detail,
): Outcome {
  return {
    kind: 'wait',
    waitKind: 'reply',
    minutes: node.data.timeoutMinutes ?? FLOW_DEFAULT_WAIT_MINUTES,
    attempts,
    detail,
  };
}

async function execNode(ctx: StepCtx, external: External | null): Promise<Outcome> {
  const { node, input } = ctx;
  const replying = input?.kind === 'reply' && ctx.awaiting?.nodeId === node.id ? input.reply : null;
  const timedOut = input?.kind === 'timeout' && ctx.awaiting?.nodeId === node.id;

  switch (node.type) {
    case 'send_message': {
      const text = say(ctx, node.data.text);
      if (!text) throw new FlowNodeError('The message is empty once variables are filled in');
      const messageId = await sendFreeForm(ctx, { type: 'text', body: text.slice(0, 4096) });
      return { kind: 'go', handle: 'next', detail: { messageId } };
    }
    case 'send_template': {
      const messageId = await sendTemplate(ctx, node);
      return { kind: 'go', handle: 'next', detail: { messageId } };
    }
    case 'media': {
      if (!node.data.mediaKey.startsWith(`orgs/${ctx.orgId}/`)) {
        throw new FlowNodeError('This file belongs to another workspace');
      }
      const caption = node.data.caption ? say(ctx, node.data.caption) : null;
      const messageId = await sendFreeForm(ctx, {
        type: node.data.kind,
        body: node.data.kind === 'audio' ? null : caption || null,
        media: { key: node.data.mediaKey, mime: node.data.mimeType, filename: node.data.filename },
      });
      return { kind: 'go', handle: 'next', detail: { messageId } };
    }
    case 'buttons':
    case 'list': {
      if (timedOut) return { kind: 'go', handle: 'timeout' };
      if (replying) {
        const { handle, value } = choiceHandle(node, replying);
        return {
          kind: 'go',
          handle,
          vars: node.data.saveAs ? { [node.data.saveAs]: value } : undefined,
          detail: { answer: value },
        };
      }
      const body = say(ctx, node.data.body).slice(0, 1024);
      const header = node.data.header ? say(ctx, node.data.header).slice(0, 60) : undefined;
      const footer = node.data.footer ? say(ctx, node.data.footer).slice(0, 60) : undefined;
      const interactive: SendInteractiveInput =
        node.type === 'buttons'
          ? { type: 'button', body, header, footer, buttons: node.data.buttons }
          : {
              type: 'list',
              body,
              header,
              footer,
              buttonText: node.data.buttonText,
              sections: node.data.sections,
            };
      const messageId = await sendFreeForm(ctx, {
        type: 'interactive',
        body,
        content: { interactive },
      });
      return waitFor(node, 0, { messageId });
    }
    case 'ask_question': {
      if (timedOut) return { kind: 'go', handle: 'timeout' };
      if (replying) {
        let answer = checkAnswer(node.data.answerType, replying.text);
        let fieldValue: string | number | boolean | null = null;
        if (answer !== null && node.data.contactField) {
          const field = await ctx.tx.contactField.findUnique({
            where: { orgId_key: { orgId: ctx.orgId, key: node.data.contactField } },
          });
          const coerced = field ? coerceFieldValue(field, answer) : null;
          if (coerced?.ok) fieldValue = coerced.value;
          else if (field) answer = null;
        }
        if (answer === null) {
          const attempts = (ctx.awaiting?.attempts ?? 0) + 1;
          if (attempts > node.data.retries) {
            return { kind: 'go', handle: 'invalid', detail: { answer: replying.text } };
          }
          await sendFreeForm(ctx, { type: 'text', body: say(ctx, node.data.retryMessage) });
          return waitFor(node, attempts, { invalid: replying.text });
        }
        if (fieldValue !== null && node.data.contactField) {
          const fields = { ...ctx.scope.contact.fields, [node.data.contactField]: fieldValue };
          await ctx.tx.contact.update({
            where: { id: ctx.run.contactId },
            data: { customFields: fields as Prisma.InputJsonValue },
          });
        }
        return {
          kind: 'go',
          handle: 'next',
          vars: { [node.data.saveAs]: answer },
          detail: { answer },
        };
      }
      const messageId = await sendFreeForm(ctx, {
        type: 'text',
        body: say(ctx, node.data.question),
      });
      return waitFor(node, 0, { messageId });
    }
    case 'wait_for_reply': {
      if (timedOut) return { kind: 'go', handle: 'timeout' };
      if (replying) {
        return {
          kind: 'go',
          handle: 'next',
          vars: node.data.saveAs ? { [node.data.saveAs]: replying.text ?? '' } : undefined,
          detail: { answer: replying.text },
        };
      }
      return waitFor(node);
    }
    case 'delay': {
      if (timedOut) return { kind: 'go', handle: 'next' };
      return { kind: 'wait', waitKind: 'timer', minutes: delayMinutes(node.data) };
    }
    case 'condition': {
      const { settings, timezone } = await automationContext(ctx);
      const handle = chooseBranch(node, {
        scope: ctx.scope,
        tagIds: ctx.run.contact.tags.map((t) => t.tagId),
        businessOpen: isWithinBusinessHours(
          (settings?.businessHours ?? null) as BusinessHours | null,
          timezone,
          ctx.now,
        ),
      });
      return { kind: 'go', handle };
    }
    case 'http_request': {
      const r = external?.kind === 'http' ? external : null;
      if (!r) throw new FlowNodeError('The request did not run');
      const vars: Record<string, unknown> = {};
      if (r.ok) {
        for (const [name, path] of Object.entries(node.data.saveResponse)) {
          vars[name] = readPath(r.json, path) ?? null;
        }
      }
      return {
        kind: 'go',
        handle: r.ok ? 'success' : 'failure',
        vars,
        detail: { status: r.status, body: r.body.slice(0, 2000), error: r.error },
      };
    }
    case 'integration_action': {
      const r = external?.kind === 'integration' ? external : null;
      if (!r) throw new FlowNodeError('The action did not run');
      const vars: Record<string, unknown> = {};
      if (r.ok) {
        for (const [name, path] of Object.entries(node.data.saveResponse)) {
          vars[name] = readPath(r.data, path) ?? null;
        }
      }
      return {
        kind: 'go',
        handle: r.ok ? 'success' : 'failure',
        vars,
        detail: r.ok ? { result: r.data } : { error: r.error },
      };
    }
    case 'ai_reply': {
      const r = external?.kind === 'ai' ? external : null;
      return { kind: 'go', handle: 'handoff', detail: { reason: r?.reason ?? 'Did not run' } };
    }
    case 'tag': {
      const tag = await ctx.tx.tag.findUnique({ where: { id: node.data.tagId } });
      if (!tag) throw new FlowNodeError('The tag no longer exists');
      if (node.data.action === 'add') {
        const res = await ctx.tx.contactTag.createMany({
          data: { orgId: ctx.orgId, contactId: ctx.run.contactId, tagId: tag.id },
          skipDuplicates: true,
        });
        if (res.count > 0) {
          ctx.effects.events.push({
            type: 'tag_added',
            contactId: ctx.run.contactId,
            tagId: tag.id,
          });
        }
      } else {
        await ctx.tx.contactTag.deleteMany({
          where: { contactId: ctx.run.contactId, tagId: tag.id },
        });
      }
      return { kind: 'go', handle: 'next', detail: { tag: tag.name } };
    }
    case 'assign_agent': {
      const agent = await pickAssignee(ctx, node.data.userId);
      if (agent) await assign(ctx, agent);
      return { kind: 'go', handle: 'next', detail: { assignedTo: agent } };
    }
    case 'human_handoff': {
      let messageId: string | null = null;
      if (node.data.message) {
        const conv = conversationOf(ctx);
        // A handoff still happens when the window has closed; only the message is skipped.
        if (conv.windowExpiresAt && conv.windowExpiresAt > ctx.now) {
          messageId = await sendFreeForm(ctx, { type: 'text', body: say(ctx, node.data.message) });
        }
      }
      const detail = await handOff(ctx, node.data.userId);
      return {
        kind: 'end',
        status: 'completed',
        reason: 'handoff',
        detail: { ...detail, messageId },
      };
    }
    case 'end':
      return { kind: 'end', status: 'completed', reason: 'end' };
  }
}

// ------------------------------------------------------------------ calls outside the database

const jsonEscape = (v: string) => JSON.stringify(v).slice(1, -1);

async function runExternal(
  deps: WorkerDeps,
  node: FlowNode,
  scope: FlowScope,
  where: { orgId: string; runId: string },
): Promise<External> {
  if (node.type === 'http_request') {
    const url = interpolate(node.data.url, scope, encodeURIComponent);
    if (!/^https:\/\//i.test(url)) {
      return { kind: 'http', ok: false, status: 0, body: '', json: null, error: 'Not https' };
    }
    const rawBody = node.data.body;
    const looksJson = rawBody !== undefined && /^\s*[[{]/.test(rawBody);
    const body =
      rawBody === undefined
        ? undefined
        : interpolate(rawBody, scope, looksJson ? jsonEscape : undefined);
    const headers: Record<string, string> = {
      'user-agent': 'wacrm-flows/1',
      ...(body !== undefined && looksJson ? { 'content-type': 'application/json' } : {}),
    };
    for (const h of node.data.headers) headers[h.name.toLowerCase()] = interpolate(h.value, scope);
    try {
      const res = await deps.httpRequest({
        method: node.data.method,
        url,
        headers,
        body: node.data.method === 'GET' || node.data.method === 'DELETE' ? undefined : body,
        maxBytes: FLOW_HTTP_MAX_BODY,
        timeoutMs: FLOW_HTTP_TIMEOUT_MS,
      });
      let json: unknown = null;
      try {
        json = res.body ? JSON.parse(res.body) : null;
      } catch {
        json = null;
      }
      return {
        kind: 'http',
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        body: res.body,
        json,
      };
    } catch (err) {
      return {
        kind: 'http',
        ok: false,
        status: 0,
        body: '',
        json: null,
        error: err instanceof Error ? err.message : 'Request failed',
      };
    }
  }
  if (node.type === 'integration_action') {
    const input: Record<string, string> = {};
    for (const [k, v] of Object.entries(node.data.input)) input[k] = interpolate(v, scope).trim();
    const r = await runConnectorAction(deps, where.orgId, {
      connector: node.data.connector,
      action: node.data.action,
      input,
      connectionId: node.data.connectionId,
      source: { flowRun: where.runId, node: node.id },
    });
    return r.ok
      ? { kind: 'integration', ok: true, data: r.data }
      : { kind: 'integration', ok: false, data: {}, error: r.error };
  }
  // TODO(3.7): the AI assistant answers here.
  return { kind: 'ai', handoff: true, reason: 'AI replies are not set up for this workspace' };
}

// ------------------------------------------------------------------ one step

type StepResult =
  | { next: 'continue' }
  | { next: 'stop'; status: FlowRunStatus | 'missing' }
  | { next: 'external'; node: FlowNode; scope: FlowScope; steps: number };

async function applyOutcome(ctx: StepCtx, outcome: Outcome): Promise<StepResult> {
  const { tx, run, node, orgId } = ctx;
  const vars =
    outcome.kind === 'go' && outcome.vars
      ? { ...(run.variables as Record<string, unknown>), ...outcome.vars }
      : (run.variables as Record<string, unknown>);
  const base = {
    steps: run.steps + 1,
    variables: vars as Prisma.InputJsonValue,
    input: Prisma.DbNull,
  };

  if (outcome.kind === 'go') {
    const target = edgeTarget(ctx.def, node.id, outcome.handle);
    await tx.flowRunStep.create({
      data: {
        orgId,
        runId: run.id,
        nodeId: node.id,
        nodeType: node.type,
        outcome: outcome.handle,
        detail: (outcome.detail ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
      },
    });
    await tx.flowRun.update({
      where: { id: run.id },
      data: target
        ? {
            ...base,
            currentNodeId: target,
            stepsSinceWait: run.stepsSinceWait + 1,
            awaiting: Prisma.DbNull,
            wakeAt: null,
          }
        : {
            ...base,
            status: 'completed',
            endReason: 'end',
            endedAt: ctx.now,
            awaiting: Prisma.DbNull,
            wakeAt: null,
          },
    });
    return target ? { next: 'continue' } : { next: 'stop', status: 'completed' };
  }

  if (outcome.kind === 'wait') {
    const wakeAt = new Date(ctx.now.getTime() + outcome.minutes * MINUTE_MS);
    const awaiting: Awaiting = {
      nodeId: node.id,
      kind: outcome.waitKind,
      attempts: outcome.attempts ?? 0,
    };
    await tx.flowRunStep.create({
      data: {
        orgId,
        runId: run.id,
        nodeId: node.id,
        nodeType: node.type,
        outcome: outcome.waitKind === 'timer' ? 'delayed' : 'waiting',
        detail: { ...outcome.detail, until: wakeAt.toISOString() } as Prisma.InputJsonValue,
      },
    });
    await tx.flowRun.update({
      where: { id: run.id },
      data: {
        ...base,
        status: 'waiting',
        stepsSinceWait: 0,
        awaiting: awaiting as unknown as Prisma.InputJsonValue,
        wakeAt,
      },
    });
    ctx.effects.wake = { runId: run.id, at: wakeAt };
    return { next: 'stop', status: 'waiting' };
  }

  await tx.flowRunStep.create({
    data: {
      orgId,
      runId: run.id,
      nodeId: node.id,
      nodeType: node.type,
      outcome: outcome.reason,
      detail: (outcome.detail ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
    },
  });
  await tx.flowRun.update({
    where: { id: run.id },
    data: {
      ...base,
      status: outcome.status,
      endReason: outcome.reason,
      error: outcome.error ?? null,
      endedAt: ctx.now,
      awaiting: Prisma.DbNull,
      wakeAt: null,
    },
  });
  return { next: 'stop', status: outcome.status };
}

async function finishConversation(ctx: StepCtx): Promise<void> {
  if (!ctx.lastPreview || !ctx.effects.conversationId) return;
  await ctx.tx.conversation.update({
    where: { id: ctx.effects.conversationId },
    data: { lastMessageAt: new Date(ctx.clock - 1), lastMessagePreview: ctx.lastPreview },
  });
  ctx.effects.conversationChanged = true;
}

async function executeStep(
  deps: WorkerDeps,
  tx: TenantTx,
  orgId: string,
  runId: string,
  effects: Effects,
  external: { steps: number; nodeId: string; result: External } | null,
): Promise<StepResult> {
  const run = await lockRun(tx, runId);
  if (!run) return { next: 'stop', status: 'missing' };
  if (run.status !== 'running') return { next: 'stop', status: run.status as FlowRunStatus };
  if (external && (external.steps !== run.steps || external.nodeId !== run.currentNodeId)) {
    // Another worker moved this run on while the call ran. Its result no longer applies.
    return { next: 'continue' };
  }

  const end = async (status: FlowRunStatus, reason: string, error?: string) => {
    await tx.flowRun.update({
      where: { id: run.id },
      data: {
        status,
        endReason: reason,
        error: error ?? null,
        endedAt: new Date(),
        awaiting: Prisma.DbNull,
        input: Prisma.DbNull,
        wakeAt: null,
      },
    });
    await tx.flowRunStep.create({
      data: {
        orgId,
        runId: run.id,
        nodeId: run.currentNodeId ?? '',
        nodeType: 'run',
        outcome: status,
        detail: { reason, ...(error ? { error } : {}) },
      },
    });
    return { next: 'stop' as const, status };
  };

  const contact = run.contact;
  if (contact.optInStatus === 'opted_out') return end('cancelled', 'opted_out');
  if (contact.deletedAt || contact.mergedIntoId) return end('cancelled', 'contact_removed');
  if (run.steps >= FLOW_MAX_STEPS_PER_RUN) {
    return end('failed', 'step_limit', `Stopped after ${FLOW_MAX_STEPS_PER_RUN} steps`);
  }
  if (run.stepsSinceWait >= FLOW_MAX_STEPS_WITHOUT_WAIT) {
    return end(
      'failed',
      'loop',
      `Stopped after ${FLOW_MAX_STEPS_WITHOUT_WAIT} steps without waiting: the flow loops`,
    );
  }
  const parsed = flowDefinitionSchema.safeParse(run.version.definition);
  if (!parsed.success) return end('failed', 'invalid_definition');
  const def = parsed.data;
  const node = def.nodes.find((n) => n.id === run.currentNodeId);
  if (!node) return end('completed', 'end');

  const scope = scopeOf(run);
  if (EXTERNAL_TYPES.has(node.type) && !external) {
    return { next: 'external', node, scope, steps: run.steps };
  }

  effects.at = { steps: run.steps, nodeId: node.id };
  const ctx: StepCtx = {
    deps,
    tx,
    orgId,
    run,
    def,
    node,
    scope,
    input: (run.input ?? null) as RunInput | null,
    awaiting: (run.awaiting ?? null) as Awaiting | null,
    effects,
    now: new Date(),
    clock: Date.now(),
    lastPreview: null,
  };
  const outcome = await execNode(ctx, external?.result ?? null);
  await finishConversation(ctx);
  return applyOutcome(ctx, outcome);
}

/** A node threw: follow the flow's onError. Runs in a fresh transaction, after the rollback. */
async function failStep(
  deps: WorkerDeps,
  tx: TenantTx,
  orgId: string,
  runId: string,
  at: { steps: number; nodeId: string },
  message: string,
  effects: Effects,
): Promise<StepResult> {
  const run = await lockRun(tx, runId);
  if (
    !run ||
    run.status !== 'running' ||
    run.steps !== at.steps ||
    run.currentNodeId !== at.nodeId
  ) {
    return { next: 'continue' };
  }
  const def = flowDefinitionSchema.safeParse(run.version.definition);
  const node = def.success ? def.data.nodes.find((n) => n.id === run.currentNodeId) : undefined;
  const ctx: StepCtx = {
    deps,
    tx,
    orgId,
    run,
    def: def.success ? def.data : flowDefinitionSchema.parse({ trigger: { type: 'manual' } }),
    node: node ?? {
      id: run.currentNodeId ?? 'unknown',
      type: 'end',
      position: { x: 0, y: 0 },
      data: {},
    },
    scope: scopeOf(run),
    input: null,
    awaiting: null,
    effects,
    now: new Date(),
    clock: Date.now(),
    lastPreview: null,
  };
  let detail: Detail = { error: message };
  if (def.success && def.data.settings.onError === 'handoff' && run.conversation) {
    try {
      detail = { ...detail, ...(await handOff(ctx, null)) };
    } catch (err) {
      detail = { ...detail, handoffError: err instanceof Error ? err.message : String(err) };
    }
  }
  return applyOutcome(ctx, {
    kind: 'end',
    status: 'failed',
    reason: def.success && def.data.settings.onError === 'handoff' ? 'error_handoff' : 'error',
    error: message,
    detail,
  });
}

const NODE_ERROR_CODES = new Set<string>([
  ErrorCode.INSUFFICIENT_BALANCE,
  ErrorCode.RATE_NOT_CONFIGURED,
]);

async function afterCommit(deps: WorkerDeps, orgId: string, effects: Effects): Promise<void> {
  if (effects.queued.length) {
    const messages = await withTenant(deps.db, { orgId }, (tx) =>
      tx.message.findMany({
        where: { id: { in: effects.queued.map((q) => q.messageId) } },
        include: messageInclude,
        orderBy: { createdAt: 'asc' },
      }),
    );
    for (const m of messages)
      deps.publisher.emit(orgId, 'message:new', { message: messageToDto(m) });
  }
  if (effects.conversationChanged && effects.conversationId) {
    const conv = await withTenant(deps.db, { orgId }, (tx) =>
      tx.conversation.findUnique({
        where: { id: effects.conversationId! },
        include: conversationInclude,
      }),
    );
    if (conv) {
      deps.publisher.emit(orgId, 'conversation:updated', {
        conversation: conversationToDto(conv),
      });
    }
  }
  for (const userId of effects.notify) deps.publisher.emit(orgId, 'notification:new', { userId });
  if (effects.charged) deps.publisher.emit(orgId, 'wallet:updated', {});
  // Through the outbound queue, so the per-number limit and retries apply as for every send.
  for (const q of effects.queued) {
    await deps.enqueueOutbound({
      orgId,
      messageId: q.messageId,
      createdAt: q.createdAt.toISOString(),
    });
  }
  for (const event of effects.events) await deps.enqueueFlowJob({ kind: 'event', orgId, event });
  if (effects.wake) {
    await deps.enqueueFlowJob(
      { kind: 'wake', orgId, runId: effects.wake.runId },
      Math.max(0, effects.wake.at.getTime() - Date.now()),
    );
  }
}

/**
 * Run a flow until it waits or ends. Safe to call twice at once or again after a crash: each step
 * re-reads the run under its lock and does nothing if another call already moved it.
 */
export async function advanceRun(
  deps: WorkerDeps,
  orgId: string,
  runId: string,
): Promise<FlowRunStatus | 'missing'> {
  let external: { steps: number; nodeId: string; result: External } | null = null;
  // The loop guard inside a step ends a run long before this; it only bounds this call.
  for (let i = 0; i < FLOW_MAX_STEPS_WITHOUT_WAIT * 2 + 10; i++) {
    const effects = noEffects();
    let result: StepResult;
    try {
      result = await withTenant(
        deps.db,
        { orgId },
        async (tx) => {
          const r = await executeStep(deps, tx, orgId, runId, effects, external);
          return r;
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
    } catch (err) {
      const message =
        err instanceof FlowNodeError
          ? err.message
          : err instanceof AppError && NODE_ERROR_CODES.has(err.code)
            ? err.message
            : null;
      if (message === null) throw err;
      // The step rolled back, effects included. Record the failure in a fresh transaction.
      const at = effects.at;
      if (!at) throw err;
      const fresh = noEffects();
      result = await withTenant(
        deps.db,
        { orgId },
        (tx) => failStep(deps, tx, orgId, runId, at, message, fresh),
        { timeout: 20_000, maxWait: 10_000 },
      );
      await afterCommit(deps, orgId, fresh);
      external = null;
      if (result.next === 'stop') return result.status;
      continue;
    }
    await afterCommit(deps, orgId, effects);
    external = null;
    if (result.next === 'stop') return result.status;
    if (result.next === 'external') {
      external = {
        steps: result.steps,
        nodeId: result.node.id,
        result: await runExternal(deps, result.node, result.scope, { orgId, runId }),
      };
    }
  }
  return 'running';
}

/**
 * A delay or a wait may be over. Hands the waiting node a timeout and runs on. A reply that
 * arrived first already moved the run, so this then does nothing.
 */
export async function wakeRun(
  deps: WorkerDeps,
  orgId: string,
  runId: string,
): Promise<FlowRunStatus | 'missing' | 'not_due'> {
  const woke = await withTenant(deps.db, { orgId }, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM flow_runs WHERE id = ${runId}::uuid FOR UPDATE`;
    const run = await tx.flowRun.findUnique({
      where: { id: runId },
      select: { status: true, wakeAt: true, updatedAt: true },
    });
    if (!run) return 'missing' as const;
    if (run.status === 'running') return 'running' as const;
    if (run.status !== 'waiting' || !run.wakeAt || run.wakeAt > new Date()) {
      return 'not_due' as const;
    }
    await tx.flowRun.update({
      where: { id: runId },
      data: {
        status: 'running',
        input: { kind: 'timeout' } as Prisma.InputJsonValue,
        wakeAt: null,
      },
    });
    return 'woken' as const;
  });
  if (woke === 'missing' || woke === 'not_due') return woke;
  return advanceRun(deps, orgId, runId);
}

/** Runs due to wake, and runs left `running` with no job (a crash). Ids only, across orgs. */
export function flowDueRuns(deps: Pick<WorkerDeps, 'db'>, limit = 500) {
  const stalledBefore = new Date(Date.now() - STALLED_MS);
  return deps.db.$queryRaw<{ org_id: string; id: string; status: string }[]>`
    SELECT org_id, id, status FROM flow_due_runs(${stalledBefore}, ${limit}::int)`;
}

export async function processFlowJob(deps: WorkerDeps, job: FlowJob): Promise<string> {
  switch (job.kind) {
    case 'advance':
      return advanceRun(deps, job.orgId, job.runId);
    case 'wake':
      return wakeRun(deps, job.orgId, job.runId);
    case 'event': {
      const started = await startFlowsForEvent(deps, job.orgId, job.event);
      return `started ${started.length}`;
    }
  }
}
