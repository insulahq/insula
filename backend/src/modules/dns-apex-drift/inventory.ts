import { clusterNodes } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type {
  ApexRecord,
  AttributedRecord,
  IngressServer,
} from '@insula/api-contracts';
import type { Classification } from './detector.js';
import { getIngressSettings, parseIngressIps } from '../ingress-routes/service.js';
import { nodeExternalAddresses, nodeIngressState, type NodeLike } from '../ingress-nodes/discovery.js';
import { reconcileIngressAddressesFromNodes } from '../ingress-nodes/reconciler.js';
import { readAddressHistory, rememberAddresses, historyKey, type AddressHistory } from '../ingress-nodes/address-history.js';

/**
 * Which addresses every route hostname should carry, which server each one
 * belongs to, and — for an address that is NOT expected — whether the
 * platform can vouch that it is its own stale record.
 *
 * The expected set is exactly what route provisioning writes
 * (`getIngressSettings`), refreshed from the live node list first, so a
 * per-server change (ingress mode, exposure, a server joining or leaving)
 * shows up at once instead of after the next 5-minute discovery tick — and
 * the scan, the repair and "Refresh route DNS" can never disagree.
 */
export interface IngressInventory {
  readonly source: 'override' | 'discovered' | 'env' | 'fallback';
  readonly expected: AttributedRecord[];
  readonly servers: IngressServer[];
  /**
   * For an address that is present but not expected: stale (and why), held,
   * or null when it is foreign. `platformCreated` says whether a dns_records
   * row the platform owns publishes it.
   */
  classify(record: ApexRecord, platformCreated: boolean): Classification | null;
}

/**
 * What a server's status says about its still-published address. Everything
 * an operator DID (removed the server, disabled its ingress, made it private,
 * replaced it in the override) makes the address stale. Not being Ready is
 * something that HAPPENED — a reboot, a kubelet restart — so the address is
 * held: a repair clicked during a reboot must not cost the server its DNS.
 * A server that never comes back is removed, and then its address is stale.
 */
type Verdict = { readonly kind: 'stale'; readonly reason: 'server-removed' | 'ingress-disabled' | 'private' | 'no-longer-ingress' }
  | { readonly kind: 'held'; readonly reason: 'server-not-ready' };
const VERDICT_BY_STATUS: Record<IngressServer['status'], Verdict> = {
  removed: { kind: 'stale', reason: 'server-removed' },
  'ingress-disabled': { kind: 'stale', reason: 'ingress-disabled' },
  private: { kind: 'stale', reason: 'private' },
  'not-ready': { kind: 'held', reason: 'server-not-ready' },
  'no-public-ip': { kind: 'stale', reason: 'no-longer-ingress' },
  'not-in-override': { kind: 'stale', reason: 'no-longer-ingress' },
  ingress: { kind: 'stale', reason: 'no-longer-ingress' },
};

/**
 * When two servers claim one address, the one that keeps it wins (not Ready →
 * held); otherwise the most specific reason explains the stale record best.
 */
const STATUS_PRECEDENCE: ReadonlyArray<IngressServer['status']> = [
  'not-ready', 'removed', 'ingress-disabled', 'private', 'not-in-override', 'no-public-ip', 'ingress',
];

