'use client';

import { type QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  AdminOrgDto,
  AdminPlanDto,
  AdminRateCardDto,
  ClientDto,
  CursorPage,
  ImpersonationStartDto,
  PartnerDto,
  PartnerLedgerEntryDto,
  PartnerMemberDto,
  PartnerPlanDto,
  PartnerStatementDto,
  PartnerTotalsDto,
  SystemStatusDto,
} from '@wacrm/shared';
import { api, leaveImpersonation } from './api';
import { type ConsolePath, useAuthStore } from './auth-store';

export const partnerKeys = {
  all: ['partner'] as const,
  profile: ['partner', 'profile'] as const,
  plans: ['partner', 'plans'] as const,
  clients: ['partner', 'clients'] as const,
  summary: ['partner', 'summary'] as const,
  ledger: ['partner', 'ledger'] as const,
  statements: ['partner', 'statements'] as const,
};

export const adminKeys = {
  all: ['admin'] as const,
  partners: ['admin', 'partners'] as const,
  members: (id: string) => ['admin', 'partners', id, 'members'] as const,
  orgs: (search: string) => ['admin', 'orgs', search] as const,
  plans: ['admin', 'plans'] as const,
  rates: ['admin', 'rates'] as const,
  statements: ['admin', 'statements'] as const,
  system: ['admin', 'system'] as const,
};

export const usePartner = () =>
  useQuery({ queryKey: partnerKeys.profile, queryFn: () => api<PartnerDto>('/partner') });
export const usePartnerPlans = () =>
  useQuery({ queryKey: partnerKeys.plans, queryFn: () => api<PartnerPlanDto[]>('/partner/plans') });
export const useClients = () =>
  useQuery({ queryKey: partnerKeys.clients, queryFn: () => api<ClientDto[]>('/partner/clients') });
export const usePartnerSummary = () =>
  useQuery({
    queryKey: partnerKeys.summary,
    queryFn: () => api<PartnerTotalsDto>('/partner/summary'),
  });
export const usePartnerStatements = () =>
  useQuery({
    queryKey: partnerKeys.statements,
    queryFn: () => api<PartnerStatementDto[]>('/partner/statements'),
  });
export const usePartnerLedger = () =>
  useInfiniteQuery({
    queryKey: partnerKeys.ledger,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<CursorPage<PartnerLedgerEntryDto>>(
        `/partner/ledger?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const useAdminPartners = () =>
  useQuery({ queryKey: adminKeys.partners, queryFn: () => api<PartnerDto[]>('/admin/partners') });
export const useAdminMembers = (id: string | null) =>
  useQuery({
    queryKey: adminKeys.members(id ?? ''),
    enabled: Boolean(id),
    queryFn: () => api<PartnerMemberDto[]>(`/admin/partners/${id}/members`),
  });
export const useAdminOrgs = (search: string) =>
  useInfiniteQuery({
    queryKey: adminKeys.orgs(search),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (search) params.set('search', search);
      if (pageParam) params.set('cursor', pageParam);
      return api<CursorPage<AdminOrgDto>>(`/admin/orgs?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
export const useAdminPlans = () =>
  useQuery({ queryKey: adminKeys.plans, queryFn: () => api<AdminPlanDto[]>('/admin/plans') });
export const useAdminRates = () =>
  useQuery({
    queryKey: adminKeys.rates,
    queryFn: () => api<AdminRateCardDto[]>('/admin/rate-cards'),
  });
export const useAdminStatements = () =>
  useQuery({
    queryKey: adminKeys.statements,
    queryFn: () => api<PartnerStatementDto[]>('/admin/statements'),
  });
/** Polls while open: queue depth is only useful if it is current. */
export const useSystemStatus = () =>
  useQuery({
    queryKey: adminKeys.system,
    refetchInterval: 10_000,
    queryFn: () => api<SystemStatusDto>('/admin/system'),
  });

/**
 * Open a workspace as an outsider. The token is kept beside the person's own and sent instead,
 * and everything cached is dropped so no screen shows a mix of two workspaces.
 */
export async function startImpersonation(
  queryClient: QueryClient,
  path: string,
  reason: string,
  returnTo: ConsolePath,
): Promise<void> {
  const started = await api<ImpersonationStartDto>(path, { method: 'POST', body: { reason } });
  useAuthStore.getState().setImpersonation({ token: started.accessToken, returnTo });
  queryClient.clear();
}

/** Tell the API the session is over, so the token is dead at once, then go back. */
export async function endImpersonation(): Promise<void> {
  await api('/impersonation/end', { method: 'POST' }).catch(() => undefined);
  leaveImpersonation();
}

export const percentOf = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
export const newKey = () => crypto.randomUUID();
