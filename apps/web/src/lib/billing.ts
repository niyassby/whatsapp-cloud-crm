'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  BillingSummaryDto,
  CursorPage,
  InvoiceDto,
  PlanDto,
  TopupQuoteDto,
} from '@wacrm/shared';
import { api } from './api';

export const billingKeys = {
  all: ['billing'] as const,
  summary: ['billing', 'summary'] as const,
  plans: ['billing', 'plans'] as const,
  invoices: ['billing', 'invoices'] as const,
  quote: (amount: string) => ['billing', 'quote', amount] as const,
};

export const useBillingSummary = (enabled = true) =>
  useQuery({
    queryKey: billingKeys.summary,
    enabled,
    queryFn: () => api<BillingSummaryDto>('/billing/summary'),
  });

export const usePlans = () =>
  useQuery({ queryKey: billingKeys.plans, queryFn: () => api<PlanDto[]>('/billing/plans') });

export function useInvoices() {
  return useInfiniteQuery({
    queryKey: billingKeys.invoices,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (pageParam) params.set('cursor', pageParam);
      return api<CursorPage<InvoiceDto>>(`/billing/invoices?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export const useTopupQuote = (amount: string, enabled: boolean) =>
  useQuery({
    queryKey: billingKeys.quote(amount),
    enabled,
    queryFn: () => api<TopupQuoteDto>(`/billing/topup-quote?amount=${encodeURIComponent(amount)}`),
  });

export const PROVIDER_LABELS = { stripe: 'Stripe', razorpay: 'Razorpay' } as const;

export const daysUntil = (iso: string) =>
  Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
