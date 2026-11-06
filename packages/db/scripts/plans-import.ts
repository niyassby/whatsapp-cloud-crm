/**
 * Load plans and prices from a JSON file: pnpm plans:import <file.json>, with the path relative to
 * packages/db. An operator tool using the owner connection, since the app role can only read these
 * tables. Prices not in the file for an imported plan are removed, so the file is the whole truth
 * about the plans it lists.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decimalToMicros, plansFileSchema } from '@wacrm/shared';
import { config as loadDotenv } from 'dotenv';
import { createPrismaClient } from '../src/client';

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const [file] = process.argv.slice(2);
if (!file) {
  console.error('Usage: pnpm plans:import <file.json>');
  process.exit(1);
}
const directUrl = process.env.DIRECT_URL;
if (!directUrl) {
  console.error('DIRECT_URL is not set');
  process.exit(1);
}

const parsed = plansFileSchema.parse(
  JSON.parse(readFileSync(path.resolve(process.cwd(), file), 'utf8')),
);
const db = createPrismaClient({ connectionString: directUrl });

async function main() {
  for (const { prices, ...plan } of parsed.plans) {
    await db.$transaction(async (tx) => {
      const row = await tx.plan.upsert({
        where: { code: plan.code },
        create: plan,
        update: plan,
      });
      await tx.planPrice.deleteMany({ where: { planId: row.id } });
      for (const { amount, ...price } of prices) {
        const micros = decimalToMicros(amount);
        if (micros === null) throw new Error(`Bad amount for ${plan.code}: ${amount}`);
        await tx.planPrice.create({
          data: { ...price, planId: row.id, amountMicros: BigInt(micros) },
        });
      }
    });
    console.log(`${plan.code}: ${prices.length} prices`);
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
