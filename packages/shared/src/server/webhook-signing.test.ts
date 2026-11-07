import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isPrivateAddress,
  signWebhook,
  verifyWebhookSignature,
  webhookUrlProblem,
} from './webhook-signing';

describe('signing', () => {
  const NOW = 1_800_000_000;

  it('signs the timestamp and body together, in the documented format', () => {
    const expected = createHmac('sha256', 's').update(`${NOW}.{"a":1}`).digest('hex');
    expect(signWebhook('s', '{"a":1}', NOW)).toBe(`t=${NOW},v1=${expected}`);
  });

  it('verifies, and refuses anything changed', () => {
    const header = signWebhook('s', 'body', NOW);
    const check = (secret: string, body: string, h: string | undefined) =>
      verifyWebhookSignature(secret, body, h, { nowSeconds: NOW });
    expect(check('s', 'body', header)).toBe(true);
    expect(check('other', 'body', header)).toBe(false);
    expect(check('s', 'bodyy', header)).toBe(false);
    expect(check('s', 'body', undefined)).toBe(false);
    expect(check('s', 'body', 'nonsense')).toBe(false);
  });

  it('refuses an old timestamp, so a captured delivery cannot be replayed', () => {
    const header = signWebhook('s', 'body', NOW);
    expect(verifyWebhookSignature('s', 'body', header, { nowSeconds: NOW + 299 })).toBe(true);
    expect(verifyWebhookSignature('s', 'body', header, { nowSeconds: NOW + 301 })).toBe(false);
  });
});

describe('private addresses', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    'not-an-address',
  ])('blocks %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe('webhook URLs', () => {
  const problem = (url: string) => webhookUrlProblem(url, { allowPrivate: false });

  it('accepts a public https address', () => {
    expect(problem('https://example.com/hooks?x=1')).toBeNull();
  });

  it.each([
    'http://example.com/hook',
    'ftp://example.com',
    'https://localhost/hook',
    'https://app.localhost/hook',
    'https://server.internal/hook',
    'https://127.0.0.1/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/hook',
    'https://user:pass@example.com/hook',
    'nonsense',
  ])('refuses %s', (url) => {
    expect(problem(url)).not.toBeNull();
  });

  it('local testing can allow private addresses, but only for testing', () => {
    expect(webhookUrlProblem('http://127.0.0.1:9/x', { allowPrivate: true })).toBeNull();
    expect(webhookUrlProblem('ftp://127.0.0.1/x', { allowPrivate: true })).not.toBeNull();
  });
});
