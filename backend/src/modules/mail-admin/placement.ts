/**
 * Mail placement policy — primary/secondary/tertiary node assignment + DR state.
 *
 * Stores the operator's preferred node assignments in system_settings and
 * provides a candidate-node listing from the cluster.
 *
 * **Node-role policy:** any node with role `server` OR `worker` is a valid
 * candidate. Stalwart can run on either:
 *   - server-role nodes: typically the case (haproxy DS also runs here for
 *     allServerNodes mode, so all mail traffic stays on the same set of
 *     publicly-reachable hosts).
 *   - worker-role nodes: also supported. Stalwart pod lands on the worker;
 *     in thisNodeOnly mode the worker's hostPorts serve mail directly;
 *     in allServerNodes mode haproxy on the 3 server nodes forwards via
 *     ClusterIP+PROXY-v2 to the Stalwart pod on the worker. The PROXY-v2
 *     trust list (SystemSettings.proxyTrustedNetworks) is maintained by
 *     the proxy-networks reconciler from server-role node IPs — so the
 *     same trust set works regardless of where Stalwart lives.
 *
 * The DR state machine (failing-over / failed-over / failing-back) is
 * advanced by Phase 5's failover scheduler; this module is read/write only
 * for the placement policy itself.
 *
 * GET  /admin/mail/placement  → MailPlacementResponse
 * PATCH /admin/mail/placement → 204
 */

import { eq, sql } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { mailMigrationInFlight, resolveActiveMailNode } from './active-node.js';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  type MailPlacementResponse,
  type NodeCandidate,
  mailPlacementResponseSchema,
} from '@insula/api-contracts';

const SETTINGS_ID = 'system';
const MAIL_NAMESPACE = 'mail';
const NODE_ROLE_LABEL_KEY = 'insula.host/node-role';
const ELIGIBLE_NODE_ROLES = new Set(['server', 'worker']);

export interface PlacementOptions {
  readonly kubeconfigPath: string | undefined;
  /**
   * Optional logger surface for non-fatal warnings (e.g. self-heal
   * pod-query falling back to stored value). Fastify provides one;
   * tests can omit it.
   */
  readonly logger?: { warn?: (...args: unknown[]) => void };
}

interface K8sCoreBundle {
  core: import('@kubernetes/client-node').CoreV1Api;
}

async function loadK8sCoreTenant(kubeconfigPath: string | undefined): Promise<K8sCoreBundle> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return { core: kc.makeApiClient(k8s.CoreV1Api) };
}

// Parse K8s memory quantity strings like "16296Mi", "2Gi", "1024Ki" to bytes.
function parseMemQuantity(q: string): number {
  const m = q.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? '';
  const multiplier: Record<string, number> = {
    Ki: 1024,
    Mi: 1048576,
    Gi: 1073741824,
    Ti: 1099511627776,
    K: 1000,
    M: 1000000,
    G: 1000000000,
    T: 1000000000000,
  };
  return Math.round(n * (multiplier[unit] ?? 1));
}

/** Minimal node shape for role/Ready inspection. */
type NodeRoleReadyShape = {
  metadata?: { labels?: Record<string, string> };
  status?: { conditions?: Array<{ type: string; status: string }> };
};

function isNodeReady(n: NodeRoleReadyShape): boolean {
  return n.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True';
}

function nodeRole(n: NodeRoleReadyShape): string {
  return n.metadata?.labels?.[NODE_ROLE_LABEL_KEY] ?? '';
}

/**
 * Count Ready candidate nodes (the same eligible set getMailPlacement
 * exposes: Ready + role in ELIGIBLE_NODE_ROLES). Used by the
 * secondary/tertiary placement gate. Best-effort: a failed listNode
 * returns 0 so the gate fails closed (an operator setting a standby on
 * an unreachable cluster is refused rather than silently allowed).
 */
