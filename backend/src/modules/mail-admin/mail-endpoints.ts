/**
 * Mail endpoints — the ONE answer to "which node addresses must answer on the
 * public mail ports right now?", derived from the mail config:
 *
 *   placement      primary / secondary / tertiary slots + where the Stalwart
 *                  pod actually runs (the ACTIVE node)
 *   port exposure  activeNodeOnly | assignedMailNodes | allServerNodes
 *
 * Every per-node / per-address mail check (forward DNS, AAAA, PTR, DNSBL, the
 * port-exposure check, the hourly DNSBL watch) runs against this set and
 * nothing else.
 *
 * WHY: the previous resolver (server-node-ips.ts) compared the stored mode
 * against the PRE-0034 name `thisNodeOnly`. Migration 0034 renamed that value
 * to `activeNodeOnly`, so the comparison never matched again and every mode
 * fell through to "every server-role node". A newly joined server that holds
 * no placement slot and publishes no mail port was therefore probed for an A
 * record, a PTR and DNSBL listings, and failed them — on a cluster whose mail
 * was perfectly healthy. `assignedMailNodes` was likewise widened to every
 * server node.
 *
 * ── Selection rules ─────────────────────────────────────────────────────────
 *
 * The set mirrors what the port-exposure orchestrator (port-exposure.ts)
 * actually publishes, using the SAME pure resolver it labels haproxy nodes
 * with, so the checks test exactly what the cluster exposes:
 *
 *   1. ACTIVE node (exposure `hostPort`) — always, in every mode. The Stalwart
 *      Deployment carries hostPort on all mail ports unconditionally (the
 *      post-hairpin-fix invariant in applyModeToClusterUnlocked), so the node
 *      running the pod publishes them directly.
 *   2. haproxy nodes (exposure `haproxy`) = resolveHaproxyNodes(mode, …):
 *        activeNodeOnly    → none
 *        assignedMailNodes → {primary, secondary, tertiary} minus active
 *        allServerNodes    → server-role nodes minus active
 *      and none at all on a single-node cluster.
 *
 *   Active-node resolution, first hit wins:
 *        live Running (non-terminating) Stalwart pod's node   → 'pod'
 *        system_settings.mail_active_node                     → 'settings'
 *        system_settings.mail_primary_node                    → 'primary'
 *        the only node of a single-node cluster               → 'sole_node'
 *   This is also the fallback for clusters with no placement configured: the
 *   node the Stalwart pod runs on is the endpoint, exactly as before.
 *
 * ── Standby nodes are NOT tested ────────────────────────────────────────────
 *
 * A placement slot that is not in the set above is reported under `untested`
 * with reason `standby`, never as a failure. Evidence that a standby does not
 * answer on the mail ports while it is not active:
 *   - Stalwart is a single-replica Deployment (stalwart/deployment.yaml
 *     `replicas: 1`) pinned to the active node (applyDeploymentAffinity).
 *   - Failover is COLD: dr-watcher → triggerRestoreBasedFailover MOVES the pod
 *     (empty PVC + restore). Until then a standby only runs the
 *     mail-stack-standby-replicate copy job (placement.ts deriveStandbyNodes /
 *     reconcileMailStandbyLabel) — no mail listener.
 *   - resolveDataPlaneNodes / resolveHaproxyNodes put no listener on it in
 *     activeNodeOnly mode, nor on a worker-role standby in allServerNodes mode.
 * In assignedMailNodes mode secondary/tertiary DO run haproxy, so there they
 * are endpoints and ARE tested.
 *
 * A node that is neither an endpoint nor a placement slot does not appear in
 * the result at all.
 *
 * ── Addresses ───────────────────────────────────────────────────────────────
 *
 * Both publishers bind every host address (hostPort via portmap; haproxy
 * `bind :::<port> v4v6`), so the address under test is the node's PUBLIC one
 * per family — at most one each:
 *   IPv4  first ExternalIP v4, else first InternalIP v4 (single-NIC VPS where
 *         the InternalIP IS the public address)
 *   IPv6  first ExternalIP v6 only — bootstrap publishes a GLOBAL v6 as
 *         ExternalIP; an InternalIP v6 is a ULA and never a valid AAAA target.
 */

