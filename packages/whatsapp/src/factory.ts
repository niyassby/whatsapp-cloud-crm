import type { PhoneCredentials, WhatsAppGateway } from './gateway';
import type { GraphConfig } from './graph';
import { WapiCloudGateway } from './wapi-gateway';

export interface PhoneRef {
  orgId: string;
  phoneNumberId: string;
}

export interface ClientFactoryOptions {
  /**
   * Loads and decrypts credentials under the org's RLS context. Rejects when the org does not
   * own the number. This is what keeps one tenant from using another tenant's cached client.
   */
  loadCredentials: (ref: PhoneRef) => Promise<PhoneCredentials>;
  graph: GraphConfig;
  /** Default 200 clients. */
  maxSize?: number;
  /** Decrypted tokens live in memory at most this long. Default 15 minutes. */
  ttlMs?: number;
  now?: () => number;
  /** Test seam. */
  createGateway?: (phoneNumberId: string, credentials: PhoneCredentials) => WhatsAppGateway;
}

interface Entry {
  orgId: string;
  gateway: WhatsAppGateway;
  expiresAt: number;
}

/**
 * LRU cache of per-number clients keyed by phone_number_id (one SDK instance binds one token,
 * phone number and WABA). Map insertion order is the recency order.
 */
export class WhatsAppClientFactory {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<WhatsAppGateway>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ClientFactoryOptions) {
    this.maxSize = options.maxSize ?? 200;
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async get(ref: PhoneRef): Promise<WhatsAppGateway> {
    const entry = this.cache.get(ref.phoneNumberId);
    // A cache hit must also match the org: otherwise go through the RLS-checked loader.
    if (entry && entry.orgId === ref.orgId && entry.expiresAt > this.now()) {
      this.cache.delete(ref.phoneNumberId);
      this.cache.set(ref.phoneNumberId, entry);
      return entry.gateway;
    }

    const key = `${ref.orgId}:${ref.phoneNumberId}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const load = this.load(ref).finally(() => this.inflight.delete(key));
    this.inflight.set(key, load);
    return load;
  }

  /** Call after reconnecting, rotating a token, or disconnecting a number. */
  invalidate(phoneNumberId: string): void {
    this.cache.delete(phoneNumberId);
  }

  get size(): number {
    return this.cache.size;
  }

  private async load(ref: PhoneRef): Promise<WhatsAppGateway> {
    const credentials = await this.options.loadCredentials(ref);
    const gateway =
      this.options.createGateway?.(ref.phoneNumberId, credentials) ??
      new WapiCloudGateway({
        phoneNumberId: ref.phoneNumberId,
        credentials,
        graph: this.options.graph,
      });
    this.cache.delete(ref.phoneNumberId);
    this.cache.set(ref.phoneNumberId, {
      orgId: ref.orgId,
      gateway,
      expiresAt: this.now() + this.ttlMs,
    });
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return gateway;
  }
}
