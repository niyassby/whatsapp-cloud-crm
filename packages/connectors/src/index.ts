import { customStore } from './connectors/custom-store';
import { demoStore } from './connectors/demo-store';
import { shopify } from './connectors/shopify';
import { woocommerce } from './connectors/woocommerce';
import { ConnectorRegistry } from './registry';
import type { ConnectorDefinition } from './types';

export * from './types';
export * from './registry';
export * from './oauth';
export * from './signing';
export * from './commerce';
export { customStore, demoStore, shopify, woocommerce };
export {
  mapShopify,
  SHOPIFY_API_VERSION,
  SHOPIFY_TOPICS,
  shopifyOrder,
} from './connectors/shopify';
export { mapWoo, WOO_TOPICS, wooOrder } from './connectors/woocommerce';
export { mapCustom } from './connectors/custom-store';

/** Connectors every installation offers. Phase 3.6 adds payments and CRMs. */
export const BUILT_IN_CONNECTORS: ConnectorDefinition[] = [shopify, woocommerce, customStore];

/** The registry the API and worker share. Extra definitions are how tests add a connector. */
export function buildRegistry(
  opts: {
    demo?: boolean;
    extra?: ConnectorDefinition[];
    env?: Record<string, string | undefined>;
  } = {},
): ConnectorRegistry {
  return new ConnectorRegistry(
    [...BUILT_IN_CONNECTORS, ...(opts.demo ? [demoStore] : []), ...(opts.extra ?? [])],
    opts.env,
  );
}
