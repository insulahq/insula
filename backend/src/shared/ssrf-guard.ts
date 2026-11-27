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
import { BlockList, isIP } from 'node:net';

/**
 * Never a destination, whatever the policy: loopback, unspecified, link-local
 * (cloud metadata), multicast, reserved and benchmark ranges, IETF protocol
 * assignments, and the IPv6 forms that embed or stand for an IPv4 address
 * (IPv4-compatible, 6to4, NAT64) or are site-/link-scoped. A form the parser
 * does not take apart (a mapped address in hex) fails closed.
 */
function ipIsSpecial(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0 || o[0] === 127) return true;                 // "this host", loopback
    if (o[0] === 169 && o[1] === 254) return true;               // link-local + cloud metadata
    if (o[0]! >= 224) return true;                               // multicast, reserved, broadcast
    if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true;   // IETF protocol assignments
    if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true; // benchmarking
    return false;
  }
  if (v === 6) {
    const lo = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lo === '::1' || lo === '::') return true;                // loopback / unspecified
    if (lo.startsWith('::ffff:')) return isIP(lo.slice(7)) === 4 ? ipIsSpecial(lo.slice(7)) : true; // v4-mapped
    if (/^::(\d+\.\d+\.\d+\.\d+|([0-9a-f]{1,4}:)?[0-9a-f]{1,4})$/.test(lo)) return true; // IPv4-compatible ::/96
    if (lo.startsWith('64:ff9b:')) return true;                  // NAT64 (::/96 and :1::/48)
    const h0 = parseInt(lo.split(':')[0] || '0', 16);
    if (h0 >= 0xfe80 && h0 <= 0xfeff) return true;               // link-local fe80::/10, site-local fec0::/10
    if (h0 >= 0xff00) return true;                               // multicast
    if (h0 === 0x2002) return true;                              // 6to4 can embed internal v4
    return false;
  }
  return true; // not a literal IP → fail closed
}

/** The private ranges: RFC 1918, CGNAT (k8s / cloud), IPv6 unique-local. */
function ipIsPrivate(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 10) return true;
    if (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1]! >= 64 && o[1]! <= 127) return true;
    return false;
  }
  if (v === 6) {
    const lo = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lo.startsWith('::ffff:') && isIP(lo.slice(7)) === 4) return ipIsPrivate(lo.slice(7));
    const h0 = parseInt(lo.split(':')[0] || '0', 16);
    return (h0 & 0xfe00) === 0xfc00;                             // unique-local fc00::/7
  }
  return false;
}

/** True when an IP literal is loopback / private / link-local / CGNAT / ULA or otherwise special. */
export function ipIsInternal(ip: string): boolean {
  return ipIsSpecial(ip) || ipIsPrivate(ip);
}

/**
 * Which internal destinations a fetch may still reach. The default is none.
 * `allowPrivate` opens the private ranges (RFC 1918, CGNAT, IPv6 unique-local)
 * for a service on the operator's own network; loopback, link-local (cloud
 * metadata) and `deniedCidrs` stay refused even then.
 */
export interface InternalAccessPolicy {
  readonly allowPrivate?: boolean;
  /** Refused whatever else is allowed: the cluster's pod and service networks. */
  readonly deniedCidrs?: readonly string[];
}

function ipInCidrs(ip: string, cidrs: readonly string[]): boolean {
  const addr = ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(addr) === 4 ? 'ipv4' : isIP(addr) === 6 ? 'ipv6' : null;
  if (!family) return false;
  const list = new BlockList();
  for (const c of cidrs) {
    // A bare address is its own /32 or /128. An entry that does not parse is
    // skipped, never thrown: this runs inside a DNS lookup callback.
    const [net = '', bits] = c.trim().split('/');
    const netFamily = isIP(net) === 4 ? 'ipv4' : isIP(net) === 6 ? 'ipv6' : null;
    if (netFamily !== family) continue;
    const prefix = bits === undefined ? (netFamily === 'ipv4' ? 32 : 128) : Number(bits);
    try { list.addSubnet(net, prefix, netFamily); } catch { /* out-of-range prefix: skipped */ }
  }
  return list.check(addr, family);
}

/** True when `ip` may not be reached under `policy` (no policy: every internal address). */
export function ipIsRefused(ip: string, policy: InternalAccessPolicy = {}): boolean {
  if (ipIsSpecial(ip)) return true;
  if (ipInCidrs(ip, policy.deniedCidrs ?? [])) return true;
  return ipIsPrivate(ip) && !policy.allowPrivate;
}

/** Reject a URL whose host is a literal internal IP (lookup never sees these). */
export function urlHostIsInternalLiteral(urlStr: string, policy: InternalAccessPolicy = {}): boolean {
  let host: string;
  try {
    host = new URL(urlStr).hostname;
  } catch {
    return true; // unparseable → block
  }
  host = host.replace(/^\[|\]$/g, '');
  return isIP(host) !== 0 && ipIsRefused(host, policy);
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/** A lookup that refuses to resolve a hostname to an address `policy` refuses. */
function safeLookupFor(policy: InternalAccessPolicy) {
  return (hostname: string, options: unknown, callback?: LookupCb): void => safeLookup(hostname, options, callback, policy);
}

/** Custom lookup that refuses to resolve a hostname to an internal address. */
function safeLookup(hostname: string, options: unknown, callback?: LookupCb, policy: InternalAccessPolicy = {}): void {
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
      if (ipIsRefused(a.address, policy)) {
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
  /** Internal destinations this fetch may reach (default: none). */
  readonly policy?: InternalAccessPolicy;
}

export interface GuardedFetchResult {
  readonly status: number;
  readonly body: string;
  /** The same body as bytes (binary responses: images). */
  readonly bytes: Buffer;
  /** The body was longer than `maxBytes`; `body` holds its start only. */
  readonly truncated: boolean;
  /** A redirect's Location (redirects are never followed). */
  readonly location?: string;
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
  const { method = 'GET', timeoutMs = 30_000, maxBytes = 64 * 1024, headers = {}, policy = {} } = options;

  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return Promise.reject(new SsrfBlockedError(`Unparseable URL: ${urlStr}`));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(new SsrfBlockedError(`Unsupported scheme ${url.protocol} (only http/https)`));
  }
  if (urlHostIsInternalLiteral(urlStr, policy)) {
    return Promise.reject(new SsrfBlockedError(`Refusing internal address ${url.hostname}`));
  }

  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<GuardedFetchResult>((resolve, reject) => {
    const req = doRequest(
      urlStr,
      {
        method,
        headers,
        lookup: safeLookupFor(policy) as never,
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
          const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, body: bytes.toString('utf8'), bytes, truncated: total > maxBytes, ...(location ? { location } : {}) });
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
