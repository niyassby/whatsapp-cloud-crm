import { randomUUID } from 'node:crypto';
import { chargeMessage, type Prisma, withTenant, whatsappChannelId } from '@wacrm/db';
import {
  AppError,
  buildSendComponents,
  canReceiveMarketing,
  cleanVariableValue,
  ErrorCode,
  type FieldValue,
  headerMediaKind,
  isMarketingCategory,
  type MediaHeaderFormat,
  messagePreview,
  renderedText,
  renderTemplate,
  resolveVariable,
  templateDefinitionSchema,
  templateVariables,
  type VariableSource,
} from '@wacrm/shared';
import { countryOfWaId } from '@wacrm/shared/server';
import { RetryableJobError, type WorkerDeps } from '../deps';
import { sendOutboundMessage } from './outbound';

const BATCH = 100;
const RETRY_LATER_MS = 3600_000;
const MAX_ATTEMPTS = 3;

const MINUTE = 60_000;

/** Enrollments due now, across every org. Reviewed raw SQL, returning only ids. */
export function dripTargets(deps: Pick<WorkerDeps, 'db'>) {
  return deps.db.$queryRaw<{ org_id: string; sequence_id: string }[]>`
    SELECT org_id, sequence_id FROM drip_due_targets()`;
}

/**
 * Send what is due in one sequence. Each enrollment moves on in the transaction that creates its
 * message, so a crash or a second run cannot send the same step twice.
 */
