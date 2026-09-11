/**
 * Tenant health — pure computation.
 *
 * All cluster I/O lives in `collect.ts`; this file turns already-fetched
 * facts into per-tenant findings. Keeping it pure means the degradation
 * matrix can be unit-tested exhaustively without a cluster, which matters
 * because the interesting cases (a node dead, a volume's last replica
 * stranded) are expensive and destructive to reproduce live.
 *
 * See docs/architecture/NODE_OUTAGE_RESILIENCE.md §2 for the model this
 * implements and the drill that produced it.
 */
import type {
  ClusterOutageImpact,
  NodeDown,
  TenantHealthEntry,
  TenantHealthFinding,
  TenantHealthState,
} from '@insula/api-contracts';

export interface NodeFact {
  readonly name: string;
  readonly ready: boolean;
  readonly role: string | null;
  /** Ready condition's lastTransitionTime — when it went NotReady. */
  readonly notReadySince: string | null;
}

export interface PodFact {
  readonly namespace: string;
  readonly name: string;
  readonly nodeName: string | null;
  readonly ready: boolean;
  readonly phase: string;
}

/** One Longhorn replica: which volume it belongs to and where it lives. */
export interface ReplicaFact {
  readonly volumeName: string;
  readonly nodeId: string | null;
}

export interface VolumeFact {
  readonly volumeName: string;
  /** PVC namespace, resolved from the bound PV's claimRef. */
  readonly namespace: string | null;
  readonly pvcName: string | null;
  /** Longhorn `status.robustness`: healthy | degraded | faulted | unknown. */
  readonly robustness: string | null;
}

export interface TenantFact {
  readonly id: string;
  readonly name: string;
  readonly namespace: string;
  readonly storageTier: 'local' | 'ha';
  /** `tenants.node_name` — the pin. Null for HA tier. */
  readonly pinnedNode: string | null;
  /** Lifecycle status; suspended/archived tenants are not "unhealthy". */
  readonly status: string;
  /** Whether this tenant has any mailboxes, i.e. whether mail loss affects it. */
  readonly hasMailboxes: boolean;
}

export interface OutageInput {
  readonly nodes: ReadonlyArray<NodeFact>;
  readonly pods: ReadonlyArray<PodFact>;
  readonly replicas: ReadonlyArray<ReplicaFact>;
  readonly volumes: ReadonlyArray<VolumeFact>;
  readonly tenants: ReadonlyArray<TenantFact>;
  /** Where the mail stack currently runs, per system_settings. */
  readonly mailActiveNode: string | null;
  readonly observedAt: Date;
  /** Non-null when a cluster read failed — forces `unknown` rather than green. */
  readonly readError?: string | null;
}

/**
 * Lifecycle states where "unhealthy" is meaningless — the tenant is
 * intentionally not running, so absent pods are correct, not a fault.
 */
const NON_SERVING_STATUSES: ReadonlySet<string> = new Set([
  'suspended', 'archived', 'deleted', 'deleting', 'pending',
]);

/** Highest severity wins: down > degraded > info. */
function worstState(findings: ReadonlyArray<TenantHealthFinding>): TenantHealthState {
  if (findings.some((f) => f.severity === 'down')) return 'down';
  if (findings.some((f) => f.severity === 'degraded')) return 'degraded';
  return 'healthy';
}

/**
 * Per-tenant findings for one tenant.
 *
 * Exported for focused unit tests of the degradation matrix.
 */
