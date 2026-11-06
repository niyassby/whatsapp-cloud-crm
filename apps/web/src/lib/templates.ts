'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { CursorPage, MediaUrlDto, TemplateDto, TemplateWabaDto } from '@wacrm/shared';
import { api } from './api';

export const templateKeys = {
  all: ['templates'] as const,
  list: (status: string | undefined, q: string) => ['templates', 'list', status, q] as const,
  detail: (id: string) => ['templates', 'detail', id] as const,
  media: (id: string) => ['templates', 'media', id] as const,
  accounts: ['templates', 'accounts'] as const,
};

export function useTemplates(status: string | undefined, q: string) {
  return useInfiniteQuery({
    queryKey: templateKeys.list(status, q),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (status) params.set('status', status);
      if (q) params.set('q', q);
      if (pageParam) params.set('cursor', pageParam);
      return api<CursorPage<TemplateDto>>(`/templates?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export const useTemplate = (id: string) =>
  useQuery({
    queryKey: templateKeys.detail(id),
    queryFn: () => api<TemplateDto>(`/templates/${id}`),
  });

export const useTemplateAccounts = () =>
  useQuery({
    queryKey: templateKeys.accounts,
    queryFn: () => api<TemplateWabaDto[]>('/templates/accounts'),
  });

export const useTemplateMediaUrl = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: templateKeys.media(id),
    enabled,
    staleTime: 3 * 60_000,
    queryFn: () => api<MediaUrlDto>(`/templates/${id}/header-media`),
  });

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  pending: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
  paused: 'Paused',
  disabled: 'Disabled',
  in_appeal: 'In appeal',
  pending_deletion: 'Being deleted',
  deleted: 'Deleted',
  archived: 'Archived',
  limit_exceeded: 'Limit reached',
  locked: 'Locked',
};