async function countReadyCandidateNodes(
  core: import('@kubernetes/client-node').CoreV1Api,
): Promise<number> {
  try {
    const list = await core.listNode({}) as { items?: NodeRoleReadyShape[] };
    return (list.items ?? []).filter(
      (n) => isNodeReady(n) && ELIGIBLE_NODE_ROLES.has(nodeRole(n)),
    ).length;
  } catch {
    return 0;
  }
}

/**
 * List the names of Ready, server-role nodes. Used by the primary
 * self-heal on a fresh cluster: when exactly one Ready server exists and
 * no primary/active is recorded yet, that sole server is elected primary.
 * Best-effort — a failed listNode returns [].
 */
async function listReadyServerNodeNames(
  core: import('@kubernetes/client-node').CoreV1Api,
): Promise<string[]> {
  try {
    const list = await core.listNode({}) as {
      items?: Array<NodeRoleReadyShape & { metadata?: { name?: string } }>;
    };
    return (list.items ?? [])
      .filter((n) => isNodeReady(n) && nodeRole(n) === 'server')
      .map((n) =>
        n.metadata?.labels?.['kubernetes.io/hostname'] ?? n.metadata?.name ?? '',
      )
      .filter((name): name is string => !!name);
  } catch {
    return [];
  }
}

/**
 * Read the current placement policy from system_settings and list
 * candidate server-role nodes from the cluster.
 */
