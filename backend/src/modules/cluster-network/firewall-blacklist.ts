/**
 * ClusterFirewallBlacklist CRUD service + self-lockout safety belt.
 *
 * Mirrors cluster-trusted-ranges.ts (CustomObjectsApi against the CFB
 * CRD) but ADDS an up-front lockout check on create: the proposed ban
 * is refused if it would catch the operator's current IP, any cluster
 * node IP, any trusted range, or any pending peer. The firewall-
 * reconciler enforces the same belt authoritatively; this is the
 * actionable-error first line.
 */
import { ApiError } from '../../shared/errors.js';
import {
  type FirewallBlacklistEntry,
  type CreateFirewallBlacklistRequest,
  firewallBlacklistEntrySchema,
} from '@insula/api-contracts';
import {
  loadClusterNetworkClients,
  type ClusterNetworkClients,
  type LoadOptions,
  CRD_GROUP,
  CRD_VERSION,
  CFB_PLURAL,
} from './k8s-client.js';
import { listTrustedRanges } from './cluster-trusted-ranges.js';
import { listPendingPeers } from './cluster-pending-peers.js';
import { parseCidr, checkBlacklistLockout, blacklistNameForCidr } from './blacklist-safety.js';

interface CrShape {
  readonly metadata?: { readonly name?: string; readonly creationTimestamp?: string };
  readonly spec?: { readonly cidr?: string; readonly description?: string; readonly addedBy?: string; readonly source?: string };
  readonly status?: {
    readonly normalizedCidr?: string;
    readonly family?: 'v4' | 'v6';
    readonly lastSyncedAt?: string;
    readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string; readonly reason?: string; readonly message?: string }>;
  };
}
interface CrListShape { readonly items?: readonly CrShape[] }

function statusOf(err: unknown): number | undefined {
  return (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
}
function msgOf(err: unknown): string {
  return (err as { body?: { message?: string }; message?: string }).body?.message ?? (err as Error).message ?? String(err);
}
function mapK8sError(err: unknown, op: string): ApiError {
  // M3: don't leak raw apiserver internals (webhook/controller names,
  // constraint text) into the response. Log the detail; return generic.
  console.warn(`[firewall-blacklist] ${op} failed:`, msgOf(err));
  return new ApiError('CLUSTER_NETWORK_K8S_ERROR', `${op} failed — see platform logs for details.`, 502);
}

function toEntry(cr: CrShape): FirewallBlacklistEntry {
  const ready = cr.status?.conditions?.find((c) => c.type === 'Ready');
  const source = cr.spec?.source === 'fail2ban-promote' ? 'fail2ban-promote' : 'manual';
  return firewallBlacklistEntrySchema.parse({
    name: cr.metadata?.name ?? '',
    cidr: cr.spec?.cidr ?? '',
    description: cr.spec?.description ?? '',
    addedBy: cr.spec?.addedBy ?? '',
    source,
    normalizedCidr: cr.status?.normalizedCidr ?? null,
    family: cr.status?.family ?? null,
    lastSyncedAt: cr.status?.lastSyncedAt ?? null,
    ready: ready?.status === 'True' || ready?.status === 'False' || ready?.status === 'Unknown' ? ready.status : 'Unknown',
    readyReason: ready?.reason ?? null,
    readyMessage: ready?.message ?? null,
    createdAt: cr.metadata?.creationTimestamp ?? new Date().toISOString(),
  });
}

export async function listFirewallBlacklist(
  opts: LoadOptions = {},
  clients?: ClusterNetworkClients,
): Promise<FirewallBlacklistEntry[]> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  try {
    const resp = (await c.custom.listClusterCustomObject({
      group: CRD_GROUP, version: CRD_VERSION, plural: CFB_PLURAL,
    } as unknown as Parameters<typeof c.custom.listClusterCustomObject>[0])) as CrListShape;
    return (resp.items ?? []).map(toEntry);
  } catch (err) {
    throw mapK8sError(err, 'list ClusterFirewallBlacklist');
  }
}

/**
 * Gather the protected-IP set the proposed ban must NOT catch:
 *   - the operator's current request IP (passed in)
 *   - every cluster Node InternalIP + ExternalIP
 *   - every trusted range
 *   - every pending peer IP
 */
