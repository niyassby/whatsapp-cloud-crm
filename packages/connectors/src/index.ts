import { customStore } from './connectors/custom-store';
import { demoStore } from './connectors/demo-store';
import { googleSheets } from './connectors/google-sheets';
import { hubspot } from './connectors/hubspot';
import { razorpay } from './connectors/razorpay';
import { shopify } from './connectors/shopify';
import { stripe } from './connectors/stripe';
import { woocommerce } from './connectors/woocommerce';
import { ConnectorRegistry } from './registry';
import type { ConnectorDefinition } from './types';

export * from './types';
export * from './registry';
export * from './oauth';
export * from './signing';
export * from './commerce';
export * from './payments';
export { customStore, demoStore, googleSheets, hubspot, razorpay, shopify, stripe, woocommerce };
export {
  mapShopify,
  SHOPIFY_API_VERSION,
  SHOPIFY_TOPICS,
  shopifyOrder,
} from './connectors/shopify';
export { mapWoo, WOO_TOPICS, wooOrder } from './connectors/woocommerce';
export { mapCustom } from './connectors/custom-store';
export { mapRazorpay, razorpayLink } from './connectors/razorpay';
export {
  formEncode,
  mapStripe,
  STRIPE_EVENTS,
  stripeSession,
  verifyStripeSignature,
} from './connectors/stripe';
export { splitValues, spreadsheetId } from './connectors/google-sheets';

/** Connectors every installation offers. */
export const BUILT_IN_CONNECTORS: ConnectorDefinition[] = [
  shopify,
  woocommerce,
  customStore,
  razorpay,
  stripe,
  googleSheets,
  hubspot,
];

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