export async function getMailPlacement(
  db: Database,
  opts: PlacementOptions,
): Promise<MailPlacementResponse> {
  const { core } = await loadK8sCoreTenant(opts.kubeconfigPath);

  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));

  // Gather candidate nodes — fetch all and filter to server-role in code
  // (listNode labelSelector is not stable across SDK versions).
  type NodeShape = {
    metadata?: { labels?: Record<string, string>; name?: string };
    status?: {
      conditions?: Array<{ type: string; status: string }>;
      allocatable?: Record<string, string>;
      capacity?: Record<string, string>;
    };
  };
  // Self-heal activeNode from the live Stalwart pod: the column is only written
  // by migrations, so a pod rescheduled without one (drain, delete, image
  // update) left it stale. resolveActiveMailNode is the ONE resolver (pod →
  // PVC → stored) and records the pod's node only when it is Ready and no
  // migration is in flight. This endpoint used to write any Running pod's node
  // itself — and the mail health check calls it every tick, so that write ran
  // mid-migration: recording a target before the migration succeeds leaves the
  // DR watcher on the wrong node after a rollback (a VM drill's failback found
  // the column back on the node mail had just left).
  const { node: effectiveActiveNode } = await resolveActiveMailNode(db, core, {
    persist: true,
    stored: (row?.mailActiveNode ?? null) as string | null,
    logger: { warn: (msg: string) => opts.logger?.warn?.(msg) },
  });

  let candidates: NodeCandidate[] = [];
  try {
    const nodeList = await core.listNode({}) as { items?: NodeShape[] };
    candidates = (nodeList.items ?? [])
      .map((n) => {
        const role = n.metadata?.labels?.[NODE_ROLE_LABEL_KEY] ?? '';
        if (!ELIGIBLE_NODE_ROLES.has(role)) return null;
        const hostname =
          n.metadata?.labels?.['kubernetes.io/hostname'] ??
          n.metadata?.name ??
          '';
        if (!hostname) return null;
        const readyCondition = n.status?.conditions?.find((c) => c.type === 'Ready');
        const ready = readyCondition?.status === 'True';
        const memStr = n.status?.allocatable?.['memory'] ?? '0';
        const freeMemoryBytes = parseMemQuantity(memStr);
        // Use ephemeral-storage as the disk-capacity proxy. The kubelet
        // reports allocatable.ephemeral-storage = total minus reserved-
        // for-system pods — which is the headroom available to schedule
        // new workloads (incl. a relocated Stalwart). It's a static
        // capacity-level number (not "live free bytes used right now")
        // but matches operator intent for "can this node host
        // Stalwart?" better than the previous hardcoded 0. Falls back
        // to capacity.ephemeral-storage if allocatable isn't set.
        const diskStr =
          n.status?.allocatable?.['ephemeral-storage']
          ?? n.status?.capacity?.['ephemeral-storage']
          ?? '0';
        const freeDiskBytes = parseMemQuantity(diskStr);
        return { hostname, freeMemoryBytes, freeDiskBytes, role, ready };
      })
      .filter((c): c is NodeCandidate => c !== null);
  } catch {
    // Best-effort — a missing or unreachable k8s API just returns
    // an empty candidate list. The operator still sees the stored policy.
  }

  // Compute drift (primary ≠ active): when both populated AND
  // different, the operator has staged a primary change but the
  // Stalwart pod still runs on the old node. Frontend renders a
  // yellow banner with a "Migrate now" CTA.
  const primaryNode = (row?.mailPrimaryNode ?? null) as string | null;
  const drift = (primaryNode && effectiveActiveNode && primaryNode !== effectiveActiveNode)
    ? { primaryNode, activeNode: effectiveActiveNode }
    : null;

  // Surface the most-recent failed migration whose targetNode equals
  // the currently-declared primary. This catches the "Move now"
  // failure case: operator clicked migrate, migration crashed midway,
  // mail_primary_node = new is preserved, but the UI should let them
  // retry without re-typing intent.
  let lastFailedMigration: { targetNode: string; errorMessage: string; failedAt: string } | null = null;
  if (primaryNode) {
    try {
      const failedRows = await db.execute(sql`
        SELECT details, error_message, finished_at
          FROM tasks
         WHERE kind = 'mail.migration'
           AND status = 'failed'
           AND (details->>'targetNode') = ${primaryNode}
         ORDER BY finished_at DESC
         LIMIT 1
      `) as { rows?: Array<{
        details?: { targetNode?: string };
        error_message?: string;
        finished_at?: Date | string;
      }> };
      const r = failedRows.rows?.[0];
      if (r?.details?.targetNode && r.error_message) {
        lastFailedMigration = {
          targetNode: r.details.targetNode,
          errorMessage: r.error_message,
          failedAt: r.finished_at instanceof Date
            ? r.finished_at.toISOString()
            : (r.finished_at ?? new Date().toISOString()),
        };
      }
    } catch (err) {
      // Non-fatal — drift banner alone is still useful.
      opts.logger?.warn?.(
        { err: (err as Error).message ?? String(err) },
        'placement: lastFailedMigration query failed; banner suppressed',
      );
    }
  }

  // Node-count gates (surfaced to the UI; authoritatively re-checked in
  // updateMailPlacement + validateModeSwitchAgainstDb):
  //   readyNodeCount       — Ready candidate nodes of ANY eligible role
  //                          (server OR worker). Drives secondary (>=2) +
  //                          tertiary (>=3) placement gating.
  //   readyServerNodeCount — Ready candidate nodes with role === 'server'
  //                          ONLY. Drives the HA-proxy mode gating (>=2).
  const readyNodeCount = candidates.filter((c) => c.ready).length;
  const readyServerNodeCount = candidates.filter(
    (c) => c.ready && c.role === 'server',
  ).length;

  return mailPlacementResponseSchema.parse({
    primaryNode,
    secondaryNode: row?.mailSecondaryNode ?? null,
    tertiaryNode: row?.mailTertiaryNode ?? null,
    activeNode: effectiveActiveNode,
    drState: row?.mailDrState ?? 'healthy',
    autoFailoverEnabled: row?.mailAutoFailoverEnabled ?? false,
    failoverThresholdSeconds: row?.mailFailoverThresholdSeconds ?? 300,
    lastFailoverAt: row?.mailLastFailoverAt?.toISOString() ?? null,
    portExposureMode: row?.mailPortExposureMode ?? 'thisNodeOnly',
    candidateNodes: candidates,
    readyNodeCount,
    readyServerNodeCount,
    drift,
    lastFailedMigration,
  });
}

