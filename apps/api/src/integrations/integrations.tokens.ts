/** DI tokens for the integrations module (kept apart to avoid import cycles). */
export const CONNECTORS = Symbol('CONNECTORS');
/** The fetch used for OAuth token requests. Tests swap in a fake provider. */
export const INTEGRATIONS_FETCH = Symbol('INTEGRATIONS_FETCH');
