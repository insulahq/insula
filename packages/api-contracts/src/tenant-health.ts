/**
 * Tenant health — how a node outage is actually affecting each tenant.
 *
 * Added after the 2026-09-11 node-outage drill. The platform could already
 * recover from a node loss, but could not answer the operator's first two
 * questions: *who is affected* and *what do I do about it*. `buildDrainImpact`
 * computed most of the blast radius but was reachable only from the
 * planned-drain modal, and the tenant list had no notion of health at all —
 * `tenants.status` is a lifecycle field (pending / active / suspended), not an
 * availability one.
 *
 * The model separates two independent axes, because collapsing them hides
 * which half the operator can fix:
 *
 *   - **Hosting** — the tenant's own workloads and volumes. A `local`-tier
 *     tenant is pinned to one node and its Longhorn volume has a single
 *     replica there, so losing that node takes the tenant fully down. An
 *     `ha`-tier tenant has two replicas and no pin, so it reschedules.
 *   - **Mail** — one Stalwart instance serves every tenant. When its node
 *     dies, every tenant with mailboxes loses mail at once, regardless of
 *     tier or pin.
 *
 * A tenant pinned to the dead node that was ALSO the mail node is the
 * "fully degraded" case; either axis alone is "partially degraded".
 */
import { z } from 'zod';

/**
 * Why a tenant is not healthy. Each kind maps to exactly one recovery
 * action in the UI — if you add a kind, add its action too.
 */
export const tenantHealthFindingKindSchema = z.enum([
  /** Workloads are pinned (`tenants.node_name`) to a node that is NotReady. */
  'workloads_pinned_to_down_node',
  /** A Longhorn volume's only replica lives on a node that is NotReady. */
  'volume_last_replica_on_down_node',
  /** Volume is rebuilding onto a surviving node — self-healing, informational. */
  'volume_degraded_rebuilding',
  /** Pods exist but are not Ready (unschedulable, crash-looping, evicted). */
  'workloads_not_ready',
  /** The mail active node is down, so this tenant's mailboxes are unreachable. */
  'mail_unavailable',
]);
export type TenantHealthFindingKind = z.infer<typeof tenantHealthFindingKindSchema>;

/**
 * Severity of a single finding.
 *
 *   down     — this component is not serving at all.
 *   degraded — serving, but with reduced redundancy or partial capacity.
 *   info     — no action required; recorded so the operator sees the whole
 *              picture rather than wondering what is missing.
 */
export const tenantHealthSeveritySchema = z.enum(['down', 'degraded', 'info']);
export type TenantHealthSeverity = z.infer<typeof tenantHealthSeveritySchema>;

export const tenantHealthFindingSchema = z.object({
  kind: tenantHealthFindingKindSchema,
  severity: tenantHealthSeveritySchema,
  /** Operator-facing sentence describing what is wrong, with real names in it. */
  detail: z.string(),
  /** The nodes implicated, so the operator can correlate with the outage banner. */
  nodes: z.array(z.string()),
  /** Affected object names (PVC, workload, …) — may be empty for tenant-wide findings. */
  resources: z.array(z.string()),
});
export type TenantHealthFinding = z.infer<typeof tenantHealthFindingSchema>;

/**
 * Overall tenant state.
 *
 *   healthy  — nothing wrong.
 *   degraded — something is impaired but the tenant is still partly serving.
 *   down     — the tenant's hosting is not serving at all.
 *
 * `unknown` is deliberate and distinct from `healthy`: when the cluster read
 * fails we must not render a green badge, because an empty finding list is
 * indistinguishable from a healthy tenant otherwise.
 */
export const tenantHealthStateSchema = z.enum(['healthy', 'degraded', 'down', 'unknown']);
export type TenantHealthState = z.infer<typeof tenantHealthStateSchema>;

export const tenantHealthEntrySchema = z.object({
  tenantId: z.string(),
  tenantName: z.string(),
  namespace: z.string(),
  /** 'local' tenants are node-pinned and single-replica; 'ha' are neither. */
  storageTier: z.enum(['local', 'ha']),
  /** `tenants.node_name` — null for HA-tier tenants, which are unpinned. */
  pinnedNode: z.string().nullable(),
  state: tenantHealthStateSchema,
  /** True when BOTH hosting and mail are impaired — the "fully degraded" case. */
  hostingAffected: z.boolean(),
  mailAffected: z.boolean(),
  findings: z.array(tenantHealthFindingSchema),
});
export type TenantHealthEntry = z.infer<typeof tenantHealthEntrySchema>;

