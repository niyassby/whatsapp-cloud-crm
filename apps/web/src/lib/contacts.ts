'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  ConsentEventDto,
  ContactConversationDto,
  ContactDto,
  ContactFieldDto,
  ContactJobDto,
  ContactNoteDto,
  CursorPage,
  MediaUrlDto,
  MessageDto,
  OptInStatus,
  SegmentDto,
  SegmentFilter,
  TagDto,
} from '@wacrm/shared';
import { api } from './api';

export interface ContactFilters {
  q?: string;
  tagId?: string;
  optIn?: OptInStatus;
  segmentId?: string;
}

const contactsRoot = ['contacts'] as const;

export const contactKeys = {
  all: contactsRoot,
  lists: [...contactsRoot, 'list'] as const,
  list: (f: ContactFilters) => [...contactsRoot, 'list', f] as const,
  count: (f: ContactFilters) => [...contactsRoot, 'count', f] as const,
  contact: (id: string) => [...contactsRoot, 'detail', id] as const,
  notes: (id: string) => [...contactsRoot, 'notes', id] as const,
  consent: (id: string) => [...contactsRoot, 'consent', id] as const,
  conversations: (id: string) => [...contactsRoot, 'conversations', id] as const,
  history: (id: string) => [...contactsRoot, 'history', id] as const,
  tags: [...contactsRoot, 'tags'] as const,
  fields: [...contactsRoot, 'fields'] as const,
  segments: [...contactsRoot, 'segments'] as const,
  segmentCount: (id: string) => [...contactsRoot, 'segments', id, 'count'] as const,
  preview: (filter: SegmentFilter) => [...contactsRoot, 'preview', filter] as const,
  jobs: [...contactsRoot, 'jobs'] as const,
  keywords: [...contactsRoot, 'keywords'] as const,
};

const toSearch = (f: ContactFilters) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(f)) if (value) params.set(key, value);
  return params;
};

export function useContacts(filters: ContactFilters) {
  return useInfiniteQuery({
    queryKey: contactKeys.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = toSearch(filters);
      params.set('limit', '100');
      if (pageParam) params.set('cursor', pageParam);
      return api<CursorPage<ContactDto>>(`/contacts?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useContactCount(filters: ContactFilters) {
  return useQuery({
    queryKey: contactKeys.count(filters),
    queryFn: () => api<{ count: number }>(`/contacts/count?${toSearch(filters)}`),
  });
}

export const useContact = (id: string) =>
  useQuery({
    queryKey: contactKeys.contact(id),
    queryFn: () => api<ContactDto>(`/contacts/${id}`),
  });

export const useContactNotes = (id: string) =>
  useQuery({
    queryKey: contactKeys.notes(id),
    queryFn: () => api<ContactNoteDto[]>(`/contacts/${id}/notes`),
  });

export const useConsentHistory = (id: string) =>
  useQuery({
    queryKey: contactKeys.consent(id),
    queryFn: () => api<ConsentEventDto[]>(`/contacts/${id}/consent`),
  });

export const useContactConversations = (id: string) =>
  useQuery({
    queryKey: contactKeys.conversations(id),
    queryFn: () => api<ContactConversationDto[]>(`/contacts/${id}/conversations`),
  });

/** Read-only history, kept apart from the live inbox cache. */
export function useConversationHistory(conversationId: string) {
  return useInfiniteQuery({
    queryKey: contactKeys.history(conversationId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<CursorPage<MessageDto>>(
        `/inbox/conversations/${conversationId}/messages?limit=30${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export const useTags = () =>
  useQuery({ queryKey: contactKeys.tags, queryFn: () => api<TagDto[]>('/contact-tags') });

export const useContactFields = () =>
  useQuery({
    queryKey: contactKeys.fields,
    queryFn: () => api<ContactFieldDto[]>('/contact-fields'),
  });

export const useSegments = () =>
  useQuery({ queryKey: contactKeys.segments, queryFn: () => api<SegmentDto[]>('/segments') });

export const useSegmentCount = (id: string) =>
  useQuery({
    queryKey: contactKeys.segmentCount(id),
    queryFn: () => api<{ count: number }>(`/segments/${id}/count`),
  });

export const useSegmentPreview = (filter: SegmentFilter, enabled: boolean) =>
  useQuery({
    queryKey: contactKeys.preview(filter),
    enabled,
    queryFn: () =>
      api<{ count: number }>('/segments/preview', { method: 'POST', body: { filter } }),
  });

export const useContactJobs = (enabled: boolean) =>
  useQuery({
    queryKey: contactKeys.jobs,
    enabled,
    queryFn: () => api<ContactJobDto[]>('/contact-jobs'),
  });

export const useOptOutKeywords = () =>
  useQuery({
    queryKey: contactKeys.keywords,
    queryFn: () =>
      api<{ keywords: string[]; isDefault: boolean }>('/contact-settings/opt-out-keywords'),
  });

export async function downloadJobFile(jobId: string): Promise<void> {
  const { url } = await api<MediaUrlDto>(`/contact-jobs/${jobId}/download`, { method: 'POST' });
  window.location.assign(url);
}

export const contactLabel = (c: { name: string | null; waId: string }) => c.name ?? `+${c.waId}`;

export const OPT_IN_LABELS: Record<OptInStatus, string> = {
  opted_in: 'Opted in',
  opted_out: 'Opted out',
  unknown: 'No consent',
};
