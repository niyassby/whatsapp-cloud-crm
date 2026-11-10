'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  CursorPage,
  FlowDto,
  FlowRunDto,
  FlowRunStepDto,
  FlowTriggerType,
  FlowVersionDto,
} from '@wacrm/shared';
import { api } from './api';

export const flowKeys = {
  all: ['flows'] as const,
  one: (id: string) => ['flows', id] as const,
  versions: (id: string) => ['flows', id, 'versions'] as const,
  runs: (id: string) => ['flows', id, 'runs'] as const,
  run: (runId: string) => ['flow-runs', runId] as const,
};

export const useFlows = () =>
  useQuery({ queryKey: flowKeys.all, queryFn: () => api<FlowDto[]>('/flows') });

export const useFlow = (id: string) =>
  useQuery({ queryKey: flowKeys.one(id), queryFn: () => api<FlowDto>(`/flows/${id}`) });

export const useFlowVersions = (id: string) =>
  useQuery({
    queryKey: flowKeys.versions(id),
    queryFn: () => api<FlowVersionDto[]>(`/flows/${id}/versions`),
  });

/** Runs change on their own, so the list refreshes while it is open. */
export function useFlowRuns(id: string) {
  return useInfiniteQuery({
    queryKey: flowKeys.runs(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '30' });
      if (pageParam) params.set('cursor', pageParam);
      return api<CursorPage<FlowRunDto>>(`/flows/${id}/runs?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
}

export const useFlowRun = (runId: string | null) =>
  useQuery({
    queryKey: flowKeys.run(runId ?? ''),
    enabled: Boolean(runId),
    queryFn: () => api<FlowRunDto & { history: FlowRunStepDto[] }>(`/flows/runs/${runId}`),
    refetchInterval: 5_000,
  });

export const TRIGGER_LABELS: Record<FlowTriggerType, string> = {
  keyword: 'Keyword',
  new_contact: 'New contact',
  tag_added: 'Tag added',
  template_button: 'Template button',
  integration_event: 'Integration event',
  ad_referral: 'Ad click',
  manual: 'Started by hand',
};

export const RUN_STATUS_LABELS: Record<FlowRunDto['status'], string> = {
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
