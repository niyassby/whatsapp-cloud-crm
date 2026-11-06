import { z } from 'zod';

/**
 * Money is whole micro-units (1 rupee = 1,000,000) in a BIGINT. Meta's rates have up to four
 * decimals, which floats cannot hold exactly, and a ledger must add up to the last unit.
 */
export const MICROS = 1_000_000;

/** Exact conversion from text such as "0.0099". Null when it is not a valid amount. */
export function decimalToMicros(text: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * MICROS + Number((match[2] ?? '').padEnd(6, '0'));
}

/** Plain decimal text, for CSV files and form fields. Exact, with trailing zeros removed. */
export function microsToDecimal(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / MICROS);
  const fraction = String(abs % MICROS)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Shows at least two decimals, and more when a rate needs them. */
export function formatMoney(micros: number, currency: string): string {
  const value = Number(microsToDecimal(micros));
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

export const WALLET_ENTRY_TYPES = ['credit', 'debit', 'refund', 'adjustment'] as const;
export type WalletEntryType = (typeof WALLET_ENTRY_TYPES)[number];

export const RATE_CATEGORIES = ['marketing', 'utility', 'authentication', 'service'] as const;
export type RateCategory = (typeof RATE_CATEGORIES)[number];

/** A rate that applies to any country with no rate of its own. */
export const RATE_ANY_COUNTRY = '*';

/** Reference type for charges on a message. Its id is the message id. */
export const messageDebitKey = (messageId: string) => `debit:message:${messageId}`;

/**
 * Meta does not charge utility templates sent inside an open customer service window, or
 * ordinary replies. Marketing and authentication are charged whenever they are sent.
 */
export function isChargeable(category: string, windowOpen: boolean): boolean {
  const c = category.toLowerCase();
  if (c === 'service') return false;
  if (c === 'utility' && windowOpen) return false;
  return true;
}

const dateParam = z.iso.datetime({ offset: true }).optional();

export const listLedgerSchema = z.object({
  type: z.enum(WALLET_ENTRY_TYPES).optional(),
  from: dateParam,
  to: dateParam,
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListLedgerQuery = z.infer<typeof listLedgerSchema>;

export const walletRangeSchema = z.object({ from: dateParam, to: dateParam });
export type WalletRangeQuery = z.infer<typeof walletRangeSchema>;

export const updateWalletSchema = z.object({
  /** In the wallet's currency, as text. Null turns the alert off. */
  lowBalanceThreshold: z
    .string()
    .trim()
    .refine((v) => decimalToMicros(v) !== null, 'Enter an amount, like 100 or 49.50')
    .nullable(),
});
export type UpdateWalletInput = z.infer<typeof updateWalletSchema>;

export interface WalletDto {
  currency: string;
  balanceMicros: number;
  /** Held for campaigns that are running. */
  reservedMicros: number;
  /** What new sends can use. */
  availableMicros: number;
  lowBalanceThresholdMicros: number | null;
  lowBalance: boolean;
}

export interface LedgerEntryDto {
  id: string;
  type: WalletEntryType;
  /** Positive adds to the balance. Negative takes from it. */
  amountMicros: number;
  balanceAfterMicros: number;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  /** The rate applied at the time, kept even if the rate card changes later. */
  rate: { micros: number; country: string | null; category: string | null } | null;
  createdAt: string;
}

export interface WalletUsageRow {
  category: string;
  /** Charges after refunds. */
  messages: number;
  /** What those messages cost after refunds, as a positive number. */
  costMicros: number;
}

export interface WalletUsageDto {
  currency: string;
  rows: WalletUsageRow[];
  totalMicros: number;
}

export interface RateDto {
  country: string;
  category: string;
  currency: string;
  rateMicros: number;
  validFrom: string;
}
