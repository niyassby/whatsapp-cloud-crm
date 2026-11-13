import { z } from 'zod';
import { PLAN_FEATURES, type PlanFeature, type PlanLimit } from './billing';
import { decimalToMicros } from './wallet';

/**
 * Resellers (Section 4.1). A partner creates client workspaces, sets their limits and a markup on
 * what the wallet charges, and is invoiced by the platform at wholesale. This module is the one
 * place for the money rules, so the API, the worker and the tests agree.
 */

// ------------------------------------------------------------------ money

/** The most a partner may add on top of the rate card: 200%. Also a CHECK in the database. */
export const MAX_MARKUP_BPS = 20_000;

/**
 * A wholesale amount with the partner's markup added. Rounded up to a whole micro, so the
 * platform's share (the wholesale amount) is never short and the margin is never negative.
 */
export function applyMarkup(wholesaleMicros: number, markupBps: number): number {
  if (markupBps <= 0 || wholesaleMicros <= 0) return wholesaleMicros;
  return Math.ceil((wholesaleMicros * (10_000 + markupBps)) / 10_000);
}

/** The statement a moment belongs to: `YYYY-MM` in UTC. */
export function periodOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

export function previousPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return periodOf(new Date(Date.UTC(year, month - 2, 1)));
}

export const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

export const PARTNER_LEDGER_TYPES = ['usage', 'usage_refund', 'plan_fee', 'adjustment'] as const;
export type PartnerLedgerType = (typeof PARTNER_LEDGER_TYPES)[number];

// ------------------------------------------------------------------ impersonation

/** How long one impersonation lasts. It is not renewed: start another, with a reason. */
export const IMPERSONATION_TTL_SECONDS = 30 * 60;

// ------------------------------------------------------------------ input

const money = (min: number) =>
  z
    .string()
    .trim()
    .refine((v) => {
      const micros = decimalToMicros(v);
      return micros !== null && micros >= min && micros <= 10_000_000 * 1_000_000;
    }, 'Enter a valid amount');

const limit = z.number().int().min(0).max(100_000_000).nullable();

export const clientLimitsSchema = z.object({
  seats: limit.optional(),
  numbers: limit.optional(),
  contacts: limit.optional(),
});
export type ClientLimitsInput = z.infer<typeof clientLimitsSchema>;

export const createClientSchema = z.object({
  name: z.string().trim().min(2).max(80),
  ownerEmail: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  planCode: z.string().min(1).max(40),
  timezone: z.string().max(64).optional(),
  limits: clientLimitsSchema.optional(),
  /** What the partner charges this client a month, as a decimal string. */
  clientPrice: money(0).nullable().optional(),
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

export const updateClientSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  planCode: z.string().min(1).max(40).optional(),
  limits: clientLimitsSchema.optional(),
  clientPrice: money(0).nullable().optional(),
});
export type UpdateClientInput = z.infer<typeof updateClientSchema>;

export const inviteOwnerSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
});

export const walletCreditSchema = z.object({
  amount: money(1),
  note: z.string().trim().min(3).max(200),
  /** Chosen by the caller, so a repeated request credits once. */
  idempotencyKey: z.string().min(8).max(100),
});
export type WalletCreditInput = z.infer<typeof walletCreditSchema>;

export const impersonateSchema = z.object({ reason: z.string().trim().min(5).max(300) });
export type ImpersonateInput = z.infer<typeof impersonateSchema>;

export const updatePartnerSelfSchema = z.object({
  walletMarkupBps: z.number().int().min(0).max(MAX_MARKUP_BPS),
});

const currency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'Use a three-letter currency code')
  .transform((v) => v.toUpperCase());

export const createPartnerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  currency,
  maxClients: z.number().int().min(0).nullable().default(null),
  walletMarkupBps: z.number().int().min(0).max(MAX_MARKUP_BPS).default(0),
  /** An existing account that will run this partner. */
  adminEmail: z
    .email()
    .transform((v) => v.toLowerCase())
    .optional(),
});
export type CreatePartnerInput = z.infer<typeof createPartnerSchema>;

export const updatePartnerSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  maxClients: z.number().int().min(0).nullable().optional(),
  walletMarkupBps: z.number().int().min(0).max(MAX_MARKUP_BPS).optional(),
});
export type UpdatePartnerInput = z.infer<typeof updatePartnerSchema>;

export const partnerMemberSchema = z.object({
  email: z.email().transform((v) => v.toLowerCase()),
});

export const updatePlanSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  seats: z.number().int().positive().nullable().optional(),
  numbers: z.number().int().positive().nullable().optional(),
  contacts: z.number().int().positive().nullable().optional(),
  features: z.array(z.enum(PLAN_FEATURES)).optional(),
  isPublic: z.boolean().optional(),
});
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