export async function gatherProtectedIps(
  adminCurrentIp: string | null,
  opts: LoadOptions,
  clients?: ClusterNetworkClients,
): Promise<Array<{ ip: string; kind: string }>> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  const out: Array<{ ip: string; kind: string }> = [];

  if (adminCurrentIp && adminCurrentIp.length > 0) {
    out.push({ ip: adminCurrentIp, kind: 'your current IP' });
  }

  // Node IPs (internal + external). FAIL-CLOSED (H1): the node list is the
  // load-bearing protection — if we can't read it we MUST NOT let a ban
  // through on a weakened check. The caller surfaces this as 503.
  const nodes = await c.core.listNode().catch((err) => {
    throw new ApiError(
      'BLACKLIST_PROTECTION_UNAVAILABLE',
      'Cannot verify lockout safety right now: the cluster node list is unreadable. Retry when the API is reachable.',
      503,
      { detail: msgOf(err) },
    );
  });
  for (const n of nodes.items ?? []) {
    for (const a of n.status?.addresses ?? []) {
      if (a.type === 'InternalIP') out.push({ ip: a.address, kind: `node ${n.metadata?.name ?? ''} internal IP` });
      if (a.type === 'ExternalIP') out.push({ ip: a.address, kind: `node ${n.metadata?.name ?? ''} external IP` });
    }
  }

  // Trusted ranges + peers are best-effort (the reconciler re-checks both
  // authoritatively) — but log loudly when they degrade (H1), so a
  // mystery lockout has a breadcrumb.
  try {
    const ranges = await listTrustedRanges(opts, c);
    for (const r of ranges) out.push({ ip: r.normalizedCidr ?? r.cidr, kind: `trusted range "${r.description || r.cidr}"` });
  } catch (err) {
    console.warn('[firewall-blacklist] trusted-range list failed during lockout check:', msgOf(err));
  }

  try {
    const peers = await listPendingPeers(opts, c);
    for (const p of peers) if (p.ip) out.push({ ip: p.ip, kind: `pending peer ${p.ip}` });
  } catch (err) {
    console.warn('[firewall-blacklist] pending-peer list failed during lockout check:', msgOf(err));
  }

  return out;
}

export async function createFirewallBlacklist(
  req: CreateFirewallBlacklistRequest,
  addedBy: string,
  adminCurrentIp: string | null,
  opts: LoadOptions = {},
  clients?: ClusterNetworkClients,
): Promise<FirewallBlacklistEntry> {
  const c = clients ?? (await loadClusterNetworkClients(opts));

  // 1. type-to-confirm.
  if (req.confirmCidr.trim() !== req.cidr.trim()) {
    throw new ApiError('BLACKLIST_CONFIRM_MISMATCH', 'The confirmation does not match the CIDR you are banning.', 422);
  }

  // 2. parse + family.
  const parsed = parseCidr(req.cidr);
  if (!parsed) {
    throw new ApiError('BLACKLIST_INVALID_CIDR', `"${req.cidr}" is not a valid IP or CIDR.`, 422);
  }

  // 3. self-lockout belt.
  const protectedIps = await gatherProtectedIps(adminCurrentIp, opts, c);
  const verdict = checkBlacklistLockout(parsed, protectedIps);
  if (!verdict.safe) {
    throw new ApiError(
      'BLACKLIST_SELF_LOCKOUT',
      `Refusing to blacklist ${req.cidr}: it would drop ${verdict.hitKind} (${verdict.hitValue}). ` +
        'Banning this would cut off cluster access. Pick a narrower range that excludes protected addresses.',
      422,
      { hitKind: verdict.hitKind, hitValue: verdict.hitValue },
    );
  }

  // M1: derive the k8s name from the CANONICAL cidr so two text forms of
  // the same prefix (2001:db8::/32 vs 2001:0db8::/32) collide on one CR
  // and the 409 "already blacklisted" guard holds.
  const name = blacklistNameForCidr(`${parsed.address}/${parsed.prefix}`);
  const body = {
    apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
    kind: 'ClusterFirewallBlacklist',
    metadata: { name },
    spec: { cidr: req.cidr, description: req.description ?? '', addedBy, source: req.source ?? 'manual' },
  };
  try {
    const resp = (await c.custom.createClusterCustomObject({
      group: CRD_GROUP, version: CRD_VERSION, plural: CFB_PLURAL, body,
    } as unknown as Parameters<typeof c.custom.createClusterCustomObject>[0])) as CrShape;
    return toEntry(resp);
  } catch (err) {
    if (statusOf(err) === 409) {
      throw new ApiError('BLACKLIST_EXISTS', `${req.cidr} is already blacklisted.`, 409);
    }
    if (statusOf(err) === 422 || statusOf(err) === 400) {
      throw new ApiError('BLACKLIST_INVALID', `CRD validation failed: ${msgOf(err)}`, 422);
    }
    throw mapK8sError(err, 'create ClusterFirewallBlacklist');
  }
}

export async function deleteFirewallBlacklist(
  name: string,
  opts: LoadOptions = {},
  clients?: ClusterNetworkClients,
): Promise<void> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  try {
    await c.custom.deleteClusterCustomObject({
      group: CRD_GROUP, version: CRD_VERSION, plural: CFB_PLURAL, name,
    } as unknown as Parameters<typeof c.custom.deleteClusterCustomObject>[0]);
  } catch (err) {
    if (statusOf(err) === 404) throw new ApiError('BLACKLIST_NOT_FOUND', `Blacklist entry "${name}" not found.`, 404);
    throw mapK8sError(err, 'delete ClusterFirewallBlacklist');
  }
}