/**
 * Update the placement policy in system_settings.
 * Validates that named nodes exist in the cluster before persisting.
 */
export async function updateMailPlacement(
  update: {
    primaryNode?: string | null;
    secondaryNode?: string | null;
    tertiaryNode?: string | null;
    autoFailoverEnabled?: boolean;
    failoverThresholdSeconds?: number;
  },
  db: Database,
  opts: PlacementOptions,
  deps: {
    readonly apply?: (db: Database, opts: PlacementOptions) => Promise<void>;
    readonly migrationInFlight?: (db: Database) => Promise<string | null>;
  } = {},
): Promise<void> {
  const { core } = await loadK8sCoreTenant(opts.kubeconfigPath);

  // Validate that each named node exists in the cluster.
  // Both server-role AND worker-role nodes are valid mail placements —
  // see affinity-patch-mail-stack.yaml. Operators may legitimately pin
  // mail to a worker for SSD/CIFS reasons.
  for (const nodeName of [update.primaryNode, update.secondaryNode, update.tertiaryNode]) {
    if (nodeName) {
      try {
        await core.readNode({ name: nodeName });
      } catch (err) {
        const code =
          (err as { statusCode?: number; code?: number }).statusCode ??
          (err as { code?: number }).code;
        if (code === 404) {
          throw new ApiError(
            'MAIL_NODE_NOT_FOUND',
            `Node '${nodeName}' does not exist in the cluster`,
            404,
          );
        }
        throw new ApiError(
          'MAIL_PLACEMENT_NODE_LOOKUP_FAILED',
          `Could not verify node '${nodeName}': ${(err as Error).message ?? String(err)}`,
          500,
        );
      }
    }
  }

  // Node-count gate (authoritative, server-side). Secondary/tertiary
  // standby placement is only meaningful with enough Ready nodes to
  // actually host a warm standby:
  //   secondary → requires >=2 Ready candidate nodes ("2 active nodes required")
  //   tertiary  → requires >=3 Ready candidate nodes ("3 active nodes required")
  // "Ready candidate node" = the same set getMailPlacement surfaces:
  // a Ready node whose role label is in ELIGIBLE_NODE_ROLES (server OR
  // worker). The UI disables the slots below threshold; this check is the
  // backstop for any caller that bypasses the UI. Only enforced when the
  // operator is actually SETTING that slot (a non-null value) — clearing a
  // slot is always allowed regardless of node count.
  const settingSecondary = 'secondaryNode' in update && !!update.secondaryNode;
  const settingTertiary = 'tertiaryNode' in update && !!update.tertiaryNode;
  if (settingSecondary || settingTertiary) {
    const readyCandidateCount = await countReadyCandidateNodes(core);
    if (settingTertiary && readyCandidateCount < 3) {
      throw new ApiError(
        'MAIL_PLACEMENT_INSUFFICIENT_NODES',
        '3 active nodes required',
        400,
      );
    }
    if (settingSecondary && readyCandidateCount < 2) {
      throw new ApiError(
        'MAIL_PLACEMENT_INSUFFICIENT_NODES',
        '2 active nodes required',
        400,
      );
    }
  }

  const patch: Partial<typeof systemSettings.$inferInsert> = {};
  if ('primaryNode' in update) patch.mailPrimaryNode = update.primaryNode ?? null;
  if ('secondaryNode' in update) patch.mailSecondaryNode = update.secondaryNode ?? null;
  if ('tertiaryNode' in update) patch.mailTertiaryNode = update.tertiaryNode ?? null;
  if ('autoFailoverEnabled' in update) patch.mailAutoFailoverEnabled = update.autoFailoverEnabled;
  if ('failoverThresholdSeconds' in update)
    patch.mailFailoverThresholdSeconds = update.failoverThresholdSeconds;

  // Saving re-pins the stack to the ACTIVE node (below). Mid-migration — an
  // operator move or the DR watcher's failover — that would pull it back to the
  // source while the run moves it to the target, so wait for the run to end.
  if (await (deps.migrationInFlight ?? mailMigrationInFlight)(db)) {
    throw new ApiError(
      'MAIL_MIGRATION_ALREADY_RUNNING',
      'A mail migration is in progress — save placement after it finishes',
      409,
    );
  }

  await db.update(systemSettings).set(patch).where(eq(systemSettings.id, SETTINGS_ID));

  // Apply what was just saved. The standby label is what makes the
  // mail-stack-standby-replicate DaemonSet stage a warm copy on the new
  // secondary/tertiary; only platform-api STARTUP used to run this, so a standby
  // chosen here stayed unlabelled until the next deploy — and a DR failover in
  // that window took the restic path, losing mail since the last backup.
  try {
    await (deps.apply ?? ensureMailStackPlacementApplied)(db, opts);
  } catch (err) {
    throw new ApiError(
      'MAIL_PLACEMENT_APPLY_FAILED',
      `Placement saved, but applying it to the cluster failed: ${(err as Error).message ?? String(err)} — save again to retry`,
      502,
    );
  }
}

