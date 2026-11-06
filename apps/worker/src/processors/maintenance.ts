import { type DbClient, withDbContext, withTenant } from '@wacrm/db';
import { phonePinAad, phoneTokenAad, type SecretBox, totpAad } from '@wacrm/shared/server';

/** Delete raw webhook payloads past retention. Returns how many rows went. */
export async function purgeWebhookEvents(
  db: DbClient,
  retentionDays: number,
  now = new Date(),
): Promise<number> {
  const before = new Date(now.getTime() - retentionDays * 86_400_000);
  const [row] = await db.$queryRaw<{ n: number }[]>`SELECT webhook_events_purge(${before}) AS n`;
  return row?.n ?? 0;
}

const PARTITION_ATTEMPTS = 3;

/**
 * Create this month's and upcoming message partitions. Returns how many were new. Adding a
 * partition can deadlock with messages being inserted, in which case Postgres cancels one side, so
 * this tries again. Partitions are made months ahead, so waiting a moment costs nothing.
 */
export async function ensureMessagePartitions(db: DbClient, now = new Date()): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      const [row] = await db.$queryRaw<{ n: number }[]>`
        SELECT ensure_message_partitions(${now.toISOString().slice(0, 10)}::date, 4) AS n`;
      return row?.n ?? 0;
    } catch (err) {
      const deadlock = err instanceof Error && err.message.includes('deadlock detected');
      if (!deadlock || attempt >= PARTITION_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

/**
 * Key rotation: rewrite every secret still under an old key. Ciphertext is bound to its row, so
 * each value is decrypted and encrypted with the same AAD. Runs under RLS and is safe to re-run.
 * A row that cannot be decrypted does not stop the rotation: it is reported in `failed`, and the
 * old key must stay until those rows are resolved.
 */
export async function reencryptSecrets(
  db: DbClient,
  box: SecretBox,
): Promise<{ phoneNumbers: number; users: number; failed: string[] }> {
  const refresh = (value: string | null, aad: string) =>
    value && box.needsReencrypt(value) ? box.encrypt(box.decrypt(value, aad), aad) : null;
  let phoneNumbers = 0;
  let users = 0;
  const failed: string[] = [];

  const phones = await db.$queryRaw<{ id: string; org_id: string }[]>`
    SELECT * FROM secrets_list_phone_numbers()`;
  for (const { id, org_id: orgId } of phones) {
    const run = withTenant(db, { orgId }, async (tx) => {
      const row = await tx.phoneNumber.findUniqueOrThrow({
        where: { id },
        select: { accessTokenEnc: true, registrationPinEnc: true },
      });
      const accessTokenEnc = refresh(row.accessTokenEnc, phoneTokenAad(id));
      const registrationPinEnc = refresh(row.registrationPinEnc, phonePinAad(id));
      if (!accessTokenEnc && !registrationPinEnc) return;
      await tx.phoneNumber.update({
        where: { id },
        data: {
          ...(accessTokenEnc ? { accessTokenEnc } : {}),
          ...(registrationPinEnc ? { registrationPinEnc } : {}),
        },
      });
      phoneNumbers++;
    });
    await run.catch(() => failed.push(`phone_numbers:${id}`));
  }

  const totpUsers = await db.$queryRaw<{ id: string }[]>`SELECT * FROM secrets_list_totp_users()`;
  for (const { id: userId } of totpUsers) {
    const run = withDbContext(db, { userId }, async (tx) => {
      const row = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { totpSecretEnc: true },
      });
      const totpSecretEnc = refresh(row.totpSecretEnc, totpAad(userId));
      if (!totpSecretEnc) return;
      await tx.user.update({ where: { id: userId }, data: { totpSecretEnc } });
      users++;
    });
    await run.catch(() => failed.push(`users:${userId}`));
  }
  return { phoneNumbers, users, failed };
}
