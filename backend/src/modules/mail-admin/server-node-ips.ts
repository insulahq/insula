/**
 * Resolve the server-role node IPs that actually SEND mail — the set the
 * deliverability probes (forward/reverse DNS, DNSBL, SMTP banner) run
 * against. Honors the mail port-exposure mode:
 *
 *   thisNodeOnly    — only the active node binds public mail hostPorts,
 *                     so only its IP is externally visible.
 *   allServerNodes  — every server-role node's IP (haproxy DaemonSet
 *                     targets) PLUS the active node (Stalwart + cert live
 *                     there even if it's a worker).
 *
 * Prefers ExternalIP, falling back to InternalIP (single-NIC cloud VPS
 * where the InternalIP *is* the public IP). Extracted from mail-admin
 * routes so the deliverability route AND the blocklist scheduler share
 * one source of truth.
 */

import type { Database } from '../../db/index.js';

export const NODE_ROLE_LABEL_KEY = 'insula.host/node-role';

interface NodeAddress { type?: string; address?: string }
interface NodeShape {
  metadata?: { name?: string; labels?: Record<string, string> };
  status?: { addresses?: NodeAddress[] };
}

const isV6 = (a: NodeAddress) => (a.address ?? '').includes(':');

function nodeIp(n: NodeShape): string | null {
  // IPv4 only. On a dual-stack cluster a Node carries two addresses per type,
  // and every caller of this function wants the v4 (PTR/FCrDNS and the DNSBL
  // zones the deliverability probes query are IPv4 concepts). Filtering by
  // family makes that explicit instead of relying on k3s's listing order.
  const addrs = (n.status?.addresses ?? []).filter((a) => !isV6(a));
  const ext = addrs.find((a) => a.type === 'ExternalIP')?.address;
  const internal = addrs.find((a) => a.type === 'InternalIP')?.address;
  return ext ?? internal ?? null;
}

/**
 * The node's globally-routable IPv6, or null.
 *
 * No InternalIP fallback, unlike the v4 path: bootstrap publishes only a GLOBAL
 * v6 as ExternalIP, so an InternalIP v6 is a ULA — unroutable off-link and
 * never a valid AAAA target for `mail.<apex>`.
 */
function nodeIpv6(n: NodeShape): string | null {
  const addrs = (n.status?.addresses ?? []).filter(isV6);
  return addrs.find((a) => a.type === 'ExternalIP')?.address ?? null;
}

/**
 * Same selection as resolveServerNodeIps, for IPv6.
 *
 * Returns [] on a single-stack cluster and on dual-stack clusters whose nodes
 * have no global v6 — both mean "this cluster publishes no AAAA target", which
 * callers must treat as "nothing to check", not as a fault.
 */
export async function resolveServerNodeIpv6s(
  k8s: { core: { listNode: (q?: object) => Promise<unknown> } },
  db: Database,
): Promise<string[]> {
  return resolveServerNodeAddrs(k8s, db, nodeIpv6);
}

export async function resolveServerNodeIps(
  k8s: { core: { listNode: (q?: object) => Promise<unknown> } },
  db: Database,
): Promise<string[]> {
  return resolveServerNodeAddrs(k8s, db, nodeIp);
}

async function resolveServerNodeAddrs(
  k8s: { core: { listNode: (q?: object) => Promise<unknown> } },
  db: Database,
  pick: (n: NodeShape) => string | null,
): Promise<string[]> {
  const { systemSettings } = await import('../../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [settings] = await db
    .select({
      mode: systemSettings.mailPortExposureMode,
      activeNode: systemSettings.mailActiveNode,
    })
    .from(systemSettings)
    .where(eq(systemSettings.id, 'system'));
  const mode = settings?.mode ?? 'allServerNodes';
  const activeNode = settings?.activeNode ?? null;

  const list = await k8s.core.listNode({}) as { items?: NodeShape[] };
  const items = list.items ?? [];

  if (mode === 'thisNodeOnly') {
    if (!activeNode) return [];
    const node = items.find((n) => n.metadata?.name === activeNode);
    if (!node) return [];
    const ip = pick(node);
    return ip ? [ip] : [];
  }

  const ips: string[] = [];
  for (const node of items) {
    const role = node.metadata?.labels?.[NODE_ROLE_LABEL_KEY] ?? '';
    if (role !== 'server') continue;
    const ip = pick(node);
    if (ip && !ips.includes(ip)) ips.push(ip);
  }
  if (activeNode) {
    const node = items.find((n) => n.metadata?.name === activeNode);
    const ip = node ? pick(node) : null;
    if (ip && !ips.includes(ip)) ips.push(ip);
  }
  return ips;
}
