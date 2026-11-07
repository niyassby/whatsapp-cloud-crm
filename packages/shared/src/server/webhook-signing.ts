import { createHmac, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

/**
 * Header format `t=<unix seconds>,v1=<hex>`, over `<t>.<body>`. The timestamp is signed, so a
 * captured delivery cannot be replayed later by a receiver that checks it.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'x-wacrm-signature';

export function signWebhook(secret: string, body: string, at: number): string {
  const v1 = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return `t=${at},v1=${v1}`;
}

/** For our tests and the docs' example. Receivers can do the same in any language. */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | undefined,
  opts: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  const t = header?.match(/(?:^|,)t=(\d+)/)?.[1];
  const v1 = header?.match(/(?:^|,)v1=([0-9a-f]+)/)?.[1];
  if (!t || !v1) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > (opts.toleranceSeconds ?? 300)) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');

/** Internal addresses a customer's webhook URL must never reach, such as cloud metadata. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return blocked.check(mapped, 'ipv4');
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i;

/**
 * A reason this URL cannot be a webhook, or null. Refuses what is knowable from the text. Names
 * are checked again when connecting, since a public name can resolve to a private address.
 */
export function webhookUrlProblem(raw: string, opts: { allowPrivate: boolean }): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a full URL';
  }
  if (url.username || url.password) return 'Do not put a username or password in the URL';
  if (opts.allowPrivate) return /^https?:$/.test(url.protocol) ? null : 'Use an https:// address';
  if (url.protocol !== 'https:') return 'Use an https:// address';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) ? isPrivateAddress(host) : INTERNAL_NAME.test(host)) {
    return 'This address is not reachable from the internet';
  }
  return null;
}