import type {
  MailEndpointAddress,
  MailEndpointExposure,
  MailEndpointFamily,
  MailEndpointNode,
  MailEndpointSet,
  MailPlacementRole,
  MailPortExposureMode,
  MailUntestedNode,
} from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { mailPortExposureModeEnum } from '@insula/api-contracts';
import { resolveHaproxyNodes, type NodeRef } from './port-exposure-modes.js';

/** The public mail ports both publishers bind (Stalwart hostPort, haproxy DS). */
export const MAIL_PUBLIC_PORTS: ReadonlyArray<number> = [25, 465, 587, 143, 993, 995, 4190];

const MAIL_NAMESPACE = 'mail';
const STALWART_POD_SELECTOR = 'app=stalwart-mail';
const SETTINGS_ID = 'system';

// Derived from the shared contract, never hand-copied: a stale local copy of
// this enum (a rename that missed one comparison) is exactly what made every
// server node a "mail endpoint" in the first place.
const EXPOSURE_MODES: ReadonlyArray<MailPortExposureMode> = mailPortExposureModeEnum.options;

interface NodeAddressShape {
  readonly type?: string;
  readonly address?: string;
}

/** The slice of a Kubernetes Node this module reads. */
export interface EndpointNodeShape {
  readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string> };
  readonly status?: { readonly addresses?: ReadonlyArray<NodeAddressShape> };
}

export interface MailEndpointInput {
  /** Raw system_settings.mail_port_exposure_mode (normalised here). */
  readonly mode: string | null | undefined;
  readonly primaryNode: string | null;
  readonly secondaryNode: string | null;
  readonly tertiaryNode: string | null;
  /** system_settings.mail_active_node — may be stale; the live pod wins. */
  readonly settingsActiveNode: string | null;
  /** spec.nodeName of the Running, non-terminating Stalwart pod, if any. */
  readonly livePodNode: string | null;
  readonly nodes: ReadonlyArray<EndpointNodeShape>;
}

/**
 * Stored mode → current enum. `thisNodeOnly` is the pre-0034 name of
 * `activeNodeOnly`; anything unknown or absent is read as `activeNodeOnly`,
 * the column default and the only mode legal on every topology.
 */
export function normalizeExposureMode(raw: string | null | undefined): MailPortExposureMode {
  if (raw === 'thisNodeOnly') return 'activeNodeOnly';
  return EXPOSURE_MODES.find((m) => m === raw) ?? 'activeNodeOnly';
}

const isV6 = (address: string): boolean => address.includes(':');

/** Public address per family for one node (see "Addresses" in the header). */
export function nodePublicAddresses(node: EndpointNodeShape): MailEndpointAddress[] {
  const addrs = (node.status?.addresses ?? []).filter(
    (a): a is { type: string; address: string } => !!a.type && !!a.address,
  );
  const pick = (type: 'ExternalIP' | 'InternalIP', v6: boolean) =>
    addrs.find((a) => a.type === type && isV6(a.address) === v6);

  const out: MailEndpointAddress[] = [];
  const v4 = pick('ExternalIP', false) ?? pick('InternalIP', false);
  if (v4) {
    out.push({ address: v4.address, family: 'ipv4', source: v4.type as 'ExternalIP' | 'InternalIP' });
  }
  const v6 = pick('ExternalIP', true);
  if (v6) out.push({ address: v6.address, family: 'ipv6', source: 'ExternalIP' });
  return out;
}

type ActiveSource = NonNullable<MailEndpointSet['activeNodeSource']>;

