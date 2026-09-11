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
  /** ISO timestamp of the cluster read. */
  observedAt: z.string(),
  /**
   * Set when the cluster could not be fully read. The UI must show this
   * rather than rendering an empty (and therefore reassuring) result — an
   * empty list is a claim, and a failed read must not make it.
   */
  readError: z.string().nullable(),
});
export type ClusterOutageImpact = z.infer<typeof clusterOutageImpactSchema>;