export const nodeDownSchema = z.object({
  name: z.string(),
  /** `insula.host/node-role` — 'server' or 'worker'. */
  role: z.string().nullable(),
  /** Ready condition's lastTransitionTime, i.e. roughly when it went down. */
  notReadySince: z.string().nullable(),
  /** True when this node is where the mail stack currently runs. */
  isMailActiveNode: z.boolean(),
  /**
   * `insula.host/ingress-mode` — 'all' | 'local' | 'none'. A down node with a
   * mode other than 'none' is still an advertised ingress endpoint.
   */
  ingressMode: z.string().nullable(),
  /**
   * The node's public addresses, one per family. These are what the platform
   * published as A/AAAA records for every route it serves, and they keep
   * resolving after the node dies.
   *
   * The platform deliberately does NOT own DNS (operator decision, 2026-09-11):
   * dead records are accepted and withdrawing them is a manual action. That
   * makes it all the more important to SAY so during an outage — the drill
   * found this stated only as a tooltip on one page the operator had no reason
   * to open.
   */
  ingressAddresses: z.array(z.string()),
});
export type NodeDown = z.infer<typeof nodeDownSchema>;

/**
 * Fleet-wide answer to "is there an outage, and who is affected".
 *
 * One cluster read serves both the global outage banner and the tenant list,
 * so tenant count does not multiply API calls.
 */
export const clusterOutageImpactSchema = z.object({
  /** Empty when every node is Ready — the banner hides on an empty array. */
  nodesDown: z.array(nodeDownSchema),
  /** Only tenants with at least one finding. Healthy tenants are omitted. */
  affectedTenants: z.array(tenantHealthEntrySchema),
  /** Counts for the banner pill, so it needn't load the whole list. */
  affectedTenantCount: z.number().int(),
  downTenantCount: z.number().int(),
  degradedTenantCount: z.number().int(),
  /** True when the mail stack's active node is among nodesDown. */
  mailAffected: z.boolean(),
  /**
   * Platform services that currently have ZERO ready endpoints.
   *
   * "0 tenants affected" is true and reassuring and can be badly incomplete.
   * The 2026-09-11 worker drill produced exactly that: no tenant workloads ran
   * on the lost node, so the banner reported no impact — while the backup
   * plugin's Service had no ready endpoint at all and backups were silently
   * unavailable.
   *
   * Kubernetes marks an endpoint on a NotReady node not-ready even when the
   * process behind it is perfectly healthy, so a leader-elected singleton whose
   * node loses only its kubelet becomes unroutable while its standby cannot
   * take over — the lease is still being renewed by the live leader. Nothing
   * resolves that on its own, so it has to be said out loud.
   */
  degradedServices: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    /** Operator-facing name, e.g. "Backups" rather than "barman-cloud". */
    label: z.string(),
  })),
  /** ISO timestamp of the cluster read. */
  observedAt: z.string(),
  /**
   * Set when the cluster could not be fully read. The UI must show this
   * rather than rendering an empty (and therefore reassuring) result — an
   * empty list is a claim, and a failed read must not make it.
   */
  readError: z.string().nullable(),
  /**
   * When `nodesDown` came from the platform's own inventory rather than a live
   * cluster read, this is the oldest `last_seen_at` behind it. Null means the
   * node list is live.
   *
   * The 2026-09-12 quorum-loss drill left the platform able to say *something
   * is wrong* but not *which machine* — the node list is itself read from the
   * API server, so losing the control plane lost the names too. The database
   * survives that (its primary sat on the surviving node and served
   * throughout), and the node-sync reconciler already persists node conditions
   * to `cluster_nodes` every 60 s. So the names are recoverable; they are just
   * a minute or two stale, and must be labelled as such rather than presented
   * as current.
   */
  nodesAsOf: z.string().nullable(),
});
export type ClusterOutageImpact = z.infer<typeof clusterOutageImpactSchema>;

