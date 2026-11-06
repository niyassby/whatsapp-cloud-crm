/**
 * Add money to a workspace's wallet by hand, recorded in its ledger as an adjustment. An operator
 * tool for development and support: real top-ups arrive through payment webhooks (Phase 2.5).
 *
 *   pnpm wallet:credit <org slug or id> <amount> "<reason>"
 *
 * Each run is a separate adjustment. An optional fourth argument is an idempotency key, for
 * scripts that may run twice.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { decimalToMicros, microsToDecimal } from '@wacrm/shared';
import { config as loadDotenv } from 'dotenv';
import { createPrismaClient } from '../src/client';
import { withTenant } from '../src/tenant';
import { creditWallet, ensureWallet } from '../src/wallet';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const [org, amount, reason, key] = process.argv.slice(2);
  if (!org || !amount || !reason) {
    throw new Error('Usage: wallet-credit <org slug or id> <amount> "<reason>" [key]');
  }
  const micros = decimalToMicros(amount);
  if (!micros) throw new Error('The amount must be a positive number, like 500 or 49.50');
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('DIRECT_URL is required');
  const prisma = createPrismaClient({ connectionString: url });
  try {
    // A slug only resolves where this login can read every org. Otherwise pass the id.
    const orgId = UUID.test(org)
      ? org
      : (
          await prisma.$queryRaw<{ id: string }[]>`
            SELECT id::text AS id FROM organizations WHERE slug = ${org}`
        )[0]?.id;
    if (!orgId) throw new Error(`No workspace with the slug ${org}`);
    const currency = process.env.WALLET_DEFAULT_CURRENCY ?? 'INR';
    const move = await withTenant(prisma, { orgId }, async (tx) => {
      await ensureWallet(tx, orgId, currency);
      return creditWallet(tx, {
        orgId,
        type: 'adjustment',
        amountMicros: micros,
        referenceType: 'manual',
        idempotencyKey: key ?? `manual:${randomUUID()}`,
        description: reason,
      });
    });
    console.log(
      move.applied
        ? `Added ${microsToDecimal(micros)}. Balance is now ${microsToDecimal(move.balanceAfterMicros)}.`
        : `Already applied. Balance is ${microsToDecimal(move.balanceAfterMicros)}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
