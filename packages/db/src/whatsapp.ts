import type { TenantTx } from './tenant';

/**
 * Soft-disconnect a WABA and everything under it inside a tenant transaction: wipes tokens and
 * PINs, keeps history. Returns the phone_number_ids affected so callers can drop cached clients.
 * Shared by the API (user disconnects) and the worker (Meta deauthorize / deletion / uninstall).
 */
export async function disconnectWabaTx(
  tx: TenantTx,
  wabaAccountId: string,
  reason: string,
  options: { eraseMetaUser?: boolean } = {},
): Promise<string[]> {
  const now = new Date();
  const phones = await tx.phoneNumber.findMany({
    where: { wabaAccountId },
    select: { phoneNumberId: true },
  });
  await tx.phoneNumber.updateMany({
    where: { wabaAccountId },
    data: {
      status: 'disconnected',
      statusReason: reason,
      accessTokenEnc: null,
      registrationPinEnc: null,
      disconnectedAt: now,
    },
  });
  await tx.wabaAccount.update({
    where: { id: wabaAccountId },
    data: {
      status: 'disconnected',
      disconnectedAt: now,
      ...(options.eraseMetaUser ? { metaUserId: null } : {}),
    },
  });
  return phones.map((p) => p.phoneNumberId);
}
