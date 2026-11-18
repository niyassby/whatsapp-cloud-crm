import { describe, expect, it } from 'vitest';
import { baseSecurityHeaders, buildWebCsp } from './csp';

const base = {
  nonce: 'abc123',
  apiUrl: 'https://api.example.com/v1',
  mediaOrigins: ['https://media.example.com/bucket'],
  framable: false,
  dev: false,
};
const directives = (csp: string) =>
  Object.fromEntries(
    csp.split('; ').map((d) => {
      const [name, ...values] = d.split(' ');
      return [name!, values];
    }),
  );

describe('web CSP', () => {
  it('runs only scripts with this request’s nonce, or loaded by one', () => {
    const d = directives(buildWebCsp(base));
    expect(d['script-src']).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(d['script-src']).not.toContain("'unsafe-inline'");
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'none'"]);
  });

  it('reaches the API, its socket and the media store by origin, and nothing framed', () => {
    const d = directives(buildWebCsp(base));
    expect(d['connect-src']).toEqual(
      expect.arrayContaining([
        'https://api.example.com',
        'wss://api.example.com',
        'https://media.example.com',
      ]),
    );
    expect(d['img-src']).toContain('https://media.example.com');
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['upgrade-insecure-requests']).toEqual([]);
  });

  it('does not upgrade requests for an API on plain http', () => {
    const d = directives(buildWebCsp({ ...base, apiUrl: 'http://127.0.0.1:4100' }));
    expect(d['upgrade-insecure-requests']).toBeUndefined();
  });

  it('lets customers frame the website chat widget only', () => {
    expect(directives(buildWebCsp({ ...base, framable: true }))['frame-ancestors']).toEqual(['*']);
  });

  it('allows eval and the dev server socket only in development', () => {
    const dev = directives(buildWebCsp({ ...base, dev: true, apiUrl: 'http://localhost:4000' }));
    expect(dev['script-src']).toContain("'unsafe-eval'");
    expect(dev['connect-src']).toContain('ws://localhost:4000');
    expect(dev['upgrade-insecure-requests']).toBeUndefined();
  });

  it('sends HSTS in production only', () => {
    expect(baseSecurityHeaders({ production: true })['Strict-Transport-Security']).toContain(
      'max-age=31536000',
    );
    expect(baseSecurityHeaders({ production: false })['Strict-Transport-Security']).toBeUndefined();
  });
});
