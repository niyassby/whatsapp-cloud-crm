'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  ApiKeyDto,
  CursorPage,
  WebhookDeliveryDto,
  WebhookDeliveryStatus,
  WebhookEndpointDto,
} from '@wacrm/shared';
import { api } from './api';

export const developerKeys = {
  apiKeys: ['developer', 'api-keys'] as const,
  endpoints: ['developer', 'webhook-endpoints'] as const,
  deliveries: (id: string, status: string | undefined) =>
    ['developer', 'deliveries', id, status] as const,
  deliveriesOf: (id: string) => ['developer', 'deliveries', id] as const,
};

export const useApiKeys = () =>
  useQuery({ queryKey: developerKeys.apiKeys, queryFn: () => api<ApiKeyDto[]>('/api-keys') });

export const useWebhookEndpoints = () =>
  useQuery({
    queryKey: developerKeys.endpoints,
    queryFn: () => api<WebhookEndpointDto[]>('/webhook-endpoints'),
  });

/** Polls while open: deliveries happen in the worker, and nothing pushes them to the page. */
export function useWebhookDeliveries(id: string, status: WebhookDeliveryStatus | undefined) {
  return useInfiniteQuery({
    queryKey: developerKeys.deliveries(id, status),
    initialPageParam: undefined as string | undefined,
    refetchInterval: 5_000,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (status) params.set('status', status);
      if (pageParam) params.set('cursor', pageParam);
      return api<CursorPage<WebhookDeliveryDto>>(`/webhook-endpoints/${id}/deliveries?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
