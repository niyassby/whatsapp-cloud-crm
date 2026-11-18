/**
 * Content Security Policy for the web app (Phase 4.4). Built per request by apps/web/src/proxy.ts
 * with a fresh nonce: scripts run only if they carry it, or were added by a script that did
 * ('strict-dynamic', which is how the Facebook SDK for Embedded Signup loads). A pure function,
 * so the policy is unit tested.
 */
export interface WebCspOptions {
  nonce: string;
  /** The API, for fetch and its Socket.IO connection. */
  apiUrl: string;
  /** Where signed media links point (the S3 public endpoint). */
  mediaOrigins: string[];
  /** The website chat widget is framed by customers' sites; nothing else may be framed. */
  framable: boolean;
  dev: boolean;
}

const FACEBOOK = ['https://*.facebook.com', 'https://*.facebook.net', 'https://*.fbcdn.net'];

const origin = (url: string) => new URL(url).origin;
const wsOrigin = (url: string) => origin(url).replace(/^http/, 'ws');

export function buildWebCsp(o: WebCspOptions): string {
  const api = origin(o.apiUrl);
  const media = o.mediaOrigins.map(origin);
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // 'unsafe-eval' only in development, where React needs it for its debugging tools.
    'script-src': [
      "'self'",
      `'nonce-${o.nonce}'`,
      "'strict-dynamic'",
      ...(o.dev ? ["'unsafe-eval'"] : []),
    ],
    // Inline style attributes are used throughout (positions, chart sizes); styles cannot run code.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', ...media, ...FACEBOOK],
    'media-src': ["'self'", 'blob:', ...media],
    'font-src': ["'self'", 'data:'],
    'connect-src': [
      "'self'",
      api,
      wsOrigin(api),
      ...media,
      ...FACEBOOK,
      ...(o.dev ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : []),
    ],
    'frame-src': FACEBOOK,
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': o.framable ? ['*'] : ["'none'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${[...new Set(v)].join(' ')}`);
  // Only when the API is on https: a plain-http deployment (a local production build) would
  // otherwise have its own API calls upgraded and broken.
  if (!o.dev && api.startsWith('https:')) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

/** Headers every web and API response carries, apart from the CSP. */
export function baseSecurityHeaders(opts: { production: boolean }): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // The microphone is for WhatsApp calls in the inbox; nothing else is used.
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    ...(opts.production
      ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }
      : {}),
  };
}
