/**
 * Load rate cards from a CSV file. Rows are added, never changed: a new price is a new row with a
 * later valid_from, so past charges keep the rate they were made at. Safe to run again.
 *
 *   pnpm rates:import path/to/rates.csv
 *
 * Columns: country,category,currency,rate,valid_from
 * country is a two-letter code, or * for any country with no rate of its own.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AI_RATE_CATEGORIES,
  decimalToMicros,
  RATE_ANY_COUNTRY,
  RATE_CATEGORIES,
} from '@wacrm/shared';
import { config as loadDotenv } from 'dotenv';
import { createPrismaClient } from '../src/client';

/** Message categories are priced per message; AI categories per million tokens. */
const CATEGORIES: string[] = [...RATE_CATEGORIES, ...Object.values(AI_RATE_CATEGORIES)];

loadDotenv({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

export interface RateRow {
  country: string;
  category: string;
  currency: string;
  rateMicros: bigint;
  validFrom: Date;
}

export function parseRateCsv(text: string): RateRow[] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const header = lines.shift();
  if (header?.toLowerCase() !== 'country,category,currency,rate,valid_from') {
    throw new Error('The first line must be: country,category,currency,rate,valid_from');
  }
  return lines.map((line, i) => {
    const row = i + 2;
    const [country, category, currency, rate, validFrom] = line.split(',').map((c) => c.trim());
    if (country !== RATE_ANY_COUNTRY && !/^[A-Z]{2}$/.test(country ?? '')) {
      throw new Error(`Row ${row}: country must be a two-letter code or *`);
    }
    if (!CATEGORIES.includes(category ?? '')) {
      throw new Error(`Row ${row}: category must be one of ${CATEGORIES.join(', ')}`);
    }
    if (!/^[A-Z]{3}$/.test(currency ?? '')) throw new Error(`Row ${row}: bad currency`);
    const micros = decimalToMicros(rate ?? '');
    if (micros === null) throw new Error(`Row ${row}: bad rate`);
    const date = new Date(validFrom ?? '');
    if (Number.isNaN(date.getTime())) throw new Error(`Row ${row}: bad valid_from`);
    return {
      country: country as string,
      category: category as string,
      currency: currency as string,
      rateMicros: BigInt(micros),
      validFrom: date,
    };
  });
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: rates-import <file.csv>');
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('DIRECT_URL is required');
  const rows = parseRateCsv(readFileSync(path.resolve(process.cwd(), file), 'utf8'));
  const prisma = createPrismaClient({ connectionString: url });
  const res = await prisma.rateCard.createMany({ data: rows, skipDuplicates: true });
  await prisma.$disconnect();
  console.log(`${rows.length} rows read, ${res.count} added`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