export const wholesalePriceSchema = z.object({
  currency,
  /** A month at wholesale, as a decimal string. Null removes the price. */
  amount: money(0).nullable(),
});
export type WholesalePriceInput = z.infer<typeof wholesalePriceSchema>;

export const createRateCardSchema = z.object({
  country: z
    .string()
    .trim()
    .regex(/^([A-Za-z]{2}|\*)$/, 'Use a two-letter country code, or * for any')
    .transform((v) => v.toUpperCase()),
  category: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z_]+$/, 'Lower-case letters and underscores')
    .transform((v) => v.toLowerCase()),
  currency,
  /** Price per message (or per million tokens for AI categories), as a decimal string. */
  rate: z
    .string()
    .trim()
    .refine((v) => decimalToMicros(v) !== null, 'Enter a valid rate'),
  validFrom: z.iso.datetime().optional(),
});
export type CreateRateCardInput = z.infer<typeof createRateCardSchema>;

export const adminOrgListSchema = z.object({
  search: z.string().trim().max(80).optional(),
  partnerId: z.uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AdminOrgListQuery = z.infer<typeof adminOrgListSchema>;

export const setOrgPlanSchema = z.object({ planCode: z.string().min(1).max(40) });

export const partnerLedgerQuerySchema = z.object({
  period: periodSchema.optional(),
  orgId: z.uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PartnerLedgerQuery = z.infer<typeof partnerLedgerQuerySchema>;

export const closeStatementSchema = z.object({ period: periodSchema });
export const markStatementPaidSchema = z.object({
  reference: z.string().trim().min(2).max(120),
});

// ------------------------------------------------------------------ DTOs

export interface PartnerDto {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  currency: string;
  walletMarkupBps: number;
  maxClients: number | null;
  clientCount: number;
  createdAt: string;
}

export interface PartnerMemberDto {
  userId: string;
  name: string;
  email: string;
  createdAt: string;
}

/** A plan a partner can put a client on, with what the platform charges the partner for it. */
export interface PartnerPlanDto {
  code: string;
  name: string;
  description: string | null;
  seats: number | null;
  numbers: number | null;
  contacts: number | null;
  features: PlanFeature[];
  wholesaleMicros: number;
  currency: string;
}

export interface ClientDto {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  ownerEmail: string | null;
  planCode: string | null;
  planName: string | null;
  /** The limits in force: the plan's, lowered by any the partner set. */
  limits: Record<PlanLimit, number | null>;
  /** Only what the partner set. */
  partnerLimits: Record<PlanLimit, number | null>;
  clientPriceMicros: number | null;
  wholesalePriceMicros: number | null;
  currency: string;
  balanceMicros: number;
  createdAt: string;
}

export interface ClientDetailDto extends ClientDto {
  usage: Record<PlanLimit, number>;
  /** This month so far, from the partner ledger. */
  month: PartnerTotalsDto;
}

export interface PartnerTotalsDto {
  period: string;
  currency: string;
  usageWholesaleMicros: number;
  usageRetailMicros: number;
  planFeesWholesaleMicros: number;
  planFeesRetailMicros: number;
  commissionMicros: number;
  /** What the platform invoices the partner: usage and plan fees at wholesale. */
  totalDueMicros: number;
}

export interface PartnerLedgerEntryDto {
  id: string;
  orgId: string | null;
  orgName: string | null;
  type: PartnerLedgerType;
  wholesaleMicros: number;
  retailMicros: number;
  commissionMicros: number;
  period: string;
  description: string | null;
  createdAt: string;
}

export interface PartnerStatementDto extends PartnerTotalsDto {
  id: string;
  partnerId: string;
  partnerName: string | null;
  status: 'issued' | 'paid';
  issuedAt: string;
  paidAt: string | null;
  paymentReference: string | null;
}

export interface ImpersonationDto {
  id: string;
  orgId: string;
  orgName: string;
  expiresAt: string;
}

export interface ImpersonationStartDto {
  accessToken: string;
  expiresIn: number;
  impersonation: ImpersonationDto;
}

export interface AdminOrgDto {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  deleted: boolean;
  partnerId: string | null;
  partnerName: string | null;
  planCode: string | null;
  currency: string | null;
  balanceMicros: number | null;
  createdAt: string;
}

export interface AdminPlanDto {
  code: string;
  name: string;
  description: string | null;
  seats: number | null;
  numbers: number | null;
  contacts: number | null;
  features: PlanFeature[];
  isPublic: boolean;
  isTrial: boolean;
  wholesale: { currency: string; amountMicros: number }[];
}

export interface AdminRateCardDto {
  id: string;
  country: string;
  category: string;
  currency: string;
  rateMicros: number;
  validFrom: string;
}

export interface QueueStatusDto {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface SystemStatusDto {
  database: { ok: boolean; latencyMs: number | null };
  redis: { ok: boolean; latencyMs: number | null };
  queues: QueueStatusDto[];
  counts: { organizations: number; partners: number };
  checkedAt: string;
}