/**
 * Pick the best available failover target node — highest free memory
 * among ready nodes that are NOT the excluded (currently failing) node.
 * Throws MAIL_PLACEMENT_NO_CANDIDATE when no eligible node is found.
 */
export async function pickBestFailoverNode(
  excludeNode: string | null,
  candidates: NodeCandidate[],
): Promise<string> {
  const eligible = candidates.filter((c) => c.ready && c.hostname !== excludeNode);
  if (eligible.length === 0) {
    throw new ApiError(
      'MAIL_PLACEMENT_NO_CANDIDATE',
      'No eligible failover node available',
      409,
    );
  }
  // Sort by free memory descending — higher memory = more headroom.
  const sorted = [...eligible].sort((a, b) => b.freeMemoryBytes - a.freeMemoryBytes);
  return sorted[0].hostname;
}

// Expose MAIL_NAMESPACE so port-exposure can use the same constant.
export { MAIL_NAMESPACE };

/**
 * Startup self-heal: ensure every Deployment in MAIL_STACK_DEPLOYMENTS
 * is pinned to the current mailActiveNode. Without this, a fresh
 * Bulwark Deployment (manifest carries no nodeSelector — see A1) would
 * schedule on any node, breaking the co-location invariant that Bulwark
 * always lives on the same node as Stalwart.
 *
 * Idempotent — applyDeploymentAffinity uses merge-patch semantics so
 * re-applying the same selector is a no-op.
 *
 * Fire-and-forget; caller logs failures via .catch(). If
 * mailActiveNode is null (operator hasn't run placement yet), we
 * skip — the next placement-update or migration call will set it.
 * Also run by updateMailPlacement after every save, so a newly chosen
 * standby is labelled (and starts replicating) immediately.
 */