function resolveActiveNode(
  input: MailEndpointInput,
  known: ReadonlySet<string>,
): { node: string | null; source: ActiveSource | null } {
  const ordered: ReadonlyArray<[string | null, ActiveSource]> = [
    [input.livePodNode, 'pod'],
    [input.settingsActiveNode, 'settings'],
    [input.primaryNode, 'primary'],
  ];
  for (const [node, source] of ordered) {
    if (node && known.has(node)) return { node, source };
  }
  if (known.size === 1) return { node: [...known][0], source: 'sole_node' };
  return { node: null, source: null };
}

function placementRoles(input: MailEndpointInput): Map<string, MailPlacementRole[]> {
  const slots: ReadonlyArray<[string | null, MailPlacementRole]> = [
    [input.primaryNode, 'primary'],
    [input.secondaryNode, 'secondary'],
    [input.tertiaryNode, 'tertiary'],
  ];
  const roles = new Map<string, MailPlacementRole[]>();
  for (const [node, role] of slots) {
    if (!node) continue;
    roles.set(node, [...(roles.get(node) ?? []), role]);
  }
  return roles;
}

function standbyDetail(mode: MailPortExposureMode, activeNode: string | null): string {
  const active = activeNode ?? '(none)';
  if (mode === 'activeNodeOnly') {
    return `Port exposure is activeNodeOnly, so only the active mail node (${active}) publishes the ` +
      'mail ports; this node is a cold failover target and does not answer on them until mail is ' +
      'failed over or migrated to it.';
  }
  if (mode === 'allServerNodes') {
    return 'Port exposure is allServerNodes, which publishes the mail ports on server-role nodes and the ' +
      `active node (${active}) only; this node is not server-role, so it does not answer on them until ` +
      'mail is failed over or migrated to it.';
  }
  return `This node does not publish the mail ports under ${mode} (active node: ${active}).`;
}

/**
 * Pure endpoint computation — see the file header for the rules.
 * Endpoint order: the active node first, then haproxy nodes alphabetically.
 */
export function computeMailEndpoints(input: MailEndpointInput): MailEndpointSet {
  const mode = normalizeExposureMode(input.mode);
  const byName = new Map<string, EndpointNodeShape>();
  for (const n of input.nodes) {
    const name = n.metadata?.name;
    if (name && !byName.has(name)) byName.set(name, n);
  }
  const known = new Set(byName.keys());
  const { node: activeNode, source } = resolveActiveNode(input, known);

  const nodeRefs: NodeRef[] = [...byName.entries()].map(([name, n]) => ({
    metadata: { name, labels: n.metadata?.labels ?? {} },
  }));
  const haproxyNodes = resolveHaproxyNodes(
    mode,
    {
      primaryNode: input.primaryNode,
      secondaryNode: input.secondaryNode,
      tertiaryNode: input.tertiaryNode,
      activeNode,
    },
    nodeRefs,
  );

  const roles = placementRoles(input);
  const endpointFor = (name: string, exposure: MailEndpointExposure): MailEndpointNode => ({
    node: name,
    roles: roles.get(name) ?? [],
    active: name === activeNode,
    exposure,
    addresses: nodePublicAddresses(byName.get(name) ?? {}),
  });

  const endpoints: MailEndpointNode[] = [
    ...(activeNode ? [endpointFor(activeNode, 'hostPort')] : []),
    ...haproxyNodes.filter((n) => n !== activeNode).map((n) => endpointFor(n, 'haproxy')),
  ];
  const endpointNames = new Set(endpoints.map((e) => e.node));

  const untested: MailUntestedNode[] = [...roles.entries()]
    .filter(([name]) => !endpointNames.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, nodeRoles]) => (known.has(name)
      ? { node: name, roles: nodeRoles, reason: 'standby' as const, detail: standbyDetail(mode, activeNode) }
      : {
          node: name,
          roles: nodeRoles,
          reason: 'not_in_cluster' as const,
          detail: `The ${nodeRoles.join('/')} placement slot names '${name}', but the cluster has no such ` +
            'node. Update the mail placement (Email Operations → Placement).',
        }));

  return {
    mode,
    activeNode,
    activeNodeSource: source,
    ports: [...MAIL_PUBLIC_PORTS],
    endpoints,
    untested,
  };
}

