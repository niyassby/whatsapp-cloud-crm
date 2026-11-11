/**
 * Integrations as the API, web and worker see them: connector descriptions (what a marketplace
 * card, a connect form and a flow step need), connections and their event log. The connectors
 * themselves, with their code, live in packages/connectors and run only on the server.
 */
import { z } from 'zod';

export const CONNECTOR_CATEGORIES = ['commerce', 'payments', 'crm', 'automation', 'other'] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export const CONNECTOR_AUTH_TYPES = ['api_key', 'oauth2', 'webhook_secret', 'none'] as const;
export type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number];

/** A field a person fills in: a credential, a setting, or an action's input. */
export interface ConnectorFieldDto {
  key: string;
  label: string;
  /** secret: stored encrypted and never shown again. */
  type: 'text' | 'secret' | 'url';
  required: boolean;
  help: string | null;
  placeholder: string | null;
}

export interface ConnectorTriggerDto {
  key: string;
  name: string;
  description: string;
  /** What {{trigger.data...}} holds, for the flow builder's variable picker. */
  sample: Record<string, unknown>;
}

export interface ConnectorActionDto {
  key: string;
  name: string;
  description: string;
  input: ConnectorFieldDto[];
  /** Fields the result has, for saving into flow variables. */
  output: string[];
}

export interface ConnectorDto {
  key: string;
  name: string;
  description: string;
  category: ConnectorCategory;
  website: string | null;
  authType: ConnectorAuthType;
  /** Filled in when connecting with an API key. */
  credentials: ConnectorFieldDto[];
  /** Plain settings, such as a store address. */
  settings: ConnectorFieldDto[];
  triggers: ConnectorTriggerDto[];
  actions: ConnectorActionDto[];
  receivesWebhooks: boolean;
  syncs: boolean;
  /** OAuth connectors need app credentials on the server before anyone can connect. */
  available: boolean;
}

export const CONNECTION_STATUSES = [
  'connected',
  'error',
  'needs_reconnect',
  'disconnected',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface IntegrationConnectionDto {
  id: string;
  connectorKey: string;
  name: string;
  status: ConnectionStatus;
  settings: Record<string, string>;
  /** Where the provider sends webhooks, when the connector takes them. */
  webhookUrl: string | null;
  lastError: string | null;
  lastHealthAt: string | null;
  lastSyncAt: string | null;
  tokenExpiresAt: string | null;
  createdAt: string;
}

/** Returned once, when connecting: the signing secret to paste into the provider. */
export interface CreatedConnectionDto extends IntegrationConnectionDto {
  webhookSecret: string | null;
}

export const INTEGRATION_EVENT_DIRECTIONS = ['inbound', 'outbound'] as const;
export const INTEGRATION_EVENT_STATUSES = [
  'received',
  'processed',
  'ignored',
  'succeeded',
  'failed',
] as const;
export type IntegrationEventStatus = (typeof INTEGRATION_EVENT_STATUSES)[number];

export interface IntegrationEventDto {
  id: string;
  connectionId: string;
  direction: (typeof INTEGRATION_EVENT_DIRECTIONS)[number];
  /** A trigger key for inbound events, an action key for outbound ones. */
  type: string | null;
  status: IntegrationEventStatus;
  attempts: number;
  error: string | null;
  payload: unknown;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

const fieldValues = z.record(z.string().max(64), z.string().max(4000));

export const createConnectionSchema = z.object({
  connectorKey: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1, 'Required').max(100),
  credentials: fieldValues.default({}),
  settings: fieldValues.default({}),
});
export type CreateConnectionInput = z.input<typeof createConnectionSchema>;

export const updateConnectionSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    /** New credentials replace the old ones whole; reconnects a connection that needed it. */
    credentials: fieldValues.optional(),
    settings: fieldValues.optional(),
  })
  .refine((v) => v.name || v.credentials || v.settings, 'Nothing to update');
export type UpdateConnectionInput = z.input<typeof updateConnectionSchema>;

export const startOAuthSchema = z.object({
  connectorKey: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  settings: fieldValues.default({}),
  /** Reconnect this connection instead of making a new one. */
  connectionId: z.uuid().optional(),
});
export type StartOAuthInput = z.input<typeof startOAuthSchema>;

export const listIntegrationEventsSchema = z.object({
  direction: z.enum([...INTEGRATION_EVENT_DIRECTIONS, 'any']).default('any'),
  status: z.enum([...INTEGRATION_EVENT_STATUSES, 'any']).default('any'),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListIntegrationEventsQuery = z.infer<typeof listIntegrationEventsSchema>;

/** Headers kept with an inbound event, for debugging. Anything that may hold a secret is dropped. */
export function keepableHeaders(headers: Record<string, string | string[] | undefined>) {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase();
    if (value === undefined) continue;
    if (/authorization|cookie|token|secret|key|signature|hmac/.test(n)) continue;
    kept[n] = (Array.isArray(value) ? value.join(', ') : value).slice(0, 500);
  }
  return kept;
}
