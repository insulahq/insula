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

function nodeIp(n: NodeShape): string | null {
  const addrs = n.status?.addresses ?? [];
  const ext = addrs.find((a) => a.type === 'ExternalIP')?.address;
  const internal = addrs.find((a) => a.type === 'InternalIP')?.address;
  return ext ?? internal ?? null;
}

export async function resolveServerNodeIps(
  k8s: { core: { listNode: (q?: object) => Promise<unknown> } },
  db: Database,
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
    const ip = nodeIp(node);
    return ip ? [ip] : [];
  }

  const ips: string[] = [];
  for (const node of items) {
    const role = node.metadata?.labels?.[NODE_ROLE_LABEL_KEY] ?? '';
    if (role !== 'server') continue;
    const ip = nodeIp(node);
    if (ip && !ips.includes(ip)) ips.push(ip);
  }
  if (activeNode) {
    const node = items.find((n) => n.metadata?.name === activeNode);
    const ip = node ? nodeIp(node) : null;
    if (ip && !ips.includes(ip)) ips.push(ip);
  }
  return ips;
}