/** Every endpoint address of one family, deduplicated, in endpoint order. */
export function endpointAddresses(
  set: MailEndpointSet | null | undefined,
  family: MailEndpointFamily,
): string[] {
  const out: string[] = [];
  for (const e of set?.endpoints ?? []) {
    for (const a of e.addresses) {
      if (a.family === family && !out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

/** address → endpoint node name, for labelling per-address results. */
export function endpointAddressNodes(set: MailEndpointSet | null | undefined): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of set?.endpoints ?? []) {
    for (const a of e.addresses) {
      if (!(a.address in out)) out[a.address] = e.node;
    }
  }
  return out;
}

// ── Cluster + DB loader ─────────────────────────────────────────────────────

/** Minimal client surface — satisfied by K8sClients and by test doubles. */
export interface MailEndpointK8s {
  readonly core: {
    listNode: (q?: object) => Promise<unknown>;
    listNamespacedPod?: (q: { namespace: string; labelSelector?: string }) => Promise<unknown>;
  };
}

interface StalwartPodShape {
  readonly metadata?: { readonly deletionTimestamp?: unknown };
  readonly spec?: { readonly nodeName?: string };
  readonly status?: { readonly phase?: string };
}

/** Optional logger for non-fatal degradations (Fastify's `app.log` fits). */
export interface MailEndpointLog {
  warn(...args: unknown[]): void;
}

/**
 * Node of the Running, non-terminating Stalwart pod. Best-effort: a failed
 * pod list falls back to the stored settings (same rule as the placement
 * self-heal in placement.ts), with a warning so a persistent RBAC/API fault
 * does not degrade the active-node source silently.
 */
async function readLivePodNode(k8s: MailEndpointK8s, log?: MailEndpointLog): Promise<string | null> {
  if (!k8s.core.listNamespacedPod) return null;
  try {
    const pods = await k8s.core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
      labelSelector: STALWART_POD_SELECTOR,
    }) as { items?: StalwartPodShape[] };
    const running = (pods.items ?? []).find(
      (p) => p.status?.phase === 'Running' && !p.metadata?.deletionTimestamp,
    );
    return running?.spec?.nodeName ?? null;
  } catch (err) {
    log?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'mail-endpoints: live Stalwart pod lookup failed; active node falls back to stored settings',
    );
    return null;
  }
}

/**
 * Load placement + mode + nodes + live pod and compute the endpoint set.
 *
 * Throws when the node list or the settings row cannot be read — callers must
 * keep "could not determine the endpoints" distinguishable from "there are
 * none" (see blocklist-scheduler / scheduler-silent-skip.test.ts).
 */
export async function resolveMailEndpoints(
  k8s: MailEndpointK8s,
  db: Database,
  log?: MailEndpointLog,
): Promise<MailEndpointSet> {
  // Dynamic imports keep this module loadable by tests that mock the DB layer
  // (same pattern as the resolver this replaces).
  const { systemSettings } = await import('../../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [[row], nodeList, livePodNode] = await Promise.all([
    db
      .select({
        mode: systemSettings.mailPortExposureMode,
        primaryNode: systemSettings.mailPrimaryNode,
        secondaryNode: systemSettings.mailSecondaryNode,
        tertiaryNode: systemSettings.mailTertiaryNode,
        activeNode: systemSettings.mailActiveNode,
      })
      .from(systemSettings)
      .where(eq(systemSettings.id, SETTINGS_ID)),
    k8s.core.listNode({}) as Promise<{ items?: EndpointNodeShape[] }>,
    readLivePodNode(k8s, log),
  ]);
  return computeMailEndpoints({
    mode: row?.mode ?? null,
    primaryNode: row?.primaryNode ?? null,
    secondaryNode: row?.secondaryNode ?? null,
    tertiaryNode: row?.tertiaryNode ?? null,
    settingsActiveNode: row?.activeNode ?? null,
    livePodNode,
    nodes: nodeList.items ?? [],
  });
}
