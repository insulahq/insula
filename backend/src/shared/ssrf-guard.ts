/**
 * SSRF guard for platform-api outbound fetches whose URL is (even partly)
 * attacker-influenced — the tenant-configured webcron URL being the canonical
 * case (H-4). platform-api runs with broad cluster reach (it can hit the kube
 * API, CNPG, the cloud metadata endpoint, Longhorn, vmsingle, …), so an
 * unguarded fetch of a tenant-supplied URL is a request-forgery primitive that
 * reflects the response body straight back to the tenant.
 *
 * Two layers, mirroring the file-manager sidecar's proven guard:
 *   1. Reject a URL whose host is a LITERAL internal IP — node's http(s)
 *      request skips the `lookup` callback entirely for IP literals, so the
 *      custom lookup below would never see `http://169.254.169.254/`.
 *   2. A custom DNS `lookup` that refuses to resolve to an internal address —
 *      this is what closes DNS-rebinding: the IP validated is the exact IP the
 *      socket connects to, not a re-resolved one.
 *
 * Redirects are NOT followed: a 3xx Location pointing at an internal address
 * would re-open the rebind window. A webcron target that 3xx-redirects simply
 * gets its redirect status reported.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

/** True when an IP literal is loopback / private / link-local / CGNAT / ULA. */
export function ipIsInternal(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0) return true;                                 // 0.0.0.0/8 "this host"
    if (o[0] === 127) return true;                               // loopback
    if (o[0] === 10) return true;                                // private
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;   // private
    if (o[0] === 192 && o[1] === 168) return true;               // private
    if (o[0] === 169 && o[1] === 254) return true;               // link-local + cloud metadata
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;  // CGNAT (k8s / cloud)
    return false;
  }
  if (v === 6) {
    const lo = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lo === '::1' || lo === '::') return true;                // loopback / unspecified
    if (lo.startsWith('::ffff:')) return ipIsInternal(lo.slice(7)); // v4-mapped
    const h0 = parseInt(lo.split(':')[0] || '0', 16);
    if (h0 >= 0xfe80 && h0 <= 0xfebf) return true;               // link-local fe80::/10
    if ((h0 & 0xfe00) === 0xfc00) return true;                   // unique-local fc00::/7
    if (h0 === 0x2002) return true;                              // 6to4 can embed internal v4
    return false;
  }
  return true; // not a literal IP → fail closed
}

/** Reject a URL whose host is a literal internal IP (lookup never sees these). */
export function urlHostIsInternalLiteral(urlStr: string): boolean {
  let host: string;
  try {
    host = new URL(urlStr).hostname;
  } catch {
    return true; // unparseable → block
  }
  host = host.replace(/^\[|\]$/g, '');
  return isIP(host) !== 0 && ipIsInternal(host);
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/** Custom lookup that refuses to resolve a hostname to an internal address. */
function safeLookup(hostname: string, options: unknown, callback?: LookupCb): void {
  let cb: LookupCb;
  let opts: Record<string, unknown>;
  if (typeof options === 'function') {
    cb = options as LookupCb;
    opts = {};
  } else {
    cb = callback as LookupCb;
    opts = (typeof options === 'object' && options ? options : {}) as Record<string, unknown>;
  }
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    for (const a of list) {
      if (ipIsInternal(a.address)) {
        return cb(Object.assign(new Error(`Blocked internal address ${a.address} for ${hostname}`), { code: 'EBLOCKEDADDR' }));
      }
    }
    if (opts.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

/** Raised when a URL is rejected before any connection is attempted. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export interface GuardedFetchOptions {
  readonly method?: string;
  readonly timeoutMs?: number;
  /** Response body cap (bytes) — the caller usually only keeps a preview. */
  readonly maxBytes?: number;
  readonly headers?: Record<string, string>;
}

export interface GuardedFetchResult {
  readonly status: number;
  readonly body: string;
}

/**
 * Fetch a public URL, refusing any internal / metadata destination at connect
 * time (rebind-safe). Only http/https; no redirect following. Throws
 * SsrfBlockedError for a rejected URL and a plain Error for network failures.
 */
export function guardedFetch(
  urlStr: string,
  options: GuardedFetchOptions = {},
): Promise<GuardedFetchResult> {
  const { method = 'GET', timeoutMs = 30_000, maxBytes = 64 * 1024, headers = {} } = options;

  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return Promise.reject(new SsrfBlockedError(`Unparseable URL: ${urlStr}`));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(new SsrfBlockedError(`Unsupported scheme ${url.protocol} (only http/https)`));
  }
  if (urlHostIsInternalLiteral(urlStr)) {
    return Promise.reject(new SsrfBlockedError(`Refusing internal address ${url.hostname}`));
  }

  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<GuardedFetchResult>((resolve, reject) => {
    const req = doRequest(
      urlStr,
      {
        method,
        headers,
        lookup: safeLookup as never,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total <= maxBytes) chunks.push(c);
          if (total > maxBytes * 4) res.destroy(); // hard stop runaway bodies
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Request to ${url.hostname} timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EBLOCKEDADDR') {
        reject(new SsrfBlockedError(err.message));
      } else {
        reject(err);
      }
    });
    req.end();
  });
}
