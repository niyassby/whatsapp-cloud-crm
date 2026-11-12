'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AiLogDto, AiSettingsDto, CursorPage, KnowledgeDocumentDto } from '@wacrm/shared';
import { api } from './api';

export const aiKeys = {
  all: ['ai'] as const,
  settings: ['ai', 'settings'] as const,
  knowledge: ['ai', 'knowledge'] as const,
  log: ['ai', 'log'] as const,
};

export const useAiSettings = (enabled = true) =>
  useQuery({
    queryKey: aiKeys.settings,
    enabled,
    queryFn: () => api<AiSettingsDto>('/ai/settings'),
    staleTime: 60_000,
  });

export const useKnowledgeDocuments = (enabled = true) =>
  useQuery({
    queryKey: aiKeys.knowledge,
    enabled,
    queryFn: () => api<KnowledgeDocumentDto[]>('/ai/knowledge'),
    // Indexing reports progress over the socket; this covers a missed event.
    refetchInterval: (q) =>
      q.state.data?.some((d) => d.status === 'pending' || d.status === 'indexing') ? 5_000 : false,
  });

export const useAiLog = (enabled = true) =>
  useInfiniteQuery({
    queryKey: aiKeys.log,
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<CursorPage<AiLogDto>>(`/ai/log${pageParam ? `?cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextCursor,
  });
