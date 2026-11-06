'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  CursorPage,
  LedgerEntryDto,
  RateDto,
  WalletDto,
  WalletEntryType,
  WalletUsageDto,
} from '@wacrm/shared';
import { api } from './api';

export const walletKeys = {
  all: ['wallet'] as const,
  wallet: ['wallet', 'summary'] as const,
  ledger: (type: string | undefined) => ['wallet', 'ledger', type] as const,
  usage: (from: string, to: string) => ['wallet', 'usage', from, to] as const,
  rates: ['wallet', 'rates'] as const,
};

export const useWallet = (enabled = true) =>
  useQuery({ queryKey: walletKeys.wallet, enabled, queryFn: () => api<WalletDto>('/wallet') });

export function useLedger(type: WalletEntryType | undefined) {
  return useInfiniteQuery({
    queryKey: walletKeys.ledger(type),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (type) params.set('type', type);
      if (pageParam) params.set('cursor', pageParam);
      return api<CursorPage<LedgerEntryDto>>(`/wallet/ledger?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export const useWalletUsage = (from: string, to: string) =>
  useQuery({
    queryKey: walletKeys.usage(from, to),
    queryFn: () =>
      api<WalletUsageDto>(
        `/wallet/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
  });

export const useRates = () =>
  useQuery({ queryKey: walletKeys.rates, queryFn: () => api<RateDto[]>('/wallet/rates') });

export const ENTRY_LABELS: Record<WalletEntryType, string> = {
  credit: 'Top-up',
  debit: 'Charge',
  refund: 'Refund',
  adjustment: 'Adjustment',
};
