import { randomUUID } from 'node:crypto';
import {
  conversationInclude,
  conversationToDto,
  messageInclude,
  messageToDto,
  type Prisma,
  type TenantTx,
  withTenant,
} from '@wacrm/db';
import {
  type AutomationJob,
  type AutomationKind,
  type BusinessHours,
  type DefaultAssignment,
  isWithinBusinessHours,
  matchesRule,
  MAX_AUTOMATED_REPLIES_PER_HOUR,
  messagePreview,
  type NotificationKind,
  pickLeastLoaded,
  pickRoundRobin,
} from '@wacrm/shared';
import type { WorkerDeps } from '../deps';
import { handleInboundForFlows } from './flows';

/** Message types a customer types or taps. A photo's caption is not a command. */
const MATCHABLE = new Set(['text', 'button', 'interactive']);
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

interface Notice {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  conversationId: string;
}

async function notify(tx: TenantTx, orgId: string, notices: Notice[]): Promise<void> {
  if (notices.length === 0) return;
  // createMany, since the worker has no user context and could not read a created row back.
  await tx.notification.createMany({
    data: notices.map((n) => ({ orgId, ...n })),
  });
}

const contactLabel = (c: { name: string | null; waId: string }) => c.name ?? `+${c.waId}`;

/** People who see the whole team's work: owners and admins, active in this workspace. */
async function managers(tx: TenantTx, orgId: string): Promise<string[]> {
  const rows = await tx.membership.findMany({
    where: { orgId, status: 'active', role: { in: ['owner', 'admin'] } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

// ------------------------------------------------------------------ assignment

async function availableAgents(
  tx: TenantTx,
  orgId: string,
): Promise<{ userId: string; skills: string[] }[]> {
  return tx.membership.findMany({
    where: { orgId, status: 'active', available: true },
    select: { userId: true, skills: true },
  });
}

async function pick(
  tx: TenantTx,
  candidates: string[],
  strategy: 'round_robin' | 'load_based',
  lastAssigned: string | null,
): Promise<string | null> {
  if (candidates.length === 0) return null;
  if (strategy === 'round_robin') return pickRoundRobin(candidates, lastAssigned);
  const open = await tx.conversation.groupBy({
    by: ['assigneeId'],
    where: { status: 'open', assigneeId: { in: candidates } },
    _count: { _all: true },
  });
  const counts = new Map(open.map((o) => [o.assigneeId, o._count._all]));
  return pickLeastLoaded(candidates.map((userId) => ({ userId, open: counts.get(userId) ?? 0 })));
}

/**
 * The first active rule that matches decides, then the default. Round-robin positions are kept on
 * the rule row, which is locked first, so two conversations at once cannot both go to the same
 * "next" agent. Returns null when nobody suitable is available.
 */
export async function chooseAgent(
  tx: TenantTx,
  input: {
    orgId: string;
    phoneId: string;
    tagIds: string[];
    text: string | null;
    defaultAssignment: DefaultAssignment;
    exclude?: string | null;
  },
): Promise<string | null> {
  const agents = (await availableAgents(tx, input.orgId)).filter((a) => a.userId !== input.exclude);
  if (agents.length === 0) return null;
  const rules = await tx.assignmentRule.findMany({
    where: { active: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });

  for (const rule of rules) {
    if (rule.tagIds.length && !rule.tagIds.some((t) => input.tagIds.includes(t))) continue;
    if (rule.phoneIds.length && !rule.phoneIds.includes(input.phoneId)) continue;
    if (
      rule.keywords.length &&
      !matchesRule({ matchType: 'contains', keywords: rule.keywords, pattern: null }, input.text)
    ) {
      continue;
    }
    const candidates = agents
      .filter((a) =>
        rule.agentIds.length
          ? rule.agentIds.includes(a.userId)
          : a.skills.includes(rule.skill ?? ''),
      )
      .map((a) => a.userId);
    if (candidates.length === 0) continue;
    // Reviewed raw SQL: a row lock under the tenant's RLS context.
    await tx.$queryRaw`SELECT 1 FROM assignment_rules WHERE id = ${rule.id}::uuid FOR UPDATE`;
    const fresh = await tx.assignmentRule.findUniqueOrThrow({ where: { id: rule.id } });
    const chosen = await pick(
      tx,
      candidates,
      rule.strategy as 'round_robin' | 'load_based',
      fresh.lastAssignedUserId,
    );
    if (chosen) {
      await tx.assignmentRule.update({
        where: { id: rule.id },
        data: { lastAssignedUserId: chosen },
      });
      return chosen;
    }
  }

  if (input.defaultAssignment === 'none') return null;
  await tx.$queryRaw`SELECT 1 FROM automation_settings WHERE org_id = ${input.orgId}::uuid FOR UPDATE`;
  const settings = await tx.automationSettings.findUnique({ where: { orgId: input.orgId } });
  const chosen = await pick(
    tx,
    agents.map((a) => a.userId),
    input.defaultAssignment,
    settings?.lastAssignedUserId ?? null,
  );
  if (chosen && settings) {
    await tx.automationSettings.update({
      where: { orgId: input.orgId },
      data: { lastAssignedUserId: chosen },
    });
  }
  return chosen;
}

// ------------------------------------------------------------------ per inbound message

interface Queued {
  messageId: string;
  createdAt: Date;
}

/**
 * Rules for one inbound message: replies, assignment and the SLA clock. It claims the message
 * first, in the same transaction as everything it does, so a retry or a replay of the webhook can
 * never reply twice. Runs in its own queue, after the message is saved, so it never slows the
 * webhook or the inbound pipeline.
 */
export async function runInboxAutomation(
  deps: WorkerDeps,
  job: AutomationJob,
): Promise<'done' | 'skipped'> {
  const { orgId, messageId } = job;
  const now = new Date();

  const result = await withTenant(
    deps.db,
    { orgId },
    async (tx) => {
      const claim = await tx.messageRef.createMany({
        data: {
          orgId,
          kind: 'automation',
          ref: messageId,
          messageId,
          messageCreatedAt: new Date(job.createdAt),
        },
        skipDuplicates: true,
      });
      if (claim.count === 0) return null;

      const message = await tx.message.findUnique({
        where: { id_createdAt: { id: messageId, createdAt: new Date(job.createdAt) } },
        include: {
          conversation: {
            include: {
              contact: { include: { tags: { select: { tagId: true } } } },
              phone: { select: { id: true, status: true } },
            },
          },
        },
      });
      if (!message || message.direction !== 'inbound') return null;
      const { conversation } = message;
      const { contact } = conversation;
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { timezone: true },
      });
      const settings = await tx.automationSettings.findUnique({ where: { orgId } });
      const text = MATCHABLE.has(message.type) ? message.body : null;

      // ---- flows: a run waiting for this answer, or a trigger. A flow that takes the message
      // also takes the conversation, so the rules below stay out of its way.
      const flows = await handleInboundForFlows(tx, orgId, {
        id: message.id,
        type: message.type,
        body: message.body,
        content: message.content,
        conversationId: conversation.id,
        contactId: contact.id,
        contactOptedOut: contact.optInStatus === 'opted_out',
      });
      if (flows.consumed) {
        return { queued: [], updated: null, messages: [], notices: [], advance: flows.advance };
      }

      // ---- replies
      const replies: { kind: AutomationKind; text: string; ruleId?: string }[] = [];
      // Someone who said STOP gets nothing automatic, not even an acknowledgement.
      const canReply =
        contact.optInStatus !== 'opted_out' && conversation.phone.status === 'connected';
      if (canReply) {
        // Reviewed raw SQL: bound parameters under RLS. created_at bounds the partitions read.
        const countSince = async (since: Date, kind?: AutomationKind) => {
          const [row] = await tx.$queryRaw<{ n: bigint }[]>`
            SELECT COUNT(*)::bigint AS n FROM messages
            WHERE conversation_id = ${conversation.id}::uuid
              AND created_at > ${since}
              AND content ? 'automation'
              AND (${kind ?? null}::text IS NULL OR content->>'automation' = ${kind ?? null}::text)`;
          return Number(row?.n ?? 0);
        };
        const awayCooldown = (settings?.awayCooldownMinutes ?? 720) * MINUTE_MS;
        const awaySentRecently =
          (await countSince(new Date(now.getTime() - awayCooldown), 'away')) > 0;
        const budget =
          MAX_AUTOMATED_REPLIES_PER_HOUR - (await countSince(new Date(now.getTime() - HOUR_MS)));

        const inboundSoFar = await tx.message.count({
          where: { conversationId: conversation.id, direction: 'inbound' },
        });
        if (settings?.welcomeEnabled && settings.welcomeMessage && inboundSoFar === 1) {
          replies.push({ kind: 'welcome', text: settings.welcomeMessage });
        }
        const rules = await tx.autoReplyRule.findMany({
          where: { active: true, OR: [{ phoneId: null }, { phoneId: conversation.phoneId }] },
          orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        });
        const rule = rules.find((r) =>
          matchesRule(
            {
              matchType: r.matchType as 'exact' | 'contains' | 'regex',
              keywords: r.keywords,
              pattern: r.pattern,
            },
            text,
          ),
        );
        if (rule) replies.push({ kind: 'keyword', text: rule.reply, ruleId: rule.id });
        const away =
          settings?.awayEnabled &&
          settings.awayMessage &&
          !rule &&
          !awaySentRecently &&
          !isWithinBusinessHours(
            settings.businessHours as BusinessHours | null,
            org.timezone,
            message.createdAt,
          );
        if (away && settings.awayMessage)
          replies.push({ kind: 'away', text: settings.awayMessage });
        replies.splice(Math.max(0, budget));
      }

      const queued: Queued[] = [];
      let at = Date.now();
      for (const reply of replies) {
        const id = randomUUID();
        // A millisecond apart, so the order they were decided is the order they are shown.
        const createdAt = new Date(at++);
        await tx.message.create({
          data: {
            id,
            createdAt,
            orgId,
            conversationId: conversation.id,
            direction: 'outbound',
            type: 'text',
            status: 'queued',
            body: reply.text,
            content: {
              automation: reply.kind,
              ...(reply.ruleId ? { ruleId: reply.ruleId } : {}),
            } as Prisma.InputJsonValue,
          },
        });
        queued.push({ messageId: id, createdAt });
      }

      // ---- assignment and SLA
      const notices: Notice[] = [];
      const data: Prisma.ConversationUpdateInput = {};
      const last = replies.at(-1);
      if (last) {
        data.lastMessageAt = new Date(at - 1);
        data.lastMessagePreview = messagePreview('text', last.text);
      }
      if (conversation.status === 'open' && !conversation.assigneeId) {
        const agent = await chooseAgent(tx, {
          orgId,
          phoneId: conversation.phoneId,
          tagIds: contact.tags.map((t) => t.tagId),
          text,
          defaultAssignment: (settings?.defaultAssignment ?? 'none') as DefaultAssignment,
        });
        if (agent) {
          data.assignee = { connect: { id: agent } };
          notices.push({
            userId: agent,
            kind: 'conversation_assigned',
            title: `New conversation with ${contactLabel(contact)}`,
            body: messagePreview(message.type, message.body),
            conversationId: conversation.id,
          });
        }
      }
      // The clock starts at the first message nobody has answered, and later ones do not move it.
      if (settings?.slaEnabled && !conversation.awaitingReplySince) {
        data.awaitingReplySince = message.createdAt;
        data.slaDueAt = new Date(
          message.createdAt.getTime() + settings.slaFirstResponseMinutes * MINUTE_MS,
        );
        data.slaStage = 0;
      }

      await notify(tx, orgId, notices);
      const updated = Object.keys(data).length
        ? await tx.conversation.update({
            where: { id: conversation.id },
            data,
            include: conversationInclude,
          })
        : null;
      const messages = queued.length
        ? await tx.message.findMany({
            where: { id: { in: queued.map((q) => q.messageId) }, conversationId: conversation.id },
            include: messageInclude,
            orderBy: { createdAt: 'asc' },
          })
        : [];
      return { queued, updated, messages, notices, advance: flows.advance };
    },
    { timeout: 20_000 },
  );
  if (!result) return 'skipped';

  for (const m of result.messages)
    deps.publisher.emit(orgId, 'message:new', { message: messageToDto(m) });
  if (result.updated) {
    deps.publisher.emit(orgId, 'conversation:updated', {
      conversation: conversationToDto(result.updated),
    });
  }
  for (const n of result.notices)
    deps.publisher.emit(orgId, 'notification:new', { userId: n.userId });
  for (const runId of result.advance) await deps.enqueueFlowJob({ kind: 'advance', orgId, runId });
  // Through the outbound queue like every send, so the per-number limit and retries apply.
  for (const q of result.queued) {
    await deps.enqueueOutbound({
      orgId,
      messageId: q.messageId,
      createdAt: q.createdAt.toISOString(),
    });
  }
  return 'done';
}

// ------------------------------------------------------------------ SLA

export function slaDueConversations(deps: Pick<WorkerDeps, 'db'>, limit = 500) {
  return deps.db.$queryRaw<{ org_id: string; id: string }[]>`
    SELECT org_id, id FROM sla_due_conversations(${limit}::int)`;
}

/**
 * A conversation past its SLA. The first time it breaches: tell the assignee, or the managers when
 * nobody has it. If escalation is on, the next time: tell the managers, and reassign if asked.
 */
export async function checkSla(
  deps: WorkerDeps,
  orgId: string,
  conversationId: string,
): Promise<'breached' | 'escalated' | 'cleared' | 'skipped'> {
  const now = new Date();
  const result = await withTenant(deps.db, { orgId }, async (tx) => {
    // Reviewed raw SQL: a row lock under RLS, so two checks cannot both act on one breach.
    await tx.$queryRaw`SELECT 1 FROM conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
    const conversation = await tx.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: { include: { tags: { select: { tagId: true } } } } },
    });
    if (!conversation?.slaDueAt || conversation.slaDueAt > now) return null;
    const settings = await tx.automationSettings.findUnique({ where: { orgId } });
    if (!settings?.slaEnabled || conversation.status !== 'open') {
      const updated = await tx.conversation.update({
        where: { id: conversationId },
        data: { slaDueAt: null },
        include: conversationInclude,
      });
      return { outcome: 'cleared' as const, updated, notices: [] as Notice[] };
    }

    const who = contactLabel(conversation.contact);
    const notices: Notice[] = [];
    const data: Prisma.ConversationUpdateInput = {};
    if (conversation.slaStage === 0) {
      const recipients = conversation.assigneeId
        ? [conversation.assigneeId]
        : await managers(tx, orgId);
      for (const userId of recipients) {
        notices.push({
          userId,
          kind: 'sla_breached',
          title: `${who} has waited over ${settings.slaFirstResponseMinutes} minutes for a reply`,
          body: conversation.lastMessagePreview,
          conversationId,
        });
      }
      data.slaStage = 1;
      data.slaDueAt = settings.slaEscalateAfterMinutes
        ? new Date(now.getTime() + settings.slaEscalateAfterMinutes * MINUTE_MS)
        : null;
    } else {
      let reassignedTo: string | null = null;
      if (settings.slaReassignOnEscalate) {
        reassignedTo = await chooseAgent(tx, {
          orgId,
          phoneId: conversation.phoneId,
          tagIds: conversation.contact.tags.map((t) => t.tagId),
          text: null,
          defaultAssignment:
            settings.defaultAssignment === 'none'
              ? 'load_based'
              : (settings.defaultAssignment as DefaultAssignment),
          exclude: conversation.assigneeId,
        });
        if (reassignedTo) {
          data.assignee = { connect: { id: reassignedTo } };
          notices.push({
            userId: reassignedTo,
            kind: 'conversation_assigned',
            title: `Reassigned to you: ${who} is waiting for a reply`,
            body: conversation.lastMessagePreview,
            conversationId,
          });
        }
      }
      for (const userId of await managers(tx, orgId)) {
        notices.push({
          userId,
          kind: 'sla_escalated',
          title: `Escalated: ${who} is still waiting for a reply`,
          body: reassignedTo ? 'Reassigned to someone available.' : conversation.lastMessagePreview,
          conversationId,
        });
      }
      data.slaStage = 2;
      data.slaDueAt = null;
    }
    await notify(tx, orgId, notices);
    const updated = await tx.conversation.update({
      where: { id: conversationId },
      data,
      include: conversationInclude,
    });
    return {
      outcome: conversation.slaStage === 0 ? ('breached' as const) : ('escalated' as const),
      updated,
      notices,
    };
  });
  if (!result) return 'skipped';
  deps.publisher.emit(orgId, 'conversation:updated', {
    conversation: conversationToDto(result.updated),
  });
  for (const n of result.notices)
    deps.publisher.emit(orgId, 'notification:new', { userId: n.userId });
  return result.outcome;
}
