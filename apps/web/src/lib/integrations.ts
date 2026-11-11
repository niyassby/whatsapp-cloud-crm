'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  ConnectionStatus,
  ConnectorCategory,
  ConnectorDto,
  CursorPage,
  IntegrationConnectionDto,
  IntegrationEventDto,
} from '@wacrm/shared';
import { api } from './api';

export const integrationKeys = {
  all: ['integrations'] as const,
  connectors: ['integrations', 'connectors'] as const,
  connections: ['integrations', 'connections'] as const,
  connection: (id: string) => ['integrations', 'connections', id] as const,
  events: (id: string) => ['integrations', 'connections', id, 'events'] as const,
};

export const useConnectors = (enabled = true) =>
  useQuery({
    queryKey: integrationKeys.connectors,
    enabled,
    queryFn: () => api<ConnectorDto[]>('/integrations/connectors'),
    staleTime: 5 * 60_000,
  });

export const useConnections = (enabled = true) =>
  useQuery({
    queryKey: integrationKeys.connections,
    enabled,
    queryFn: () => api<IntegrationConnectionDto[]>('/integrations/connections'),
  });

export const useConnection = (id: string) =>
  useQuery({
    queryKey: integrationKeys.connection(id),
    queryFn: () => api<IntegrationConnectionDto>(`/integrations/connections/${id}`),
  });

export function useIntegrationEvents(id: string) {
  return useInfiniteQuery({
    queryKey: integrationKeys.events(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '30' });
      if (pageParam) params.set('cursor', pageParam);
      return api<CursorPage<IntegrationEventDto>>(
        `/integrations/connections/${id}/events?${params}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  commerce: 'Stores',
  payments: 'Payments',
  crm: 'CRM',
  automation: 'Automation',
  other: 'Other',
};

export const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  error: 'Not working',
  needs_reconnect: 'Reconnect needed',
  disconnected: 'Disconnected',
};

export const STATUS_VARIANT: Record<
  ConnectionStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  connected: 'default',
  error: 'destructive',
  needs_reconnect: 'destructive',
  disconnected: 'outline',
};
