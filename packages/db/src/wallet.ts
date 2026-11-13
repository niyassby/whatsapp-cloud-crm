import {
  AppError,
  applyMarkup,
  ErrorCode,
  isChargeable,
  type LedgerEntryDto,
  messageDebitKey,
  periodOf,
  RATE_ANY_COUNTRY,
  type WalletDto,
  type WalletEntryType,
} from '@wacrm/shared';
import type { Prisma } from './generated/prisma/client';
import type { TenantTx } from './tenant';

/**
 * The wallet. `wallet_ledger` is the record of every movement (append-only: the app role has no
 * UPDATE or DELETE on it). `wallets.balance_micros` is that ledger's running total, kept so a
 * balance check under the row lock does not add up history. Every function here takes the row
 * lock first, so all changes to one wallet happen one at a time, and a CHECK constraint in the
 * database refuses a negative balance even if code here were wrong.
 *
 * Call these inside one tenant transaction, together with the change they pay for.
 */

interface LockedWallet {
  id: string;
  currency: string;
  balance: bigint;
  reserved: bigint;
  threshold: bigint | null;
  alertedAt: Date | null;
}

/** Create the wallet if this org has none yet. Takes no lock. */
export async function ensureWallet(
  tx: TenantTx,
  orgId: string,
  currency: string,
  lowBalanceThresholdMicros?: number | null,
) {
  await tx.wallet.createMany({
    data: {
      orgId,
      currency,
      lowBalanceThresholdMicros:
        lowBalanceThresholdMicros === undefined || lowBalanceThresholdMicros === null
          ? null
          : BigInt(lowBalanceThresholdMicros),
    },
    skipDuplicates: true,
  });
}