export async function ensureMailStackPlacementApplied(
  db: Database,
  opts: PlacementOptions,
): Promise<void> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));

  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (opts.kubeconfigPath) kc.loadFromFile(opts.kubeconfigPath);
  else kc.loadFromCluster();
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const batch = kc.makeApiClient(k8s.BatchV1Api);

  // primaryNode self-heal: a freshly-bootstrapped cluster
  // has mail_primary_node = NULL (no operator has run the placement
  // wizard yet). The UX flow now requires primary to be set so we
  // backfill from the most-authoritative source available:
  //   1. The live Stalwart pod's spec.nodeName
  //   2. mail_active_node (last persisted active from prior migration)
  // If neither is available, log + skip — the next operator action
  // (manual placement set, or a migration) will populate it.
  //
  // Idempotent: skips the write if mail_primary_node already has a
  // value, so subsequent boots don't clobber operator-set placement.
  if (!row?.mailPrimaryNode) {
    let inferredPrimary: string | null = null;
    try {
      const podList = await core.listNamespacedPod({
        namespace: MAIL_NAMESPACE,
        labelSelector: 'app=stalwart-mail',
      }) as { items?: Array<{
        metadata?: { deletionTimestamp?: string };
        spec?: { nodeName?: string };
        status?: { phase?: string };
      }> };
      const runningPod = (podList.items ?? []).find(
        (p) => p.status?.phase === 'Running' && !p.metadata?.deletionTimestamp,
      );
      inferredPrimary = runningPod?.spec?.nodeName ?? null;
    } catch (err) {
      opts.logger?.warn?.(
        { err: (err as Error).message ?? String(err) },
        'placement self-heal: live Stalwart pod query failed; falling back to mail_active_node',
      );
    }
    if (!inferredPrimary) {
      inferredPrimary = (row?.mailActiveNode ?? null) as string | null;
    }
    // Fresh-cluster fallback: the very first cluster server has no
    // Stalwart pod and no mail_active_node yet (both are written later by
    // the first migration / pod schedule). To make "the FIRST cluster
    // server sets the mail PRIMARY node to itself automatically" work as
    // a backend self-heal, elect the sole Ready server-role node when
    // EXACTLY ONE exists. >1 servers → ambiguous, leave NULL for the
    // operator to choose (avoid guessing the wrong primary on an HA
    // cluster). Still gated by the outer `!row?.mailPrimaryNode` guard so
    // an operator-set primary is never overridden.
    if (!inferredPrimary) {
      const readyServers = await listReadyServerNodeNames(core);
      if (readyServers.length === 1) {
        inferredPrimary = readyServers[0];
        opts.logger?.warn?.(
          `placement self-heal: electing sole Ready server '${inferredPrimary}' as ` +
          'mail_primary_node (first/only cluster server self-assigns primary)',
        );
      }
    }
    if (inferredPrimary) {
      await db.update(systemSettings)
        .set({ mailPrimaryNode: inferredPrimary })
        .where(eq(systemSettings.id, SETTINGS_ID))
        .catch((err: unknown) => {
          opts.logger?.warn?.(
            { err: (err as Error).message ?? String(err) },
            'placement self-heal: mail_primary_node backfill write failed (non-fatal)',
          );
        });
      opts.logger?.warn?.(
        `placement self-heal: backfilled mail_primary_node=${inferredPrimary} (was NULL)`,
      );
    } else {
      opts.logger?.warn?.(
        'placement self-heal: mail_primary_node is NULL and no inference source ' +
        '(no Stalwart pod, no mail_active_node) — operator must set placement before mail can serve',
      );
    }
  }

  // A migration (operator move or DR failover) owns the Deployment pin and its
  // restore annotation until it ends: between creating the target PVC and
  // scaling up there is no pod, and re-applying affinity here (allowRestore
  // false) would strip the restore stamp the migration just set — a routine
  // platform-api restart during a migration would make it fresh-start. Skip;
  // the migration records the outcome itself, and the next start reconciles.
  const inFlight = await mailMigrationInFlight(db);
  if (inFlight) {
    opts.logger?.warn?.(
      `ensureMailStackPlacementApplied: mail migration ${inFlight} in flight — leaving the stack placement to it`,
    );
    return;
  }

  // Pin to where the stack IS — the live pod, else the node its volume is
  // bound to, else the stored column — never to a stored value a migration
  // abandoned mid-run left behind: that pinned Stalwart to a node its volume
  // is not on (Pending, mail down) on the first platform-api start after a
  // DR failover whose state machine was killed.
  const { node: activeNode, source } = await resolveActiveMailNode(db, core, {
    persist: true,
    stored: (row?.mailActiveNode ?? null) as string | null,
    logger: { warn: (msg: string) => opts.logger?.warn?.(msg) },
  });
  if (!activeNode) {
    opts.logger?.warn?.(
      'ensureMailStackPlacementApplied: no active mail node (no Stalwart pod, no bound mail volume, nothing stored) — skipping affinity reconcile',
    );
    return;
  }
  if (source !== 'settings' && activeNode !== row?.mailActiveNode) {
    opts.logger?.warn?.(
      `ensureMailStackPlacementApplied: stored active node ${row?.mailActiveNode ?? '(none)'} is stale — mail is on ${activeNode} (${source}); pinning there`,
    );
  }

  const { applyDeploymentAffinity } = await import('./migration.js');
  // allowRestore=false on startup — we're not promoting from a
  // restore, just ensuring the current pin is set on both Deployments.
  // Stamping the annotation on every restart would re-trigger the
  // restore-state init container the next time Stalwart's pod is
  // recreated, which is wrong.
  await applyDeploymentAffinity(apps, activeNode, /* allowRestore */ false);

  // A3: label secondary/tertiary nodes for the
  // mail-stack-standby-replicate CronJob nodeSelector. Idempotent.
  // Always invoked (even when no standby nodes are configured) so the
  // label gets REMOVED from previously-elected nodes when the operator
  // downgrades from HA back to single-node.
  //
  // follow-up: also spawn a one-shot cleanup Job on any
  // node that LOST the label this tick — the DaemonSet pod will be
  // evicted but `/var/lib/mail-stack-standby/` would otherwise stay on
  // disk indefinitely. The cleanup Job renames to
  // `.deelected-<ts>/` and the janitor CronJob deletes after 48h.
  //
  // derive the set as "configured candidates MINUS the node the
  // stack is currently running on", instead of labelling secondary+tertiary
  // literally, and add the PRIMARY as a candidate.
  //
  // The old rule produced two wrong outcomes after a failover, both seen on
  // staging. The active node was itself one of secondary/tertiary, so it ran
  // a standby replicator that rsynced from its own pod — pure waste. And the
  // PRIMARY, which is the target of `POST /admin/mail/failback`, was never a
  // standby, so it carried NO fresh data: its sentinel was two months old,
  // the FAST PATH max-age gate correctly rejected it, and failback fell
  // through to the slow restic path every time.
  //
  // Staging a copy on the primary is exactly what makes failback fast, and
  // staging one on the active node is exactly what never helps.
  await applyMailStandbyLabels(
    core,
    batch,
    {
      primary: row?.mailPrimaryNode ?? null,
      secondary: row?.mailSecondaryNode ?? null,
      tertiary: row?.mailTertiaryNode ?? null,
    },
    activeNode,
    opts.logger,
  );
}

