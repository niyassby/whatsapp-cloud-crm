import { type DbClient, disconnectWabaTx, withTenant } from '@wacrm/db';
import type { MetaAccountJob } from '@wacrm/shared';

/**
 * Meta's deauthorize and data deletion callbacks, keyed by the app-scoped Facebook user who
 * connected a WABA. Both wipe the credentials and disconnect; deletion also erases the stored
 * Facebook user id and closes the request. Conversation data belongs to the workspace (the
 * data controller) and is not removed here. Safe to run twice.
 */
export async function processMetaAccountJob(db: DbClient, job: MetaAccountJob): Promise<number> {
  const connections = await db.$queryRaw<{ org_id: string; waba_account_id: string }[]>`
    SELECT * FROM meta_connections_by_user(${job.metaUserId})`;
  const reason =
    job.kind === 'deauthorize' ? 'Deauthorized on Facebook' : 'Meta data deletion request';

  for (const c of connections) {
    await withTenant(db, { orgId: c.org_id }, async (tx) => {
      const waba = await tx.wabaAccount.findUniqueOrThrow({
        where: { id: c.waba_account_id },
        select: { status: true },
      });
      const eraseMetaUser = job.kind === 'data_deletion';
      if (waba.status === 'active') {
        await disconnectWabaTx(tx, c.waba_account_id, reason, { eraseMetaUser });
        await tx.auditLog.create({
          data: {
            orgId: c.org_id,
            action: 'whatsapp.disconnected',
            targetType: 'waba_account',
            targetId: c.waba_account_id,
            metadata: { reason },
          },
        });
      } else if (eraseMetaUser) {
        await tx.wabaAccount.update({
          where: { id: c.waba_account_id },
          data: { metaUserId: null },
        });
      }
    });
  }

  if (job.kind === 'data_deletion') {
    await db.$executeRaw`SELECT data_deletion_complete(${job.requestId}::uuid)`;
  }
  return connections.length;
}
