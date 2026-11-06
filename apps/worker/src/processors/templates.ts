import { applyTemplateSync, type MetaTemplateSnapshot, withTenant } from '@wacrm/db';
import type { TemplateSyncJob } from '@wacrm/shared';
import { RetryableJobError, type WorkerDeps } from '../deps';

/** Every org and WABA with a connected number. Runs before any org context exists. */
export function templateSyncTargets(deps: Pick<WorkerDeps, 'db'>) {
  return deps.db.$queryRaw<{ org_id: string; waba_account_id: string }[]>`
    SELECT org_id, waba_account_id FROM template_sync_targets()`;
}

/**
 * Make one WABA's templates match Meta's full list. Webhooks keep things current, and this catches
 * whatever they miss: templates made in Meta's tools, and anything lost in a delivery failure.
 */
export async function syncTemplates(deps: WorkerDeps, job: TemplateSyncJob): Promise<number> {
  const { orgId, wabaAccountId } = job;
  const phone = await withTenant(deps.db, { orgId }, (tx) =>
    tx.phoneNumber.findFirst({
      where: { wabaAccountId, status: 'connected' },
      select: { phoneNumberId: true },
    }),
  );
  if (!phone) return 0; // Disconnected since this was queued.

  const gateway = await deps.whatsapp.get({ orgId, phoneNumberId: phone.phoneNumberId });
  const templates: MetaTemplateSnapshot[] = [];
  let after: string | undefined;
  do {
    const page = await gateway.listTemplates({ limit: 100, after });
    if (page.error) {
      if (page.error.retryable) throw new RetryableJobError(page.error.message);
      throw new Error(page.error.message);
    }
    templates.push(...page.data.items);
    after = page.data.nextCursor;
  } while (after);

  const { changed } = await withTenant(
    deps.db,
    { orgId },
    (tx) => applyTemplateSync(tx, { orgId, wabaAccountId, templates }),
    { timeout: 30_000 },
  );
  if (changed > 0) deps.publisher.emit(orgId, 'template:updated', { templateId: null });
  return changed;
}