/**
 * Label exactly the nodes that should stage a standby copy for a stack running
 * on `activeNode` (deriveStandbyNodes), de-electing the rest. Returns that set.
 *
 * A migration calls this once it has moved the stack. The startup reconcile
 * above skips while a migration is in flight — and the migration's own admin
 * credential rotation restarts platform-api inside that window — so after a
 * failover or failback the label stayed on the node that had just become
 * ACTIVE (a replicator copying from its own pod) while the real standby got
 * nothing, and the next failure restored from a stale copy or restic.
 */
export async function applyMailStandbyLabels(
  core: import('@kubernetes/client-node').CoreV1Api,
  batch: import('@kubernetes/client-node').BatchV1Api,
  placement: { readonly primary: string | null; readonly secondary: string | null; readonly tertiary: string | null },
  activeNode: string,
  logger?: PlacementOptions['logger'],
): Promise<string[]> {
  const standbyNodes = deriveStandbyNodes({ ...placement, activeNode });
  await reconcileMailStandbyLabel(core, batch, standbyNodes, logger);
  return standbyNodes;
}

/**
 * Which nodes should pre-stage a copy of the mail store.
 *
 * "Every configured placement candidate except wherever the stack is running
 * right now." Pure so the rule can be tested without a cluster.
 *
 * Replaced a literal secondary+tertiary list. That version put
 * a standby replicator on the ACTIVE node (rsyncing from its own pod) while
 * leaving the PRIMARY — the failback target — with no fresh data at all, so
 * every failback took the slow restic path.
 */
