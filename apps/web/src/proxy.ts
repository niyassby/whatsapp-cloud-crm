import { baseSecurityHeaders, buildWebCsp } from '@wacrm/shared';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Security headers and a per-request CSP nonce (Phase 4.4). Next reads the nonce from the
 * request's Content-Security-Policy header and puts it on its own scripts; the root layout passes
 * it to next-themes for its inline theme script.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV !== 'production';
  const media = (process.env.MEDIA_PUBLIC_ORIGINS ?? (dev ? 'http://localhost:9000' : ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const csp = buildWebCsp({
    nonce,
    apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
    mediaOrigins: media,
    // Customers embed the website chat widget on their own sites.
    framable: request.nextUrl.pathname.startsWith('/widget/'),
    dev,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  for (const [name, value] of Object.entries(baseSecurityHeaders({ production: !dev }))) {
    response.headers.set(name, value);
  }
  if (!request.nextUrl.pathname.startsWith('/widget/')) {
    response.headers.set('X-Frame-Options', 'DENY');
  }
  return response;
}

export const config = {
  // Pages only: static files and images carry no scripts.
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico|health).*)',
      missing: [{ type: 'header', key: 'next-router-prefetch' }],
    },
  ],
};
