'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  AssignmentRuleDto,
  AutomationSettingsDto,
  AutoReplyRuleDto,
  CursorPage,
  NotificationDto,
} from '@wacrm/shared';
import { api } from './api';

export const automationKeys = {
  settings: ['automation', 'settings'] as const,
  autoReplies: ['automation', 'auto-replies'] as const,
  assignmentRules: ['automation', 'assignment-rules'] as const,
  notifications: ['notifications'] as const,
};

export const useAutomationSettings = () =>
  useQuery({
    queryKey: automationKeys.settings,
    queryFn: () => api<AutomationSettingsDto>('/automation/settings'),
  });

export const useAutoReplies = () =>
  useQuery({
    queryKey: automationKeys.autoReplies,
    queryFn: () => api<AutoReplyRuleDto[]>('/automation/auto-replies'),
  });

export const useAssignmentRules = () =>
  useQuery({
    queryKey: automationKeys.assignmentRules,
    queryFn: () => api<AssignmentRuleDto[]>('/automation/assignment-rules'),
  });

export function useNotifications(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: automationKeys.notifications,
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '20' });
      if (pageParam) params.set('cursor', pageParam);
      return api<CursorPage<NotificationDto> & { unread: number }>(`/notifications?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