export async function loadIngressInventory(
  db: Database,
  k8s: K8sClients | null,
): Promise<IngressInventory> {
  let nodes: NodeLike[] | null = null;
  if (k8s) {
    try {
      nodes = ((await k8s.core.listNode()) as unknown as { items?: NodeLike[] }).items ?? [];
      // Same reconcile as the 5-minute tick: refreshes the discovered set and
      // the address history from this exact list.
      await reconcileIngressAddressesFromNodes(db, nodes);
    } catch (err) {
      console.warn('[route-dns] node list unavailable, using stored state:', (err as Error).message);
      nodes = null;
    }
  }

  const settings = await getIngressSettings(db);
  const v4 = parseIngressIps(settings.ingressDefaultIpv4);
  const v6 = parseIngressIps(settings.ingressDefaultIpv6).map((ip) => ip.toLowerCase());
  const expectedKeys = new Set([...v4.map((ip) => historyKey('A', ip)), ...v6.map((ip) => historyKey('AAAA', ip))]);

  // An override address belongs to no node, but it is still one of ours — a
  // VIP replaced later must be recognisable as stale, not foreign.
  if (settings.ingressSource === 'override' || settings.ingressSource === 'env') {
    await rememberAddresses(db, [
      ...v4.map((address) => ({ type: 'A' as const, address, server: null })),
      ...v6.map((address) => ({ type: 'AAAA' as const, address, server: null })),
    ]).catch(() => undefined);
  }

  const history = await readAddressHistory(db);
  const servers = await buildServers(db, nodes, expectedKeys, history);

  const owners = new Map<string, IngressServer[]>();
  for (const s of servers) {
    for (const ip of s.ipv4) addOwner(owners, historyKey('A', ip), s);
    for (const ip of s.ipv6) addOwner(owners, historyKey('AAAA', ip), s);
  }

  const expected: AttributedRecord[] = [
    ...v4.map((content) => ({ type: 'A' as const, content })),
    ...v6.map((content) => ({ type: 'AAAA' as const, content })),
  ].map((r) => ({
    ...r,
    servers: (owners.get(historyKey(r.type, r.content)) ?? [])
      .filter((s) => s.status === 'ingress').map((s) => s.name),
  }));

  return {
    source: settings.ingressSource,
    expected,
    servers,
    classify(record, platformCreated) {
      const key = historyKey(record.type, record.content);
      const own = owners.get(key) ?? [];
      if (own.length > 0) {
        const status = STATUS_PRECEDENCE.find((st) => own.some((s) => s.status === st)) ?? 'ingress';
        return { ...VERDICT_BY_STATUS[status], servers: own.map((s) => s.name) };
      }
      // A server's former address (its IP changed, or it left before this
      // scan could see it) — still ours, attributed to whoever had it.
      const past = history[key];
      if (past) {
        if (!past.server) return { kind: 'stale', servers: [], reason: 'no-longer-ingress' };
        const now = servers.find((s) => s.name === past.server);
        return { kind: 'stale', servers: [past.server], reason: !now || now.status === 'removed' ? 'server-removed' : 'no-longer-ingress' };
      }
      if (platformCreated) return { kind: 'stale', servers: [], reason: 'platform-created' };
      return null;
    },
  };
}

function addOwner(map: Map<string, IngressServer[]>, key: string, server: IngressServer): void {
  const list = map.get(key) ?? [];
  if (!list.some((s) => s.name === server.name)) list.push(server);
  map.set(key, list);
}

/**
 * Every server the platform knows: the live node list when it can be read
 * (with ingress state from labels + readiness), the inventory table otherwise,
 * and — from the address history — servers that are gone.
 */
async function buildServers(
  db: Database,
  nodes: NodeLike[] | null,
  expectedKeys: ReadonlySet<string>,
  history: AddressHistory,
): Promise<IngressServer[]> {
  const out = new Map<string, IngressServer>();

  const statusFor = (base: IngressServer['status'], ipv4: string[], ipv6: string[]): IngressServer['status'] => {
    if (base !== 'ingress') return base;
    const published = [...ipv4.map((ip) => historyKey('A', ip)), ...ipv6.map((ip) => historyKey('AAAA', ip))];
    return published.some((k) => expectedKeys.has(k)) ? 'ingress' : 'not-in-override';
  };

  if (nodes) {
    for (const n of nodes) {
      const name = n.metadata?.name;
      if (!name) continue;
      const { ipv4, ipv6 } = nodeExternalAddresses(n);
      out.set(name, { name, ipv4, ipv6, status: statusFor(nodeIngressState(n), ipv4, ipv6) });
    }
  } else {
    const rows = await db.select({
      name: clusterNodes.name,
      ingressMode: clusterNodes.ingressMode,
      publicIp: clusterNodes.publicIp,
      publicIpv6: clusterNodes.publicIpv6,
      removedAt: clusterNodes.removedAt,
    }).from(clusterNodes);
    for (const r of rows) {
      const ipv4 = r.publicIp ? [String(r.publicIp)] : [];
      const ipv6 = r.publicIpv6 ? [String(r.publicIpv6).toLowerCase()] : [];
      const base: IngressServer['status'] = r.removedAt ? 'removed' : r.ingressMode === 'none' ? 'ingress-disabled' : 'ingress';
      out.set(r.name, { name: r.name, ipv4, ipv6, status: statusFor(base, ipv4, ipv6) });
    }
  }

  // Servers only the history still remembers are gone from the cluster.
  for (const [key, entry] of Object.entries(history)) {
    if (!entry.server || out.has(entry.server) && out.get(entry.server)?.status !== 'removed') continue;
    const [type, address] = key.split('|');
    const prev = out.get(entry.server) ?? { name: entry.server, ipv4: [], ipv6: [], status: 'removed' as const };
    const ipv4 = type === 'A' && !prev.ipv4.includes(address) ? [...prev.ipv4, address] : prev.ipv4;
    const ipv6 = type === 'AAAA' && !prev.ipv6.includes(address) ? [...prev.ipv6, address] : prev.ipv6;
    out.set(entry.server, { ...prev, ipv4, ipv6, status: 'removed' });
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