export async function runDripBatch(
  deps: WorkerDeps,
  orgId: string,
  sequenceId: string,
): Promise<{ sent: number; more: boolean }> {
  const loaded = await withTenant(deps.db, { orgId }, async (tx) => {
    const sequence = await tx.dripSequence.findUnique({
      where: { id: sequenceId },
      include: {
        phone: { select: { id: true, status: true } },
        steps: { orderBy: { position: 'asc' }, include: { template: true } },
      },
    });
    if (!sequence || sequence.status !== 'active') return null;
    const due = await tx.dripEnrollment.findMany({
      where: { sequenceId, status: 'active', nextRunAt: { lte: new Date() } },
      orderBy: { nextRunAt: 'asc' },
      take: BATCH,
      include: {
        contact: { include: { tags: { select: { tagId: true } } } },
      },
    });
    return { sequence, due };
  });
  if (!loaded || loaded.sequence.phone.status !== 'connected') return { sent: 0, more: false };
  const { sequence, due } = loaded;
  let sent = 0;

  for (const enrollment of due) {
    const { contact } = enrollment;
    const step = sequence.steps[enrollment.nextStep];

    const end = (status: 'completed' | 'exited', exitReason: string | null) =>
      withTenant(deps.db, { orgId }, (tx) =>
        tx.dripEnrollment.update({
          where: { id: enrollment.id },
          data: { status, exitReason, nextRunAt: null },
        }),
      );
    const later = () =>
      withTenant(deps.db, { orgId }, (tx) =>
        tx.dripEnrollment.update({
          where: { id: enrollment.id },
          data: { nextRunAt: new Date(Date.now() + RETRY_LATER_MS) },
        }),
      );

    if (!step) {
      await end('completed', null);
      continue;
    }
    // Exit conditions, checked again here in case the event was missed.
    if (contact.optInStatus === 'opted_out') {
      await end('exited', 'opted_out');
      continue;
    }
    if (contact.deletedAt || contact.mergedIntoId) {
      await end('exited', 'contact_removed');
      continue;
    }
    if (sequence.exitTagId && contact.tags.some((t) => t.tagId === sequence.exitTagId)) {
      await end('exited', 'tagged');
      continue;
    }
    if (
      sequence.exitOnReply &&
      contact.lastActivityAt &&
      contact.lastActivityAt > enrollment.enrolledAt
    ) {
      await end('exited', 'replied');
      continue;
    }

    const parsed = templateDefinitionSchema.safeParse(step.template.definition);
    if (!parsed.success || step.template.status !== 'approved') {
      // A paused template may come back, so wait rather than end the sequence.
      await later();
      continue;
    }
    if (isMarketingCategory(step.template.category) && !canReceiveMarketing(contact.optInStatus)) {
      await end('exited', 'no_consent');
      continue;
    }

    const definition = parsed.data;
    const mapping = step.variableMapping as Record<string, VariableSource>;
    const templateContact = {
      name: contact.name,
      waId: contact.waId,
      email: contact.email,
      customFields: (contact.customFields ?? {}) as Record<string, FieldValue>,
    };
    const values: Record<string, string> = {};
    let missing = false;
    for (const v of templateVariables(definition)) {
      const button = definition.buttons[v.buttonIndex ?? -1];
      const value = cleanVariableValue(
        resolveVariable(mapping[v.key], templateContact) ||
          (button?.type === 'COPY_CODE' ? button.example : ''),
      );
      if (!value) missing = true;
      values[v.key] = value;
    }
    if (missing) {
      await end('exited', 'missing_variable');
      continue;
    }

    const messageId = randomUUID();
    const createdAt = new Date();
    const nextStep = enrollment.nextStep + 1;
    const following = sequence.steps[nextStep];
    const mediaHeader =
      definition.header && definition.header.format !== 'TEXT'
        ? (definition.header.format as MediaHeaderFormat)
        : null;
    const body = renderedText(renderTemplate(definition, values));
    const preview = messagePreview('template', body);

    let created: boolean;
    try {
      created = await withTenant(deps.db, { orgId }, async (tx) => {
        // Moves the enrollment only if it is still on this step: a second run finds no match.
        const moved = await tx.dripEnrollment.updateMany({
          where: {
            id: enrollment.id,
            status: 'active',
            nextStep: enrollment.nextStep,
          },
          data: following
            ? {
                nextStep,
                nextRunAt: new Date(Date.now() + following.delayMinutes * MINUTE),
              }
            : { nextStep, status: 'completed', nextRunAt: null },
        });
        if (moved.count === 0) return false;

        const channelId = await whatsappChannelId(tx, sequence.phoneId);
        const conversation = await tx.conversation.upsert({
          where: {
            orgId_channelId_contactId: { orgId, channelId, contactId: contact.id },
          },
          create: {
            orgId,
            channelId,
            phoneId: sequence.phoneId,
            contactId: contact.id,
            status: 'closed',
            lastMessageAt: createdAt,
            lastMessagePreview: preview,
          },
          update: { lastMessageAt: createdAt, lastMessagePreview: preview },
          select: { id: true, windowExpiresAt: true },
        });
        const wallet = await tx.wallet.findUnique({
          where: { orgId },
          select: { currency: true },
        });
        await chargeMessage(tx, {
          orgId,
          messageId,
          category: step.template.category,
          country: countryOfWaId(contact.waId),
          windowOpen: Boolean(
            conversation.windowExpiresAt && conversation.windowExpiresAt > new Date(),
          ),
          defaults: { currency: wallet?.currency ?? deps.defaultCurrency, thresholdMicros: null },
        });
        await tx.message.create({
          data: {
            id: messageId,
            createdAt,
            orgId,
            conversationId: conversation.id,
            direction: 'outbound',
            type: 'template',
            status: 'queued',
            body,
            content: {
              templateId: step.templateId,
              templateName: step.template.name,
              language: step.template.language,
              components: buildSendComponents(definition, values),
              category: step.template.category,
              dripSequenceId: sequenceId,
              ...(mediaHeader ? { headerKind: headerMediaKind(mediaHeader) } : {}),
            } as unknown as Prisma.InputJsonValue,
            ...(mediaHeader && step.template.headerMediaKey
              ? {
                  mediaKey: step.template.headerMediaKey,
                  mediaMime: step.template.headerMediaMime,
                  mediaFilename: step.template.headerMediaName,
                  mediaStatus: 'stored' as const,
                }
              : {}),
          },
        });
        return true;
      });
    } catch (err) {
      if (
        err instanceof AppError &&
        (err.code === ErrorCode.INSUFFICIENT_BALANCE || err.code === ErrorCode.RATE_NOT_CONFIGURED)
      ) {
        // Rolled back, so this step tries again later rather than being lost.
        await later();
        continue;
      }
      throw err;
    }
    if (!created) continue;

    const job = { orgId, messageId, createdAt: createdAt.toISOString() };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await sendOutboundMessage(deps, job, { finalAttempt: attempt === MAX_ATTEMPTS });
        break;
      } catch (err) {
        if (!(err instanceof RetryableJobError)) throw err;
      }
    }
    sent++;
  }
  return { sent, more: due.length === BATCH };
}