/** Reviewed raw SQL: a bound parameter, under the tenant's RLS context. */
async function lockWallet(tx: TenantTx, orgId: string): Promise<LockedWallet> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      currency: string;
      balance_micros: bigint;
      reserved_micros: bigint;
      low_balance_threshold_micros: bigint | null;
      low_balance_alerted_at: Date | null;
    }[]
  >`SELECT id, currency, balance_micros, reserved_micros, low_balance_threshold_micros,
           low_balance_alerted_at
    FROM wallets WHERE org_id = ${orgId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'This workspace has no wallet yet');
  return {
    id: row.id,
    currency: row.currency,
    balance: row.balance_micros,
    reserved: row.reserved_micros,
    threshold: row.low_balance_threshold_micros,
    alertedAt: row.low_balance_alerted_at,
  };
}

export interface RateSnapshot {
  rateCardId: string | null;
  rateMicros: number;
  country: string | null;
  category: string | null;
}

interface EntryInput {
  orgId: string;
  amountMicros: number;
  referenceType?: string | null;
  referenceId?: string | null;
  /** The same key never applies twice. */
  idempotencyKey: string;
  description?: string | null;
  actorUserId?: string | null;
  rate?: RateSnapshot | null;
  /**
   * For a partner's client: the partner, and this amount at the rate card price before the
   * partner's markup. Positive, like the amount passed to a debit.
   */
  wholesale?: { partnerId: string; amountMicros: number } | null;
}

export interface WalletMove {
  /** False when this key had already been applied, so nothing changed. */
  applied: boolean;
  balanceAfterMicros: number;
  /** The balance just fell below the alert threshold, so someone should be told. */
  crossedLowBalance: boolean;
}

const findEntry = (tx: TenantTx, orgId: string, idempotencyKey: string) =>
  tx.walletLedger.findUnique({ where: { orgId_idempotencyKey: { orgId, idempotencyKey } } });

/** Write one ledger entry and move the running balance, under the lock already held. */
async function applyEntry(
  tx: TenantTx,
  wallet: LockedWallet,
  type: WalletEntryType,
  input: EntryInput,
  reservedChange = 0n,
): Promise<WalletMove> {
  const amount = BigInt(input.amountMicros);
  const after = wallet.balance + amount;
  // Signed like the entry itself: negative on a debit, positive on its refund.
  const wholesale = input.wholesale
    ? BigInt(input.wholesale.amountMicros) * (amount < 0n ? -1n : 1n)
    : null;
  await tx.walletLedger.create({
    data: {
      orgId: input.orgId,
      walletId: wallet.id,
      type,
      amountMicros: amount,
      balanceAfterMicros: after,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      idempotencyKey: input.idempotencyKey,
      description: input.description ?? null,
      actorUserId: input.actorUserId ?? null,
      rateCardId: input.rate?.rateCardId ?? null,
      rateMicros: input.rate ? BigInt(input.rate.rateMicros) : null,
      country: input.rate?.country ?? null,
      category: input.rate?.category ?? null,
      partnerId: input.wholesale?.partnerId ?? null,
      wholesaleMicros: wholesale,
    },
  });
  if (input.wholesale && wholesale !== null && (type === 'debit' || type === 'refund')) {
    // The partner's side of the same movement, in the same transaction: what it owes the platform
    // and what it earned. createMany, because the client may write this row but never read it.
    await tx.partnerLedger.createMany({
      data: [
        {
          partnerId: input.wholesale.partnerId,
          orgId: input.orgId,
          type: type === 'debit' ? 'usage' : 'usage_refund',
          currency: wallet.currency,
          wholesaleMicros: -wholesale,
          retailMicros: -amount,
          commissionMicros: -amount + wholesale,
          period: periodOf(new Date()),
          referenceType: input.referenceType ?? null,
          referenceId: input.referenceId ?? null,
          idempotencyKey: `wallet:${input.orgId}:${input.idempotencyKey}`,
          description: input.description ?? null,
        },
      ],
      skipDuplicates: true,
    });
  }

  const { threshold } = wallet;
  const crossed =
    threshold !== null && wallet.balance >= threshold && after < threshold && !wallet.alertedAt;
  const recovered = threshold !== null && after >= threshold && wallet.alertedAt !== null;
  await tx.wallet.update({
    where: { id: wallet.id },
    data: {
      balanceMicros: after,
      ...(reservedChange !== 0n ? { reservedMicros: wallet.reserved + reservedChange } : {}),
      ...(crossed ? { lowBalanceAlertedAt: new Date() } : {}),
      ...(recovered ? { lowBalanceAlertedAt: null } : {}),
    },
  });
  return { applied: true, balanceAfterMicros: Number(after), crossedLowBalance: crossed };
}

const already = (balance: bigint): WalletMove => ({
  applied: false,
  balanceAfterMicros: Number(balance),
  crossedLowBalance: false,
});

const insufficient = (wallet: LockedWallet, needed: number) =>
  new AppError(ErrorCode.INSUFFICIENT_BALANCE, 'The wallet balance is too low for this send', {
    availableMicros: Number(wallet.balance - wallet.reserved),
    neededMicros: needed,
    currency: wallet.currency,
  });

/** Add money. Only for confirmed payments or a recorded manual adjustment. */
export async function creditWallet(
  tx: TenantTx,
  input: EntryInput & { type?: 'credit' | 'adjustment' },
): Promise<WalletMove> {
  if (input.amountMicros <= 0) throw new Error('A credit must be positive');
  const wallet = await lockWallet(tx, input.orgId);
  if (await findEntry(tx, input.orgId, input.idempotencyKey)) return already(wallet.balance);
  return applyEntry(tx, wallet, input.type ?? 'credit', input);
}

/**
 * Take money, refusing if there is not enough. With a reservation, the money comes from what is
 * already held. Without one, it must be free of all holds.
 */
export async function debitWallet(
  tx: TenantTx,
  input: EntryInput & { rate: RateSnapshot; reservationId?: string },
): Promise<WalletMove> {
  const amount = input.amountMicros;
  if (amount <= 0) throw new Error('A debit amount must be positive');
  const wallet = await lockWallet(tx, input.orgId);
  if (await findEntry(tx, input.orgId, input.idempotencyKey)) return already(wallet.balance);

  const entry = { ...input, amountMicros: -amount };
  if (!input.reservationId) {
    if (wallet.balance - wallet.reserved < BigInt(amount)) throw insufficient(wallet, amount);
    return applyEntry(tx, wallet, 'debit', entry);
  }

  const reservation = await tx.walletReservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation || reservation.status !== 'active') {
    throw new AppError(ErrorCode.CONFLICT, 'This reservation is no longer active');
  }
  if (reservation.amountMicros - reservation.consumedMicros < BigInt(amount)) {
    throw insufficient(wallet, amount);
  }
  await tx.walletReservation.update({
    where: { id: reservation.id },
    data: { consumedMicros: reservation.consumedMicros + BigInt(amount) },
  });
  return applyEntry(tx, wallet, 'debit', entry, -BigInt(amount));
}

/**
 * Give back a debit, once. Does nothing when there was no such debit, which is what a free send
 * looks like. The refund carries the debit's rate and category, so usage adds up after refunds.
 */
export async function refundDebit(
  tx: TenantTx,
  input: { orgId: string; debitKey: string; description?: string },
): Promise<WalletMove> {
  const { orgId, debitKey } = input;
  const wallet = await lockWallet(tx, orgId).catch((err: unknown) => {
    // Nothing was ever charged if there is no wallet at all.
    if (err instanceof AppError && err.code === ErrorCode.NOT_FOUND) return null;
    throw err;
  });
  if (!wallet) return already(0n);
  const debit = await findEntry(tx, orgId, debitKey);
  if (!debit || debit.type !== 'debit') return already(wallet.balance);
  const idempotencyKey = `refund:${debitKey}`;
  if (await findEntry(tx, orgId, idempotencyKey)) return already(wallet.balance);
  return applyEntry(tx, wallet, 'refund', {
    orgId,
    amountMicros: Number(-debit.amountMicros),
    referenceType: debit.referenceType,
    referenceId: debit.referenceId,
    idempotencyKey,
    description: input.description ?? null,
    rate: {
      rateCardId: debit.rateCardId,
      rateMicros: Number(debit.rateMicros ?? 0n),
      country: debit.country,
      category: debit.category,
    },
    // The partner is not billed for, and earns nothing on, a send that was given back.
    wholesale:
      debit.partnerId && debit.wholesaleMicros !== null
        ? { partnerId: debit.partnerId, amountMicros: Number(-debit.wholesaleMicros) }
        : null,
  });
}

/** Holds that outlived their campaign, for example after a crash, go back to the balance. */
async function releaseExpired(tx: TenantTx, wallet: LockedWallet, now: Date) {
  const expired = await tx.walletReservation.findMany({
    where: { walletId: wallet.id, status: 'active', expiresAt: { lte: now } },
  });
  for (const r of expired) {
    const held = r.amountMicros - r.consumedMicros;
    wallet.reserved -= held;
    await tx.walletReservation.update({
      where: { id: r.id },
      data: { status: 'expired', releasedAt: now },
    });
  }
  if (expired.length) {
    await tx.wallet.update({ where: { id: wallet.id }, data: { reservedMicros: wallet.reserved } });
  }
}

export interface ReservationResult {
  id: string;
  /** False when this key already held funds, so that same reservation is returned. */
  created: boolean;
  amountMicros: number;
}

/**
 * Hold funds for a campaign before it sends, so a big send cannot run out halfway and other sends
 * cannot spend what it needs. The balance stays the same: only what is available drops.
 */
export async function reserveFunds(
  tx: TenantTx,
  input: {
    orgId: string;
    amountMicros: number;
    referenceType: string;
    referenceId: string;
    idempotencyKey: string;
    expiresAt: Date;
    now?: Date;
  },
): Promise<ReservationResult> {
  if (input.amountMicros <= 0) throw new Error('A reservation must be positive');
  const wallet = await lockWallet(tx, input.orgId);
  await releaseExpired(tx, wallet, input.now ?? new Date());

  const existing = await tx.walletReservation.findUnique({
    where: { orgId_idempotencyKey: { orgId: input.orgId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) {
    return { id: existing.id, created: false, amountMicros: Number(existing.amountMicros) };
  }

  const amount = BigInt(input.amountMicros);
  if (wallet.balance - wallet.reserved < amount) throw insufficient(wallet, input.amountMicros);
  const row = await tx.walletReservation.create({
    data: {
      orgId: input.orgId,
      walletId: wallet.id,
      amountMicros: amount,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      idempotencyKey: input.idempotencyKey,
      expiresAt: input.expiresAt,
    },
  });
  await tx.wallet.update({
    where: { id: wallet.id },
    data: { reservedMicros: wallet.reserved + amount },
  });
  return { id: row.id, created: true, amountMicros: input.amountMicros };
}

/** Return what a reservation did not use. Safe to call twice. */
export async function releaseReservation(
  tx: TenantTx,
  input: { orgId: string; reservationId: string; now?: Date },
): Promise<{ releasedMicros: number }> {
  const wallet = await lockWallet(tx, input.orgId);
  const r = await tx.walletReservation.findUnique({ where: { id: input.reservationId } });
  if (!r) throw new AppError(ErrorCode.NOT_FOUND, 'Reservation not found');
  if (r.status !== 'active') return { releasedMicros: 0 };
  const held = r.amountMicros - r.consumedMicros;
  await tx.walletReservation.update({
    where: { id: r.id },
    data: { status: 'released', releasedAt: input.now ?? new Date() },
  });
  await tx.wallet.update({
    where: { id: wallet.id },
    data: { reservedMicros: wallet.reserved - held },
  });
  return { releasedMicros: Number(held) };
}

export interface RateQuote {
  rateCardId: string;
  /** What this workspace pays: the rate card price, plus its partner's markup if it has one. */
  rateMicros: number;
  /** The rate card price itself. */
  wholesaleMicros: number;
  /** The partner whose markup is in `rateMicros`, when this workspace is a partner's client. */
  partnerId: string | null;
  currency: string;
  /** The country the rate was found for, or '*' for the fallback. */
  country: string;
  category: string;
}

/**
 * The partner whose client the current workspace is, with its markup. Reviewed raw SQL: no
 * parameters, and the workspace comes from the transaction's own RLS context, so a caller cannot
 * price one workspace with another's partner.
 */
export async function clientPartnerPricing(
  tx: TenantTx,
): Promise<{ partnerId: string; markupBps: number } | null> {
  const rows = await tx.$queryRaw<{ id: string; wallet_markup_bps: number }[]>`
    SELECT p.id, p.wallet_markup_bps
    FROM organizations o JOIN partners p ON p.id = o.partner_id
    WHERE o.id = app_current_org_id()`;
  const row = rows[0];
  return row ? { partnerId: row.id, markupBps: row.wallet_markup_bps } : null;
}

/**
 * The newest rate in force. A country's own rate wins over the any-country one. For a partner's
 * client the price includes the partner's markup, so estimates, holds and charges all agree.
 */
export async function findRate(
  tx: TenantTx,
  input: { currency: string; category: string; country: string | null; at?: Date },
): Promise<RateQuote | null> {
  const at = input.at ?? new Date();
  const category = input.category.toLowerCase();
  const find = (country: string) =>
    tx.rateCard.findFirst({
      where: { currency: input.currency, category, country, validFrom: { lte: at } },
      orderBy: { validFrom: 'desc' },
    });
  const row = (input.country ? await find(input.country) : null) ?? (await find(RATE_ANY_COUNTRY));
  if (!row) return null;
  const partner = await clientPartnerPricing(tx);
  const wholesaleMicros = Number(row.rateMicros);
  return {
    rateCardId: row.id,
    rateMicros: applyMarkup(wholesaleMicros, partner?.markupBps ?? 0),
    wholesaleMicros,
    partnerId: partner?.partnerId ?? null,
    currency: row.currency,
    country: row.country,
    category,
  };
}

export interface MessageCharge {
  orgId: string;
  messageId: string;
  category: string;
  /** Country of the recipient, or null when it cannot be told. */
  country: string | null;
  windowOpen: boolean;
  /** Campaigns spend from funds they already hold. */
  reservationId?: string;
  defaults: { currency: string; thresholdMicros: number | null };
}

export interface MessagePrice {
  /** Nothing to charge, because Meta does not bill this send. */
  free: boolean;
  /** Null when this send should be charged but has no price set. */
  quote: RateQuote | null;
}

/** What this send costs. Shared by the charge and the price shown before sending. */
export async function priceMessage(
  tx: TenantTx,
  input: Pick<MessageCharge, 'orgId' | 'category' | 'country' | 'windowOpen' | 'defaults'>,
): Promise<MessagePrice & { currency: string }> {
  await ensureWallet(tx, input.orgId, input.defaults.currency, input.defaults.thresholdMicros);
  const { currency } = await tx.wallet.findUniqueOrThrow({
    where: { orgId: input.orgId },
    select: { currency: true },
  });
  if (!isChargeable(input.category, input.windowOpen)) {
    return { free: true, quote: null, currency };
  }
  const quote = await findRate(tx, {
    currency,
    category: input.category,
    country: input.country,
  });
  return { free: false, quote, currency };
}

/**
 * Charge for one message, in the transaction that creates it, so a message and its charge exist
 * together or not at all. Refuses a send with no price rather than giving it away.
 */
export async function chargeMessage(
  tx: TenantTx,
  input: MessageCharge,
): Promise<WalletMove | null> {
  const { free, quote } = await priceMessage(tx, input);
  if (free) return null;
  if (!quote) {
    throw new AppError(
      ErrorCode.RATE_NOT_CONFIGURED,
      'No price is set for this kind of message, so it was not sent. Contact support.',
    );
  }
  if (quote.rateMicros === 0) return null;
  return debitWallet(tx, {
    orgId: input.orgId,
    amountMicros: quote.rateMicros,
    referenceType: 'message',
    referenceId: input.messageId,
    idempotencyKey: messageDebitKey(input.messageId),
    reservationId: input.reservationId,
    wholesale: quote.partnerId
      ? { partnerId: quote.partnerId, amountMicros: quote.wholesaleMicros }
      : null,
    rate: {
      rateCardId: quote.rateCardId,
      rateMicros: quote.rateMicros,
      country: input.country ?? quote.country,
      category: quote.category,
    },
  });
}

type WalletRow = Prisma.WalletGetPayload<object>;

export function walletToDto(w: WalletRow): WalletDto {
  const balance = Number(w.balanceMicros);
  const reserved = Number(w.reservedMicros);
  const threshold =
    w.lowBalanceThresholdMicros === null ? null : Number(w.lowBalanceThresholdMicros);
  return {
    currency: w.currency,
    balanceMicros: balance,
    reservedMicros: reserved,
    availableMicros: balance - reserved,
    lowBalanceThresholdMicros: threshold,
    lowBalance: threshold !== null && balance < threshold,
  };
}

export function ledgerToDto(e: Prisma.WalletLedgerGetPayload<object>): LedgerEntryDto {
  return {
    id: e.id,
    type: e.type,
    amountMicros: Number(e.amountMicros),
    balanceAfterMicros: Number(e.balanceAfterMicros),
    referenceType: e.referenceType,
    referenceId: e.referenceId,
    description: e.description,
    rate:
      e.rateMicros === null
        ? null
        : { micros: Number(e.rateMicros), country: e.country, category: e.category },
    createdAt: e.createdAt.toISOString(),
  };
}
