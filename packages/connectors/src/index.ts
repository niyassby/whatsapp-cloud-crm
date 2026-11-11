import { demoStore } from './connectors/demo-store';
import { ConnectorRegistry } from './registry';
import type { ConnectorDefinition } from './types';

export * from './types';
export * from './registry';
export * from './oauth';
export * from './signing';
export { demoStore };

/** Connectors every installation offers. Phases 3.5 and 3.6 add Shopify, WooCommerce and more. */
export const BUILT_IN_CONNECTORS: ConnectorDefinition[] = [];

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