export function deriveStandbyNodes(input: {
  readonly primary: string | null;
  readonly secondary: string | null;
  readonly tertiary: string | null;
  readonly activeNode: string | null;
}): string[] {
  const candidates = [input.primary, input.secondary, input.tertiary]
    .filter((n): n is string => !!n);
  return [...new Set(candidates)].filter((n) => n !== input.activeNode);
}

/**
 * A3: ensure exactly the supplied set of nodes carries
 * the `insula.host/mail-standby=true` label. Other
 * nodes get the label removed (cleanup if a previous secondary was
 * de-elected, or HA disabled entirely). Idempotent.
 */
async function reconcileMailStandbyLabel(
  core: import('@kubernetes/client-node').CoreV1Api,
  batch: import('@kubernetes/client-node').BatchV1Api,
  standbyNodes: readonly string[],
  logger: PlacementOptions['logger'],
): Promise<void> {
  const { JSON_PATCH } = await import('../../shared/k8s-patch.js');
  const { spawnStandbyDeelectionCleanupJob } = await import('./standby-cleanup.js');
  const STANDBY_LABEL = 'insula.host/mail-standby';
  const wantSet = new Set(standbyNodes);

  let allNodes: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }> = [];
  try {
    const res = await core.listNode() as { items?: typeof allNodes };
    allNodes = res.items ?? [];
  } catch (err) {
    logger?.warn?.('reconcileMailStandbyLabel: listNode failed —', err);
    return;
  }

  for (const node of allNodes) {
    const name = node.metadata?.name;
    if (!name) continue;
    const hasLabel = node.metadata?.labels?.[STANDBY_LABEL] === 'true';
    const shouldHave = wantSet.has(name);
    if (hasLabel === shouldHave) continue;

    // JSON-Patch: add or remove the label. Path uses ~1 to escape '/'.
    const escaped = STANDBY_LABEL.replace(/~/g, '~0').replace(/\//g, '~1');
    const patch = shouldHave
      ? [{ op: 'add', path: `/metadata/labels/${escaped}`, value: 'true' }]
      : [{ op: 'remove', path: `/metadata/labels/${escaped}` }];
    try {
      await core.patchNode(
        { name, body: patch } as unknown as Parameters<typeof core.patchNode>[0],
        JSON_PATCH,
      );
      logger?.warn?.(`reconcileMailStandbyLabel: ${shouldHave ? 'added' : 'removed'} ${STANDBY_LABEL}=true on node ${name}`);
    } catch (err) {
      logger?.warn?.(`reconcileMailStandbyLabel: patch ${name} failed (non-fatal) —`, err);
      // Don't try cleanup if the label patch failed — node state is
      // unknown, retry next reconcile.
      continue;
    }

    // on label REMOVAL, schedule the one-shot cleanup Job
    // that renames /var/lib/mail-stack-standby → .deelected-<ts>/ on
    // the de-elected node. The janitor CronJob deletes any
    // .deelected-* dirs older than 48h, giving operators a recovery
    // window for accidental secondary swaps.
    if (!shouldHave) {
      try {
        await spawnStandbyDeelectionCleanupJob(batch, name);
        logger?.warn?.(
          `reconcileMailStandbyLabel: scheduled standby cleanup on de-elected node ${name} — ` +
          '/var/lib/mail-stack-standby renamed to .deelected-<ts>/, janitor deletes after 48h',
        );
      } catch (err) {
        // Non-fatal: the next reconcile tick will retry, OR the operator
        // can manually clean up. Leaving the leftover data is a leak,
        // not a correctness bug.
        logger?.warn?.(
          `reconcileMailStandbyLabel: cleanup-job spawn for de-elected node ${name} failed (non-fatal) —`,
          err,
        );
      }
    }
  }
}
