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
  /**
   * Marketing consent the customer gave in the provider, such as ticking "keep me updated" at a
   * checkout. Only ever moves a contact from unknown to opted in, never over an opt-out.
   */
  consent?: { source: string; proof: string } | null;
}

/** Something the framework does itself instead of starting flows. */
export type EventEffect =
  /** The app was uninstalled or the shop closed: stop and forget the credentials. */
  | { kind: 'disconnect'; reason: string }
  /** The provider asks for the shop's data to be erased: disconnect and blank its event log. */
  | { kind: 'erase'; reason: string }
  /** A request a person must handle, such as a customer asking for their data. */
  | { kind: 'notify'; title: string; body: string };

/** An outside event in the app's own shape. */
export interface MappedEvent {
  /** One of the connector's trigger keys. */
  trigger: string;
  /** Stable id from the provider, so a redelivered or re-synced event is handled once. */
  externalId: string;
  contact: EventContact | null;
  data: Record<string, unknown>;
  /**
   * Runs started by this event remember it, so a later event can stop them: an abandoned cart
   * gives `checkout:<token>`, and the order for that cart cancels it.
   */
  correlation?: string;
  /** Stop runs still waiting that were started with any of these correlations. */
  cancels?: string[];
  /** Handled by the framework; such an event starts no flows. */
  effect?: EventEffect;
}

export interface InboundRequest {
  rawBody: Buffer;
  /** Lower-case header names. */
  headers: Record<string, string>;
}

export interface ConnectorWebhook {
  /** Credential key holding the signing secret. Default `webhookSecret`, made by the framework. */
  secretField?: string;
  /**
   * The signing secret is the app's, from this environment variable, not per connection (Shopify
   * signs every shop's webhooks with the app's client secret).
   */
  secretEnv?: string;
  /** Check the request came from the provider, on the exact bytes it sent. */
  verify(req: InboundRequest, secret: string, settings: Record<string, string>): boolean;
  /** The provider's id for this delivery, if it sends one; otherwise the body's hash is used. */
  deliveryId?(req: InboundRequest): string | null;
  /**
   * Turn one delivery into events. Unknown or unwanted deliveries map to none. Runs in the worker
   * with the connection's context, so it may fetch what the delivery leaves out.
   */
  map(
    body: unknown,
    headers: Record<string, string>,
    settings: Record<string, string>,
    ctx: ConnectorContext,
  ): MappedEvent[] | Promise<MappedEvent[]>;
}

/**
 * Webhooks a provider sends to one address for the whole app rather than per connection, such as
 * Shopify's privacy requests. The framework routes each to the connections it names.
 */
export interface ConnectorAppWebhook {
  /** Environment variable holding the app's signing secret. */
  secretEnv: string;
  verify(req: InboundRequest, secret: string): boolean;
  /** Which connections it is for: those whose setting `key` equals `value`. */
  route(body: unknown, headers: Record<string, string>): { setting: string; value: string } | null;
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
  /**
   * Run after connecting and reconnecting, for example to register webhooks with the provider.
   * Must be safe to run again.
   */
  setup?(ctx: ConnectorContext, opts: { webhookUrl: string | null }): Promise<void>;
  /** Clean and check settings before saving. Return an error message, or the cleaned settings. */
  normalizeSettings?(settings: Record<string, string>): Record<string, string> | string;
  appWebhook?: ConnectorAppWebhook;
}
