'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  CampaignDto,
  CampaignEstimateDto,
  CampaignRecipientDto,
  CampaignReportDto,
  CampaignStatus,
  CursorPage,
  DashboardDto,
  DripDto,
  PauseCode,
  RecipientStatus,
} from '@wacrm/shared';
import { api } from './api';

export const campaignKeys = {
  all: ['campaigns'] as const,
  lists: ['campaigns', 'list'] as const,
  list: (status: string | undefined) => ['campaigns', 'list', status] as const,
  report: (id: string) => ['campaigns', 'report', id] as const,
  estimate: (id: string) => ['campaigns', 'estimate', id] as const,
  recipients: (id: string, status: string | undefined) =>
    ['campaigns', 'recipients', id, status] as const,
  drips: ['drips'] as const,
  dashboard: (days: number) => ['dashboard', days] as const,
};

export function useCampaigns(status: CampaignStatus | undefined) {
  return useInfiniteQuery({
    queryKey: campaignKeys.list(status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (status) params.set('status', status);
      if (pageParam) params.set('cursor', pageParam);
      return api<CursorPage<CampaignDto>>(`/campaigns?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** The socket keeps this live. The slow poll covers a dropped connection. */
export const useCampaignReport = (id: string) =>
  useQuery({
    queryKey: campaignKeys.report(id),
    queryFn: () => api<CampaignReportDto>(`/campaigns/${id}`),
    refetchInterval: (query) =>
      query.state.data && isActive(query.state.data.campaign.status) ? 10_000 : false,
  });

export const useCampaignEstimate = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: campaignKeys.estimate(id),
    enabled,
    queryFn: () => api<CampaignEstimateDto>(`/campaigns/${id}/estimate`, { method: 'POST' }),
  });

export function useCampaignRecipients(id: string, status: RecipientStatus | undefined) {
  return useInfiniteQuery({
    queryKey: campaignKeys.recipients(id, status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (status) params.set('status', status);
      if (pageParam) params.set('cursor', pageParam);
      return api<CursorPage<CampaignRecipientDto>>(`/campaigns/${id}/recipients?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export const useDrips = () =>
  useQuery({ queryKey: campaignKeys.drips, queryFn: () => api<DripDto[]>('/drips') });

export const useDashboard = (days: number) =>
  useQuery({
    queryKey: campaignKeys.dashboard(days),
    queryFn: () => api<DashboardDto>(`/analytics/dashboard?days=${days}`),
  });

export const isActive = (status: CampaignStatus) =>
  status === 'preparing' || status === 'running' || status === 'scheduled';

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  preparing: 'Preparing',
  running: 'Sending',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const RECIPIENT_STATUS_LABELS: Record<RecipientStatus, string> = {
  pending: 'Waiting',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  replied: 'Replied',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

/** What someone can do about each kind of automatic pause. */
export const PAUSE_ACTIONS: Partial<Record<PauseCode, { label: string; href: string }>> = {
  insufficient_funds: { label: 'Open wallet', href: '/wallet' },
  low_quality: { label: 'Check the number', href: '/settings/whatsapp' },
  number_disconnected: { label: 'Check the number', href: '/settings/whatsapp' },
  template_not_approved: { label: 'See templates', href: '/templates' },
};
