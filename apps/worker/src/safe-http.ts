import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isPrivateAddress } from '@wacrm/shared/server';

export interface SafeHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Bytes of the response kept; the rest is read and dropped. */
  maxBytes: number;
  timeoutMs: number;
}

export interface SafeHttpResponse {
  status: number;
  body: string;
  contentType: string | null;
}

export type SafeHttp = (req: SafeHttpRequest) => Promise<SafeHttpResponse>;

/**
 * Requests to addresses customers choose (webhook endpoints, flow HTTP steps). The address is
 * checked when connecting rather than beforehand, so a name cannot pass a check and then resolve
 * somewhere internal. Redirects are not followed, since one could point anywhere.
 */
export function createSafeHttp(opts: { allowPrivate: boolean }): SafeHttp {
  const lookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as unknown as { address: string; family: number }[];
      if (!opts.allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        return callback(new Error('This address is not reachable from the internet'), '', 0);
      }
      if (options.all) return callback(null, list as never, 0);
      const first = list[0];
      return first
        ? callback(null, first.address, first.family)
        : callback(new Error('No address'), '', 0);
    });
  };

  return (req) =>
    new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        reject(new Error('This is not a valid address'));
        return;
      }
      // Callers decide whether plain http is acceptable; webhook endpoints and flows insist on https.
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        reject(new Error('Only http and https addresses are allowed'));
        return;
      }
      if (!opts.allowPrivate && isPrivateLiteral(url.hostname)) {
        reject(new Error('This address is not reachable from the internet'));
        return;
      }
      const client = url.protocol === 'https:' ? https : http;
      const headers: Record<string, string | number> = { ...req.headers };
      if (req.body !== undefined) headers['content-length'] = Buffer.byteLength(req.body);
      const request = client.request(
        url,
        { method: req.method, headers, timeout: req.timeoutMs, lookup },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            if (size < req.maxBytes) chunks.push(chunk);
            size += chunk.length;
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8').slice(0, req.maxBytes),
              contentType: res.headers['content-type'] ?? null,
            }),
          );
          res.on('error', reject);
        },
      );
      request.on('timeout', () =>
        request.destroy(new Error(`Timed out after ${Math.round(req.timeoutMs / 1000)} seconds`)),
      );
      request.on('error', reject);
      request.end(req.body);
    });
}

/** A hostname that is already an address never goes through `lookup`. */
function isPrivateLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return /^[\d.]+$|:/.test(host) && isPrivateAddress(host);
}
