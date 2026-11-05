'use client';

import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import type {
  CannedReplyDto,
  ConversationDto,
  CursorPage,
  InboxTemplateDto,
  LabelDto,
  MessageDto,
} from '@wacrm/shared';
import { api } from './api';

export type ConversationFilter = 'all' | 'mine' | 'unassigned';
export type ConversationStatusFilter = 'open' | 'closed';

export const inboxKeys = {
  all: ['inbox'] as const,
  lists: ['inbox', 'conversations'] as const,
  list: (filter: string, status: string) => ['inbox', 'conversations', filter, status] as const,
  conversation: (id: string) => ['inbox', 'conversation', id] as const,
  messages: (id: string) => ['inbox', 'messages', id] as const,
  labels: ['inbox', 'labels'] as const,
  canned: ['inbox', 'canned'] as const,
  templates: (id: string) => ['inbox', 'templates', id] as const,
};

export function useConversations(filter: ConversationFilter, status: ConversationStatusFilter) {
  return useInfiniteQuery({
    queryKey: inboxKeys.list(filter, status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<CursorPage<ConversationDto>>(
        `/inbox/conversations?filter=${filter}&status=${status}&limit=30${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: inboxKeys.conversation(id ?? 'none'),
    queryFn: () => api<ConversationDto>(`/inbox/conversations/${id}`),
    enabled: Boolean(id),
  });
}

/** Pages are newest first. Reverse them for display. */
export function useMessages(id: string) {
  return useInfiniteQuery({
    queryKey: inboxKeys.messages(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<CursorPage<MessageDto>>(
        `/inbox/conversations/${id}/messages?limit=40${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useLabels() {
  return useQuery({ queryKey: inboxKeys.labels, queryFn: () => api<LabelDto[]>('/inbox/labels') });
}

export function useCannedReplies() {
  return useQuery({
    queryKey: inboxKeys.canned,
    queryFn: () => api<CannedReplyDto[]>('/inbox/canned-replies'),
  });
}

export function useTemplates(conversationId: string, enabled: boolean) {
  return useQuery({
    queryKey: inboxKeys.templates(conversationId),
    queryFn: () => api<InboxTemplateDto[]>(`/inbox/conversations/${conversationId}/templates`),
    enabled,
  });
}

type MessagePages = InfiniteData<CursorPage<MessageDto>>;

/**
 * Insert or replace a message in the cache. The HTTP response and the socket event for one send
 * can arrive in either order, so this is keyed by id and safe to call twice.
 */
export function upsertMessage(client: QueryClient, message: MessageDto): void {
  client.setQueryData<MessagePages>(inboxKeys.messages(message.conversationId), (data) => {
    if (!data) return data;
    let found = false;
    const pages = data.pages.map((page) => ({
      ...page,
      items: page.items.map((m) => {
        if (m.id !== message.id) return m;
        found = true;
        return message;
      }),
    }));
    if (found) return { ...data, pages };
    const [first, ...rest] = pages;
    if (!first) return data;
    return { ...data, pages: [{ ...first, items: [message, ...first.items] }, ...rest] };
  });
}

export function applyConversationUpdate(client: QueryClient, conversation: ConversationDto): void {
  client.setQueryData(inboxKeys.conversation(conversation.id), conversation);
  client.setQueriesData<InfiniteData<CursorPage<ConversationDto>>>(
    { queryKey: inboxKeys.lists },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map((c) => (c.id === conversation.id ? conversation : c)),
        })),
      },
  );
}

export const isWindowOpen = (c: Pick<ConversationDto, 'windowExpiresAt'>, now = Date.now()) =>
  Boolean(c.windowExpiresAt && new Date(c.windowExpiresAt).getTime() > now);

/** "Today", "Yesterday" or a date, for day dividers. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString();
}

export const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Short relative time for the conversation list. */
export function shortTime(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  return dayLabel(iso, now) === 'Today' ? timeLabel(iso) : dayLabel(iso, now);
}

/** Phone numbers get a +. Username users have a business-scoped id instead, shown as is. */
export const displayWaId = (waId: string) => (/^\d+$/.test(waId) ? `+${waId}` : waId);