/**
 * Recovery actions the wizard can execute directly.
 *
 * Deliberately small. `repin` is the one recovery that is safe to automate
 * from a modal: it is reversible, moves no data, and is exactly what the
 * drain flow already does. Restoring from a backup bundle is destructive and
 * has its own established flow — the wizard links to it rather than
 * re-implementing it behind a different button.
 */
export const tenantRecoveryActionSchema = z.enum(['repin']);
export type TenantRecoveryAction = z.infer<typeof tenantRecoveryActionSchema>;

export const tenantRepinRequestSchema = z.object({
  /** A node name, or '' to clear the pin and let the scheduler choose. */
  targetNode: z.string().max(253),
  /** Typed tenant name — the same confirmation shape as node recovery. */
  confirm: z.literal(true),
  reason: z.string().min(3).max(500),
});
export type TenantRepinRequest = z.infer<typeof tenantRepinRequestSchema>;

export const tenantRepinResponseSchema = z.object({
  tenantId: z.string(),
  targetNode: z.string().nullable(),
  workloadsPatched: z.number().int(),
  volumesPatched: z.number().int(),
});
export type TenantRepinResponse = z.infer<typeof tenantRepinResponseSchema>;

/**
 * Failback review — what is still displaced after a node comes back.
 *
 * The 2026-09-11 drill covered the outage well and the RETURN not at all.
 * When a node goes NotReady the platform moves tenants off it: `ha`-tier
 * tenants are unpinned automatically, `local`-tier ones are re-pinned by the
 * operator through the recovery wizard. When that node later rejoins, nothing
 * moved back and nothing said so — the placement change simply became the new
 * normal, silently, and the returned node looked healthy while sitting empty.
 *
 * That silence is a problem in both directions. An operator who pinned a
 * tenant deliberately (node class, data locality, a licence tied to a host)
 * has had that intent erased without being told. An operator who did not care
 * about the pin needs to know the tenant is now floating so they stop
 * expecting it on the old host.
 *
 * So this is a REVIEW, not an automatic failback. Moving a tenant's storage
 * back is a data movement with real cost and no urgency, and for an `ha`-tier
 * tenant the unpinned state is usually the better one. The platform states
 * what changed, recommends the action it believes is right, and leaves the
 * decision with the operator — the same stance as mail failover, which is
 * never auto-enabled.
 */
export const failbackRecommendationSchema = z.enum([
  /**
   * Leave it. The tenant is `ha`-tier and now unpinned, which is a strictly
   * better placement than the pin it lost — more replicas eligible, no single
   * node to lose again.
   */
  'keep_current_placement',
  /**
   * Consider re-pinning. The tenant is `local`-tier and was pinned before the
   * outage, so the pin was load-bearing; the operator may want it back on the
   * returned node.
   */
  'consider_repin',
]);
export type FailbackRecommendation = z.infer<typeof failbackRecommendationSchema>;

export const failbackReviewItemSchema = z.object({
  tenantId: z.string(),
  tenantName: z.string(),
  /** The node the tenant was moved OFF during the outage. Now Ready again. */
  movedFromNode: z.string(),
  /** Where it is pinned now; null means unpinned (scheduler places it freely). */
  currentNode: z.string().nullable(),
  storageTier: z.string(),
  /** `auto` = the platform unpinned it; `operator` = someone drove the wizard. */
  movedBy: z.enum(['auto', 'operator']),
  movedAt: z.string(),
  recommendation: failbackRecommendationSchema,
  /** One operator-facing sentence explaining the recommendation. */
  detail: z.string(),
});
export type FailbackReviewItem = z.infer<typeof failbackReviewItemSchema>;

export const failbackReviewSchema = z.object({
  /** Nodes that were down, are Ready again, and still have displaced tenants. */
  returnedNodes: z.array(z.string()),
  items: z.array(failbackReviewItemSchema),
  observedAt: z.string(),
  /**
   * Non-null when a read failed. As with the outage impact, an empty `items`
   * list with a `readError` means "unknown", never "nothing to review".
   */
  readError: z.string().nullable(),
});
export type FailbackReview = z.infer<typeof failbackReviewSchema>;

/** Dismissing a review item records the decision; it never moves data. */
export const failbackAcknowledgeRequestSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type FailbackAcknowledgeRequest = z.infer<typeof failbackAcknowledgeRequestSchema>;
