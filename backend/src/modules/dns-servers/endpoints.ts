/**
 * Where each configured DNS server's management API listens — host and port
 * only, never a credential.
 *
 * The platform writes DNS from whichever server a platform-api pod runs on, so
 * a server that cannot reach that API makes every DNS change handled there
 * fail. A new server is the case that bit production: it had joined the mesh
 * VPN the DNS API sits behind, but never connected, and nothing said so until
 * a webmail record failed to publish. The join line checks these endpoints
 * from the new host before anything is installed (scripts/join-node.sh).
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { dnsServers } from '../../db/schema.js';
import { decrypt } from '../oidc/crypto.js';

export interface DnsApiEndpoint {
  /** The server's display name, for the panel's note. */
  readonly name: string;
  /** Hostname, IPv4, or a bracketed IPv6 address. */
  readonly host: string;
  readonly port: number;
}

/** Exactly what scripts/join-node.sh accepts for --check-dns. */
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const BRACKETED_V6_RE = /^\[[0-9A-Fa-f:.]{2,45}\]$/;

export function isCheckableHost(host: string): boolean {
  return HOSTNAME_RE.test(host) || BRACKETED_V6_RE.test(host);
}

function fromUrl(raw: unknown): { host: string; port: number } | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { host: url.hostname, port };
}

/** Fixed API hosts of the hosted providers (see each provider's baseUrl). */
const HOSTED_API: Record<string, { host: string; port: number }> = {
  cloudflare: { host: 'api.cloudflare.com', port: 443 },
  hetzner: { host: 'dns.hetzner.com', port: 443 },
  route53: { host: 'route53.amazonaws.com', port: 443 },
};

/**
 * Pure. null for a provider with nothing to reach (mock) or a config this
 * cannot read — an unreadable endpoint is not checked rather than guessed.
 */
export function dnsApiEndpoint(
  providerType: string,
  config: Record<string, unknown>,
): { host: string; port: number } | null {
  let hit: { host: string; port: number } | null;
  switch (providerType) {
    case 'powerdns':
      hit = fromUrl(config.api_url);
      break;
    case 'cloudns':
      hit = fromUrl(config.api_url ?? 'https://api.cloudns.net');
      break;
    case 'rndc': {
      const port = Number(config.rndc_port ?? 953);
      hit = typeof config.server_host === 'string' && Number.isInteger(port)
        ? { host: config.server_host.includes(':') && !config.server_host.startsWith('[') ? `[${config.server_host}]` : config.server_host, port }
        : null;
      break;
    }
    default:
      hit = HOSTED_API[providerType] ?? null;
  }
  if (!hit || !isCheckableHost(hit.host) || hit.port < 1 || hit.port > 65535) return null;
  return hit;
}

/**
 * A name only the cluster's own DNS resolves (`<svc>.<ns>.svc.cluster.local`,
 * a bare Service name) or a loopback address. A host checks from OUTSIDE the
 * cluster, before it joins, so it can never reach these — checking them would
 * warn on every join and teach operators to answer "yes". The API pods reach
 * them through cluster DNS regardless of the node they run on.
 */
export function isInClusterHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || /^127\./.test(h) || h === '[::1]') return true;
  if (h.endsWith('.svc') || h.endsWith('.cluster.local') || h.includes('.svc.')) return true;
  return !h.includes('.') && !h.startsWith('[');
}

export interface DnsApiEndpointList {
  readonly endpoints: readonly DnsApiEndpoint[];
  /** Enabled servers that are NOT checked, and why — said in the panel's note. */
  readonly notChecked: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

/** The key the DNS server module itself uses (dns-servers/routes.ts). */
function resolveEncryptionKey(env: NodeJS.ProcessEnv = process.env): string {
  const k = env.PLATFORM_ENCRYPTION_KEY;
  if (k && k.length >= 32) return k;
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return '0'.repeat(64);
  throw new Error('PLATFORM_ENCRYPTION_KEY is required to read the DNS server settings');
}

/** Every enabled DNS server's API endpoint, once per host:port. */
export async function listDnsApiEndpoints(db: Database, encryptionKey = resolveEncryptionKey()): Promise<DnsApiEndpointList> {
  const rows = await db.select().from(dnsServers).where(eq(dnsServers.enabled, 1));
  const out = new Map<string, DnsApiEndpoint>();
  const notChecked: Array<{ name: string; reason: string }> = [];
  for (const row of rows) {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(decrypt(row.connectionConfigEncrypted, encryptionKey)) as Record<string, unknown>;
    } catch (err) {
      console.warn(`[dns-servers] settings of '${row.displayName}' unreadable — not checked at join:`, err instanceof Error ? err.message : String(err));
      notChecked.push({ name: row.displayName, reason: 'its settings could not be read' });
      continue;
    }
    if (row.providerType === 'mock') continue;
    const ep = dnsApiEndpoint(row.providerType, config);
    if (!ep) {
      notChecked.push({ name: row.displayName, reason: 'it has no API address that can be checked' });
      continue;
    }
    if (isInClusterHost(ep.host)) {
      notChecked.push({ name: row.displayName, reason: `${ep.host} is reachable from inside the cluster only` });
      continue;
    }
    const key = `${ep.host.toLowerCase()}:${ep.port}`;
    if (!out.has(key)) out.set(key, { name: row.displayName, ...ep });
  }
  return { endpoints: [...out.values()], notChecked };
}
