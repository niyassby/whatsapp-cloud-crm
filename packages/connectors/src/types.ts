/**
 * The connector interface. A connector is one object: how it authenticates, what it can trigger,
 * what it can do, how its webhooks are checked and read, and how it syncs. The framework (API and
 * worker) does everything else: storing encrypted credentials, OAuth state, token refresh, health
 * checks, the event log, retries and starting flows. Adding a connector is adding one of these.
 */
import type { ConnectorCategory } from '@wacrm/shared';

export interface ConnectorField {
  key: string;
  label: string;
  /** secret: encrypted at rest and never shown again. */
  type?: 'text' | 'secret' | 'url';
  required?: boolean;
  help?: string;
  placeholder?: string;
}

export interface OAuth2Auth {
  type: 'oauth2';
  /** Provider pages. May use {settings.x}, such as a shop domain. */
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  scopeSeparator?: string;
  /** Environment variables holding the app's client id and secret. */
  clientIdEnv: string;
  clientSecretEnv: string;
  extraAuthorizeParams?: Record<string, string>;
}

export type ConnectorAuth =
  | { type: 'api_key'; fields: ConnectorField[] }
  | OAuth2Auth
  /** No account to sign in to: the framework makes a signing secret for incoming webhooks. */
  | { type: 'webhook_secret' }
  | { type: 'none' };

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** A string is sent as is; anything else as JSON. */
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
  /** The body parsed as JSON, or null. */
  json: unknown;
}

/** What a connector gets when it runs: its connection's values and a safe way out to the web. */
export interface ConnectorContext {
  connectionId: string;
  credentials: Record<string, string>;
  settings: Record<string, string>;
  /** https only, no internal addresses, 10 seconds. The same guard as webhooks and flows. */
  http: (req: HttpRequest) => Promise<HttpResponse>;
}

/** Thrown by an action or check. `retryable` lets a sync or event try again later. */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly opts: { retryable?: boolean; reconnect?: boolean } = {},
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export interface ConnectorTrigger {
  key: string;
  name: string;
  description: string;
  sample?: Record<string, unknown>;
}

export interface ConnectorAction {
  key: string;
  name: string;
  description: string;
  input?: ConnectorField[];
  /** Keys of the result, offered when saving into flow variables. */
  output?: string[];
  run(ctx: ConnectorContext, input: Record<string, string>): Promise<Record<string, unknown>>;
}

/** Who an event is about, so a flow can start for that contact. */
export interface EventContact {
  phone?: string | null;
  email?: string | null;
  name?: string | null;
}

/** An outside event in the app's own shape. */
export interface MappedEvent {
  /** One of the connector's trigger keys. */
  trigger: string;
  /** Stable id from the provider, so a redelivered or re-synced event is handled once. */
  externalId: string;
  contact: EventContact | null;
  data: Record<string, unknown>;
}

export interface InboundRequest {
  rawBody: Buffer;
  /** Lower-case header names. */
  headers: Record<string, string>;
}

export interface ConnectorWebhook {
  /** Credential key holding the signing secret. Default `webhookSecret`, made by the framework. */
  secretField?: string;
  /** Check the request came from the provider, on the exact bytes it sent. */
  verify(req: InboundRequest, secret: string, settings: Record<string, string>): boolean;
  /** The provider's id for this delivery, if it sends one; otherwise the body's hash is used. */
  deliveryId?(req: InboundRequest): string | null;
  /** Turn one delivery into events. Unknown or unwanted deliveries map to none. */
  map(
    body: unknown,
    headers: Record<string, string>,
    settings: Record<string, string>,
  ): MappedEvent[];
}

export interface ConnectorSync {
  everyMinutes: number;
  /** Fetch what changed since `cursor`; return events and the next cursor. */
  run(ctx: ConnectorContext, cursor: unknown): Promise<{ events: MappedEvent[]; cursor: unknown }>;
}

export interface ConnectorDefinition {
  key: string;
  name: string;
  description: string;
  category: ConnectorCategory;
  website?: string;
  auth: ConnectorAuth;
  settings?: ConnectorField[];
  triggers?: ConnectorTrigger[];
  actions?: ConnectorAction[];
  webhook?: ConnectorWebhook;
  /** Throws when the connection no longer works. Run after connecting and every hour. */
  healthCheck?(ctx: ConnectorContext): Promise<void>;
  sync?: ConnectorSync;
}