export function findingsForTenant(
  tenant: TenantFact,
  input: OutageInput,
  downNodeNames: ReadonlySet<string>,
  mailDown: boolean,
): TenantHealthFinding[] {
  const findings: TenantHealthFinding[] = [];

  // ── Hosting: workloads pinned to a dead node ────────────────────
  // A `local`-tier tenant MUST be pinned (the single Longhorn replica only
  // exists on that node), so this is the normal, expected shape — and it is
  // exactly why losing that node takes the tenant fully down rather than
  // rescheduling it.
  if (tenant.pinnedNode && downNodeNames.has(tenant.pinnedNode)) {
    findings.push({
      kind: 'workloads_pinned_to_down_node',
      severity: 'down',
      detail: `Tenant is pinned to ${tenant.pinnedNode}, which is offline. `
        + 'Its workloads cannot be scheduled anywhere else until the pin moves or the node returns.',
      nodes: [tenant.pinnedNode],
      resources: [],
    });
  }

  // ── Storage: volumes whose only replica is on a dead node ───────
  const nsVolumes = input.volumes.filter((v) => v.namespace === tenant.namespace);
  const byVolume = new Map<string, string[]>();
  for (const r of input.replicas) {
    const list = byVolume.get(r.volumeName) ?? [];
    if (r.nodeId) list.push(r.nodeId);
    byVolume.set(r.volumeName, list);
  }

  const stranded: string[] = [];
  const strandedNodes = new Set<string>();
  const rebuilding: string[] = [];
  for (const v of nsVolumes) {
    const replicaNodes = byVolume.get(v.volumeName) ?? [];
    const live = replicaNodes.filter((n) => !downNodeNames.has(n));
    const dead = replicaNodes.filter((n) => downNodeNames.has(n));
    if (replicaNodes.length > 0 && live.length === 0) {
      // Every replica is on a downed node: the data is unreachable until a
      // node returns or the tenant is restored from a bundle.
      stranded.push(v.pvcName ?? v.volumeName);
      dead.forEach((n) => strandedNodes.add(n));
    } else if (dead.length > 0 || v.robustness === 'degraded') {
      // Surviving copy exists — Longhorn rebuilds. Serving, no data risk.
      rebuilding.push(v.pvcName ?? v.volumeName);
    }
  }

  if (stranded.length > 0) {
    findings.push({
      kind: 'volume_last_replica_on_down_node',
      severity: 'down',
      detail: `${stranded.length} volume(s) have no replica on a live node. `
        + 'The data is unreachable until the node returns; recovering sooner means restoring the tenant from its latest backup bundle.',
      nodes: [...strandedNodes].sort(),
      resources: stranded.sort(),
    });
  }
  if (rebuilding.length > 0) {
    findings.push({
      kind: 'volume_degraded_rebuilding',
      severity: 'degraded',
      detail: `${rebuilding.length} volume(s) are running on reduced redundancy while Longhorn rebuilds. `
        + 'No action required — this resolves itself.',
      nodes: [],
      resources: rebuilding.sort(),
    });
  }

  // ── Workloads that exist but are not Ready ──────────────────────
  // Only counted when the tenant is supposed to be serving; a suspended
  // tenant with no running pods is correct, not degraded.
  if (!NON_SERVING_STATUSES.has(tenant.status)) {
    const nsPods = input.pods.filter((p) => p.namespace === tenant.namespace);
    const broken = nsPods.filter(
      (p) => !p.ready && p.phase !== 'Succeeded',
    );
    // Suppress when already explained by the pin finding — otherwise every
    // pinned-to-dead-node tenant reports the same problem twice.
    const alreadyExplained = findings.some(
      (f) => f.kind === 'workloads_pinned_to_down_node',
    );
    if (broken.length > 0 && !alreadyExplained) {
      findings.push({
        kind: 'workloads_not_ready',
        severity: nsPods.length > 0 && broken.length === nsPods.length ? 'down' : 'degraded',
        detail: `${broken.length} of ${nsPods.length} pod(s) are not Ready.`,
        nodes: [...new Set(broken.map((p) => p.nodeName).filter((n): n is string => !!n))].sort(),
        resources: broken.map((p) => `${p.namespace}/${p.name}`).sort().slice(0, 20),
      });
    }
  }

  // ── Mail: one Stalwart serves everyone ──────────────────────────
  // Independent of tier and pin. A tenant can be fine on hosting and still
  // have no mail, or vice versa — reporting them separately is the point.
  if (mailDown && tenant.hasMailboxes) {
    findings.push({
      kind: 'mail_unavailable',
      severity: 'down',
      detail: 'The mail server\'s active node is offline, so this tenant\'s mailboxes are unreachable. '
        + 'Mail failover moves the stack to another node.',
      nodes: input.mailActiveNode ? [input.mailActiveNode] : [],
      resources: [],
    });
  }

  return findings;
}

/**
 * Fleet-wide impact. One pass over already-collected cluster facts.
 *
 * Healthy tenants are omitted from `affectedTenants` — the banner and the
 * modal only ever want the affected ones, and a 100-tenant fleet should not
 * ship 100 green rows to render a pill.
 */
export function computeOutageImpact(input: OutageInput): ClusterOutageImpact {
  const downNodes = input.nodes.filter((n) => !n.ready);
  const downNodeNames = new Set(downNodes.map((n) => n.name));
  const mailDown = !!input.mailActiveNode && downNodeNames.has(input.mailActiveNode);

  const nodesDown: NodeDown[] = downNodes.map((n) => ({
    name: n.name,
    role: n.role,
    notReadySince: n.notReadySince,
    isMailActiveNode: n.name === input.mailActiveNode,
  })).sort((a, b) => a.name.localeCompare(b.name));

  const affected: TenantHealthEntry[] = [];
  for (const tenant of input.tenants) {
    // A failed cluster read must not render as healthy. An empty finding
    // list is indistinguishable from a healthy tenant, so say `unknown`.
    if (input.readError) {
      affected.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        namespace: tenant.namespace,
        storageTier: tenant.storageTier,
        pinnedNode: tenant.pinnedNode,
        state: 'unknown',
        hostingAffected: false,
        mailAffected: false,
        findings: [],
      });
      continue;
    }

    const findings = findingsForTenant(tenant, input, downNodeNames, mailDown);
    if (findings.length === 0) continue;

    const mailAffected = findings.some((f) => f.kind === 'mail_unavailable');
    const hostingAffected = findings.some((f) => f.kind !== 'mail_unavailable');
    affected.push({
      tenantId: tenant.id,
      tenantName: tenant.name,
      namespace: tenant.namespace,
      storageTier: tenant.storageTier,
      pinnedNode: tenant.pinnedNode,
      state: worstState(findings),
      hostingAffected,
      mailAffected,
      findings,
    });
  }

  affected.sort((a, b) => {
    const rank = (s: TenantHealthState) => (s === 'down' ? 0 : s === 'degraded' ? 1 : 2);
    const d = rank(a.state) - rank(b.state);
    return d !== 0 ? d : a.tenantName.localeCompare(b.tenantName);
  });

  return {
    nodesDown,
    affectedTenants: affected,
    affectedTenantCount: affected.length,
    downTenantCount: affected.filter((t) => t.state === 'down').length,
    degradedTenantCount: affected.filter((t) => t.state === 'degraded').length,
    mailAffected: mailDown,
    observedAt: input.observedAt.toISOString(),
    readError: input.readError ?? null,
  };
}
