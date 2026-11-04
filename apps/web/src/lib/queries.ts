'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  AuditLogDto,
  CursorPage,
  InvitationDto,
  MeResponse,
  MemberDto,
  Permission,
} from '@wacrm/shared';
import { api } from './api';

export interface OrgDto {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  createdAt: string;
}

export const queryKeys = {
  me: ['me'] as const,
  org: ['org'] as const,
  members: ['team', 'members'] as const,
  invitations: ['team', 'invitations'] as const,
  audit: ['audit'] as const,
};

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => api<MeResponse>('/auth/me') });
}

/** Permission check against the current org role (UI gating only; the API enforces). */
export function useCan(permission: Permission): boolean {
  const { data } = useMe();
  return data?.permissions.includes(permission) ?? false;
}

export function useOrg(enabled = true) {
  return useQuery({
    queryKey: queryKeys.org,
    queryFn: () => api<OrgDto>('/orgs/current'),
    enabled,
  });
}

export function useMembers() {
  return useQuery({
    queryKey: queryKeys.members,
    queryFn: () => api<MemberDto[]>('/team/members'),
  });
}

export function useInvitations(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.invitations,
    queryFn: () => api<InvitationDto[]>('/team/invitations'),
    enabled,
  });
}

export function useAuditLogs() {
  return useInfiniteQuery({
    queryKey: queryKeys.audit,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<CursorPage<AuditLogDto>>(
        `/orgs/current/audit-logs?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
