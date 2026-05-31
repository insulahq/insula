/**
 * Mail port exposure mode — toggle between:
 *
 *   thisNodeOnly   — Stalwart pod binds mail ports via hostPort directly;
 *                    only the node the pod is scheduled on receives traffic.
 *                    No haproxy DaemonSet present in the cluster.
 *
 *   allServerNodes — haproxy DaemonSet bound on every server-role node
 *                    forwards mail traffic to stalwart-mail.mail.svc with
 *                    PROXY Protocol v2 so Stalwart sees real tenant IPs.
 *                    DS is CREATED by platform-api on entry to this mode,
 *                    DELETED on exit.
 *
 * Switching modes is a two-step operation that avoids port conflicts:
 *
 *   thisNodeOnly → allServerNodes:
 *     1. Remove hostPort from Stalwart Deployment (JSON-Patch on the
 *        ports array; Deployment rolls).
 *     2. CREATE the haproxy DaemonSet (apps.createNamespacedDaemonSet
 *        from the buildHaproxyDaemonSet() spec).
 *     3. Persist mode in system_settings.
 *
 *   allServerNodes → thisNodeOnly:
 *     1. DELETE the haproxy DaemonSet (apps.deleteNamespacedDaemonSet).
 *     2. Re-add hostPort to Stalwart Deployment (Deployment rolls).
 *     3. Persist mode in system_settings.
 *
 * 2026-05-14 streamline: previously the DS was always-applied by Flux
 * with a dummy nodeSelector and platform-api SSA-patched the selector
 * to toggle. That created an ongoing field-ownership war with Flux's
 * kustomize-controller (PRs #43–#45). Moving the DS object lifecycle
 * to platform-api ends the war — Flux still owns the ConfigMap and
 * NetworkPolicy, both of which are static and benefit from GitOps.
 *
 * GET  /admin/mail/port-exposure  → MailPortExposureResponse
 * PATCH /admin/mail/port-exposure → 204
 */

import { and, eq } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { applyPatch } from '../../shared/k8s-patch.js';
import { isNotFound } from '../../shared/k8s-errors.js';
import { waitForStalwartRollout } from './rollout-wait.js';
import { systemSettings, tasks } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  type MailPortExposureResponse,
  type MailPortExposureMode,
  mailPortExposureResponseSchema,
} from '@insula/api-contracts';
import {
  buildHaproxyDaemonSet,
  HAPROXY_DS_NAME,
  HAPROXY_DS_NAMESPACE,
} from './haproxy-builder.js';
import {
  resolveHaproxyNodes,
  resolveExternalIpNodes,
  reconcileMailHaproxyLabels,
  validateModeSwitch,
  type PlacementSettings,
  type NodeRef,
} from './port-exposure-modes.js';

const SETTINGS_ID = 'system';
const DEPLOYMENT_NAME = 'stalwart-mail';
const NODE_ROLE_LABEL_KEY = 'insula.host/node-role';

/**
 * Count Ready, server-role nodes in the cluster.
 *
 * Gate input for the HA-proxy port-exposure modes (assignedMailNodes +
 * allServerNodes): they require >=2 server-role nodes because haproxy
 * exists only to fan mail traffic across MULTIPLE publicly-reachable
 * server nodes — with a single server there is nothing to load-balance
 * and the haproxy DS would just fight Stalwart's always-on hostPort.
 *
 * Counts ONLY Ready nodes whose role label is exactly 'server' (workers
 * are excluded — they are not part of the public server tier). This is a
 * deliberately narrower set than loadPlacementAndNodes' NodeRef list,
 * which (a) drops Ready status and (b) carries every node regardless of
 * role. Best-effort: a failed listNode returns 0 so the gate fails closed.
 */
async function countReadyServerNodes(
  core: import('@kubernetes/client-node').CoreV1Api,
): Promise<number> {
  type NodeShape = {
    metadata?: { labels?: Record<string, string> };
    status?: { conditions?: Array<{ type: string; status: string }> };
  };
  try {
    const list = await core.listNode({}) as { items?: NodeShape[] };
    return (list.items ?? []).filter((n) => {
      const ready = n.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True';
      const role = n.metadata?.labels?.[NODE_ROLE_LABEL_KEY] ?? '';
      return ready && role === 'server';
    }).length;
  } catch {
    return 0;
  }
}
// Stalwart Deployment + haproxy DaemonSet both live in the `mail`
// namespace; aliasing this constant here for readability — code that
// patches the Stalwart Deployment shouldn't read as if it were
// patching the haproxy namespace.
const MAIL_NS = HAPROXY_DS_NAMESPACE;

// Server-Side Apply with force-claim, fieldManager=platform-api.port-exposure.
//
// Phase 7 streamline E2E exhausted three patch approaches:
//   1. JSON-Patch op:replace — Flux re-claims `ports` and reverts within
//      1min reconcile. Operation=Update; Flux's non-force SSA conflict
//      check only looks at Apply-marker ownership.
//   2. Strategic-merge with `$patch: replace` directive — apiserver
//      accepts the patch but silently no-ops the directive on nested
//      merge-key lists (containers[].ports inside containers[]).
//   3. Strategic-merge with per-port `$retainKeys` — apiserver emits
//      `Warning: unknown field` and treats the patch as a no-op.
//      $retainKeys is not supported as a list-element directive in
//      this position.
//
// The fix that works: REMOVE hostPort from the git manifest (done in
// k8s/base/stalwart-mail/stalwart/deployment.yaml) and use SSA-apply
// here to CLAIM hostPort dynamically. With manifest=no-hostPort and
// fieldManager=platform-api.port-exposure (Apply operation), the
// apiserver attributes hostPort ownership to us. Flux's reconcile
// (non-force SSA via `kustomize.toolkit.fluxcd.io/ssa: merge`
// annotation on the Deployment) sees the field is owned by another
// Apply-manager and skips it — leaving our value intact.
//
// SSA can't UNSET fields it doesn't own, but now we OWN hostPort —
// so we can choose to send or omit it based on mode.
const STALWART_PORTS_PATCH = applyPatch('platform-api.port-exposure', { force: true });

// SSA-apply opts for Service.externalIPs reconciliation (reconcile-
// MailServiceExternalIPsByName). Module-level const so the
// ci-k8s-patch-check guard's regex (`[A-Z_]+_PATCH`) catches it —
// inline `applyPatch(...)` at the call site fails the guard because
// the `\b` boundary after `(` doesn't match.
const STALWART_EXTERNAL_IPS_PATCH = applyPatch(
  'platform-api.mail-port-exposure',
  { force: true },
);

// Mail ports that Stalwart binds via hostPort in 'thisNodeOnly' mode.
const MAIL_HOST_PORTS = [25, 465, 587, 143, 993, 4190] as const;

export interface PortExposureOptions {
  readonly kubeconfigPath: string | undefined;
}

interface K8sAppsBundle {
  apps: import('@kubernetes/client-node').AppsV1Api;
  core: import('@kubernetes/client-node').CoreV1Api;
}

async function loadK8sAppsTenant(kubeconfigPath: string | undefined): Promise<K8sAppsBundle> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return {
    apps: kc.makeApiClient(k8s.AppsV1Api),
    core: kc.makeApiClient(k8s.CoreV1Api),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the current port-exposure mode and haproxy DaemonSet status.
 *
 * The DS is expected to be ABSENT in `thisNodeOnly` mode (platform-api
 * deleted it) and PRESENT with the expected pod count in `allServerNodes`
 * mode. Drift (DS present but mode=thisNodeOnly, or DS absent but
 * mode=allServerNodes) shows up in the response as `daemonSetStatus`
 * not matching `proxyProtocolActive` — operator-visible in the UI.
 */
export async function getMailPortExposure(
  db: Database,
  opts: PortExposureOptions,
): Promise<MailPortExposureResponse> {
  const { apps, core } = await loadK8sAppsTenant(opts.kubeconfigPath);

  const [row] = await db.select({ v: systemSettings.mailPortExposureMode })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID));

  // Default to allServerNodes (Phase 2 streamline, 2026-05-15). Matches
  // the schema column default. Legacy 'thisNodeOnly' values from
  // pre-0034 DBs are normalised by migration 0034; defensive
  // re-mapping here covers any older runtime path.
  const stored = row?.v;
  const mode: MailPortExposureMode = stored === 'thisNodeOnly'
    ? 'activeNodeOnly'
    : ((stored as MailPortExposureMode | null) ?? 'allServerNodes');

  let daemonSetStatus: { ready: number; desired: number } | null = null;
  try {
    const ds = await apps.readNamespacedDaemonSet({
      namespace: HAPROXY_DS_NAMESPACE,
      name: HAPROXY_DS_NAME,
    }) as { status?: { numberReady?: number; desiredNumberScheduled?: number } };
    daemonSetStatus = {
      ready: ds.status?.numberReady ?? 0,
      desired: ds.status?.desiredNumberScheduled ?? 0,
    };
  } catch (err) {
    if (isNotFound(err)) {
      // DS not present — expected in activeNodeOnly mode (where only
      // Stalwart's own hostPort serves mail, no haproxy at all).
      daemonSetStatus = null;
    }
    // Non-404 errors are swallowed — mode is still readable from DB.
  }

  // Surface the Ready server-node count so the UI can gate the HA-proxy
  // mode radios (assignedMailNodes + allServerNodes require >=2). The same
  // count is enforced authoritatively in validateModeSwitchAgainstDb.
  const readyServerNodeCount = await countReadyServerNodes(core);

  return mailPortExposureResponseSchema.parse({
    mode,
    // PROXY-protocol is active whenever haproxy is in the data path —
    // both assignedMailNodes and allServerNodes use haproxy. Only the
    // activeNodeOnly mode bypasses it (Stalwart binds hostPort directly).
    proxyProtocolActive: mode !== 'activeNodeOnly',
    daemonSetStatus,
    readyServerNodeCount,
  });
}

/**
 * Read placement settings + node list. Shared by ensureMailPortExposureApplied,
 * applyModeToCluster, and the route handler's pre-PATCH validation.
 */
export async function loadPlacementAndNodes(
  db: Database,
  kubeconfigPath: string | undefined,
): Promise<{ settings: PlacementSettings; nodes: NodeRef[] }> {
  const [row] = await db.select({
    primaryNode: systemSettings.mailPrimaryNode,
    secondaryNode: systemSettings.mailSecondaryNode,
    tertiaryNode: systemSettings.mailTertiaryNode,
    activeNode: systemSettings.mailActiveNode,
  })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID));
  const settings: PlacementSettings = {
    primaryNode: row?.primaryNode ?? null,
    secondaryNode: row?.secondaryNode ?? null,
    tertiaryNode: row?.tertiaryNode ?? null,
    activeNode: row?.activeNode ?? null,
  };

  const { core } = await loadK8sAppsTenant(kubeconfigPath);
  const list = await core.listNode({}) as {
    items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }>;
  };
  const nodes: NodeRef[] = (list.items ?? [])
    .filter((n) => !!n.metadata?.name)
    .map((n) => ({
      metadata: {
        name: n.metadata!.name!,
        labels: n.metadata?.labels ?? {},
      },
    }));
  return { settings, nodes };
}

/**
 * Run the operator's mode-switch through validateModeSwitch BEFORE
 * touching the cluster. Returns the human-readable error (suitable
 * for HTTP 400) or null when the switch is safe.
 *
 * Exported so the route handler can refuse the PATCH early — no
 * destructive cluster operations until validation passes.
 */
export async function validateModeSwitchAgainstDb(
  target: MailPortExposureMode,
  db: Database,
  kubeconfigPath: string | undefined,
): Promise<string | null> {
  const { settings } = await loadPlacementAndNodes(db, kubeconfigPath);

  // Node-count gate (authoritative, server-side): the HA-proxy modes —
  // any non-activeNodeOnly mode (assignedMailNodes + allServerNodes) —
  // require >=2 Ready SERVER-role nodes. With fewer there is nothing to
  // load-balance across and the haproxy DS would only contend with
  // Stalwart's always-on hostPort. Workers do NOT count toward this gate.
  // activeNodeOnly is always permitted (Stalwart binds hostPort directly).
  if (target !== 'activeNodeOnly') {
    const { core } = await loadK8sAppsTenant(kubeconfigPath);
    const readyServerNodeCount = await countReadyServerNodes(core);
    if (readyServerNodeCount < 2) {
      return 'Mail HA-Proxy requires 2 or more server nodes.';
    }
  }

  return validateModeSwitch(target, settings);
}

/**
 * Per-step progress callback. The route handler wires this to the task
 * center; tests + the startup reconciler pass a no-op.
 *
 * `stepKey` is a stable identifier; `pct` is 0..100 (or null for
 * indeterminate); `text` is the operator-visible label.
 */
export interface PortExposureProgressCallback {
  (event: {
    readonly stepKey: string;
    readonly pct: number | null;
    readonly text: string;
  }): Promise<void> | void;
}

/**
 * Switch the port-exposure mode.
 * Applies the two-step transition to avoid port conflicts on nodes.
 *
 * Accepts an optional `onProgress` callback so the route handler can
 * write task-center progress between sub-steps. The operation takes
 * 30-60s (Deployment roll + DS create/delete + rollout wait), so
 * granular progress is the difference between "page hangs for a
 * minute" and "operator watches the steps tick".
 */
export async function updateMailPortExposure(
  { mode }: { mode: MailPortExposureMode },
  db: Database,
  opts: PortExposureOptions,
  onProgress?: PortExposureProgressCallback,
): Promise<void> {
  await applyModeToCluster(mode, opts, onProgress, db);

  if (onProgress) {
    await onProgress({
      stepKey: 'db-persist',
      pct: 95,
      text: 'Persisting mode to database',
    });
  }
  // Persist the new mode.
  await db.update(systemSettings)
    .set({ mailPortExposureMode: mode })
    .where(eq(systemSettings.id, SETTINGS_ID));

  if (onProgress) {
    await onProgress({
      stepKey: 'done',
      pct: 100,
      text: `Port exposure now ${mode}`,
    });
  }
}

/**
 * Drive the cluster state to match the DB-stored mode.
 *
 * Used at platform-api startup so fresh installs (where the DB row was
 * created with the default `allServerNodes`) actually have the haproxy
 * DaemonSet present without the operator needing to PATCH the endpoint.
 * Idempotent — if the cluster already matches, the calls are no-ops.
 *
 * Skip-if-task-running: when a `mail.port-exposure` task is `running`,
 * an operator-initiated mode switch is in flight on some pod. Running
 * the startup reconciler concurrently would race over the same
 * Deployment patch / DS lifecycle / node labels (caught 2026-05-28:
 * CI deploys restart platform-api mid-PATCH; new pod's startup
 * reconciler raced the old pod's still-live orchestration of the
 * operator's PATCH and deadlocked the Deployment's SSA owners). Skip
 * here and let the operator's task either finish or fail; subsequent
 * operator action or the next platform-api restart re-reconciles.
 */
export async function ensureMailPortExposureApplied(
  db: Database,
  opts: PortExposureOptions,
): Promise<void> {
  const running = await db.select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.kind, 'mail.port-exposure'), eq(tasks.status, 'running')))
    .limit(1);
  if (running.length > 0) {
    // An operator PATCH is in flight (possibly on another pod or this
    // pod's previous incarnation). Refuse to apply — operator intent
    // wins. The orphan-task cleanup outside this module is responsible
    // for marking stale `running` rows failed.
    //
    // Operator escape hatch when the worst-case 24h orphan reaper
    // window blocks startup reconciliation:
    //   UPDATE tasks SET status='failed'
    //    WHERE kind='mail.port-exposure' AND status='running';
    // then restart platform-api (or wait for the next pod cycle).
    return;
  }
  // Note on the cross-pod safe-by-SSA invariant: two pods starting at
  // the same time both pass the guard (no in-flight task yet) and both
  // call applyModeToCluster. The Deployment + Service SSA-applies use
  // `force: true` with a stable fieldManager — the apiserver
  // atomically dedupes the second apply, so we don't get divergent
  // state. This is by SSA semantics, not by a guard in this code.
  const [row] = await db.select({ v: systemSettings.mailPortExposureMode })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID));
  const mode = (row?.v as MailPortExposureMode | null) ?? 'allServerNodes';
  await applyModeToCluster(mode, opts, undefined, db);
}

/**
 * Process-local mutex serialising applyModeToCluster invocations within
 * a single platform-api pod. Two callers can reach this function
 * concurrently — the route handler's PATCH-spawned background task and
 * the startup reconciler's fire-and-forget call (app.ts:1246). The
 * DB-level `running`-task guard in ensureMailPortExposureApplied
 * blocks the startup-vs-operator race, but a second operator PATCH
 * landing on the same pod while the first is still inside
 * applyModeToCluster would still race over Deployment/Service patches.
 * This chain-promise mutex serialises both cases without blocking the
 * event loop: callers join the tail of the existing promise chain.
 */
let applyModeMutex: Promise<void> = Promise.resolve();

/**
 * Two-step cluster mutation for the given mode. Extracted from
 * `updateMailPortExposure` so the startup reconciler can reuse it
 * without writing back to the DB (the DB value is the source of truth).
 */
async function applyModeToCluster(
  mode: MailPortExposureMode,
  opts: PortExposureOptions,
  onProgress?: PortExposureProgressCallback,
  db?: Database,
): Promise<void> {
  // Chain onto the existing mutex tail. Errors don't poison the chain
  // — we catch the prior result so a failed prior call doesn't prevent
  // subsequent calls from proceeding.
  const prior = applyModeMutex.catch(() => undefined);
  let release: () => void;
  applyModeMutex = new Promise<void>((resolve) => { release = resolve; });
  await prior;
  try {
    await applyModeToClusterUnlocked(mode, opts, onProgress, db);
  } finally {
    release!();
  }
}

async function applyModeToClusterUnlocked(
  mode: MailPortExposureMode,
  opts: PortExposureOptions,
  onProgress?: PortExposureProgressCallback,
  db?: Database,
): Promise<void> {
  const { apps, core } = await loadK8sAppsTenant(opts.kubeconfigPath);

  // Compute the THREE distinct node sets used by orchestration:
  //   haproxyNodes  — where haproxy DS schedules. EXCLUDES active node in
  //                   haproxy modes (Stalwart hostPort=25 on active would
  //                   conflict with haproxy hostPort=25). Empty for
  //                   activeNodeOnly.
  //   externalIps   — node names whose IPs go into Service.spec.externalIPs.
  //                   ALWAYS excludes active node — kube-proxy's
  //                   externalIP DNAT routes via ClusterIP→pod, and on
  //                   the active node that path same-node-hairpins on
  //                   the reply (reply dst=active-IP routes to lo, never
  //                   reaches the original socket). The active node
  //                   serves via Stalwart hostPort (CNI portmap, no
  //                   hairpin). Empty for activeNodeOnly.
  //
  // Without db we can't read placement — skip label/externalIPs work and
  // the orchestrator falls back to just patching the Deployment + DS.
  let haproxyNodes: string[] = [];
  let externalIps: string[] = [];
  let allNodes: NodeRef[] = [];
  let activeNode: string | null = null;
  if (db) {
    const { settings: dbSettings, nodes } = await loadPlacementAndNodes(db, opts.kubeconfigPath);
    allNodes = nodes;

    // Fallback active-node derivation (fresh-multi-node deadlock fix).
    // On a cold multi-node bootstrap `mail_active_node` is never seeded,
    // so the haproxy resolver can't exclude the node Stalwart needs and
    // would label haproxy onto EVERY server node — colliding on the mail
    // hostPorts and pinning stalwart-mail Pending. The mail-stack PVC is
    // pinned (local-path RWO) to exactly the node Stalwart must run on, so
    // derive the active node from it when the DB has none yet. DB value
    // always wins when set (current behaviour unchanged).
    let settings = dbSettings;
    if (!dbSettings.activeNode) {
      const derived = await deriveActiveNodeFromMailPvc(core);
      if (derived && nodes.some((n) => n.metadata.name === derived)) {
        settings = { ...dbSettings, activeNode: derived };
      }
    }

    activeNode = settings.activeNode;
    haproxyNodes = resolveHaproxyNodes(mode, settings, nodes);
    externalIps = resolveExternalIpNodes(mode, settings, nodes);
    // Re-validate inside the orchestrator: the route-handler
    // pre-validates BEFORE starting the background task, but a
    // concurrent placement PATCH between then and now could have
    // changed `activeNode` or the assigned set, making the originally-
    // valid switch now invalid. Refuse late rather than apply a
    // silently-wrong topology. Caught by typescript-reviewer.
    const lateErr = validateModeSwitch(mode, settings);
    if (lateErr) {
      throw new ApiError(
        'MAIL_PORT_EXPOSURE_MODE_REFUSED',
        `Mode switch became invalid mid-flight: ${lateErr}`,
        409,
      );
    }
  }

  // Post-hairpin-fix invariant (2026-05-28): Stalwart Deployment ALWAYS
  // has hostPort=25/465/587/143/993/4190 — the active node serves via
  // CNI portmap directly. In haproxy modes the OTHER data-plane nodes
  // bind hostPort=25 via the haproxy DS (no conflict because Stalwart's
  // pod lives only on the active node, and the active node is excluded
  // from haproxyNodes).
  //
  // CRITICAL ORDERING: free port 25 on the active node FIRST. If a
  // haproxy DS pod is currently scheduled on the active node it will
  // be holding hostPort=25, blocking the new Stalwart pod's scheduler
  // from finding a free port. The active node is Stalwart's only
  // eligible node (topology spread), so a single conflict deadlocks
  // the whole rollout. Order: drain haproxy from active → apply
  // Stalwart hostPort → wait rollout → re-converge DS on remaining
  // haproxy nodes.

  // Step 1: drain haproxy from the active node (so port 25 is free
  // when Stalwart's new pod tries to schedule there).
  if (mode === 'activeNodeOnly') {
    if (onProgress) {
      await onProgress({
        stepKey: 'delete-haproxy-ds',
        pct: 10,
        text: 'Deleting haproxy DaemonSet (frees port 25 cluster-wide for Stalwart hostPort)',
      });
    }
    await ensureHaproxyDaemonSetAbsent(apps);
    if (db) {
      // Clear all mail-haproxy labels so a future mode switch starts
      // from a clean slate.
      await reconcileMailHaproxyLabels(core, [], allNodes);
    }
  } else if (db) {
    if (onProgress) {
      await onProgress({
        stepKey: 'reconcile-haproxy-labels',
        pct: 15,
        text: activeNode
          ? `Labelling haproxy nodes: ${haproxyNodes.join(', ') || '(none)'} (active node ${activeNode} excluded — Stalwart hostPort there)`
          : `Labelling haproxy nodes: ${haproxyNodes.join(', ') || '(none)'}`,
      });
    }
    await reconcileMailHaproxyLabels(core, haproxyNodes, allNodes);
    // Brief settle window so the kubelet on the active node has time
    // to evict the now-deselected haproxy pod and release hostPort 25
    // before Stalwart's new pod tries to schedule. The DS controller's
    // pod GC + kubelet's port-release cycle is sub-second normally;
    // 5s is a comfortable upper bound and well under the rollout-wait
    // budget. Without this delay the next addHostPortsToDeployment ->
    // scheduler race hits FailedScheduling("didn't have free ports")
    // and waitForStalwartRollout times out at 90s.
    await sleepMs(5_000);
  }

  // Step 2: SSA Stalwart hostPorts + wait rollout.
  if (onProgress) {
    await onProgress({
      stepKey: 'add-hostports',
      pct: 35,
      text: 'Ensuring Stalwart Deployment binds host ports on active node',
    });
  }
  await addHostPortsToDeployment(apps);

  if (onProgress) {
    await onProgress({
      stepKey: 'wait-stalwart-rollout',
      pct: 60,
      text: 'Waiting for Stalwart rollout to complete',
    });
  }

  // Step 3: ensure haproxy DS in haproxy modes (idempotent — usually
  // a no-op since the DS already exists from the prior steady state;
  // creates it on first ever haproxy-mode entry).
  if (mode !== 'activeNodeOnly') {
    if (onProgress) {
      await onProgress({
        stepKey: 'create-haproxy-ds',
        pct: 75,
        text: 'Ensuring haproxy DaemonSet exists',
      });
    }
    await ensureHaproxyDaemonSetExists(apps);
  }

  // Step 3: Reconcile Service.spec.externalIPs (active node is NEVER
  // included — see comment block at the top of this function).
  if (db) {
    if (onProgress) {
      await onProgress({
        stepKey: 'reconcile-service-externalips',
        pct: 90,
        text: externalIps.length === 0
          ? 'Clearing stalwart-mail Service externalIPs (activeNodeOnly — Stalwart hostPort serves directly)'
          : `Reconciling stalwart-mail Service externalIPs to ${externalIps.join(', ')} (active node served via hostPort)`,
      });
    }
    await reconcileMailServiceExternalIPsByName(core, externalIps);
  }
}

/**
 * Set `stalwart-mail` Service.spec.externalIPs to match the active
 * port-exposure topology.
 *
 *   allServerNodes  → every server-role node IP (kube-proxy routes
 *                     from those IPs to the Stalwart pod via the
 *                     Service ClusterIP, in parallel with haproxy
 *                     hostPort traffic on the same nodes).
 *   thisNodeOnly    → JUST the active node's IP. Other nodes must
 *                     NOT route mail traffic — they have no haproxy
 *                     and the mail-stack-only-on-this-node contract
 *                     would be violated by leftover kube-proxy
 *                     iptables rules.
 *
 * Server-Side-Apply with our own field manager so the staging overlay's
 * Flux-managed externalIPs (single IP from `${STALWART_EXTERNAL_IP}`)
 * gets overwritten — and re-overwritten if Flux tries to revert it on
 * next reconcile. Field-manager conflicts return clean errors instead
 * of silent reverts.
 */
/**
 * Resolve a list of node names to their external (or internal-fallback)
 * IPs and SSA-apply them to Service.spec.externalIPs.
 * Same SSA semantics as the legacy mode-keyed variant below.
 */
async function reconcileMailServiceExternalIPsByName(
  core: import('@kubernetes/client-node').CoreV1Api,
  nodeNames: ReadonlyArray<string>,
): Promise<void> {
  type Node = { metadata?: { name?: string }; status?: { addresses?: Array<{ type?: string; address?: string }> } };
  const list = await core.listNode({}) as { items?: Node[] };
  const items = list.items ?? [];
  const nodeIp = (n: Node): string | null => {
    const a = n.status?.addresses ?? [];
    return a.find((x) => x.type === 'ExternalIP')?.address
      ?? a.find((x) => x.type === 'InternalIP')?.address
      ?? null;
  };
  const desiredIps: string[] = [];
  for (const name of nodeNames) {
    const node = items.find((x) => x.metadata?.name === name);
    const ip = node ? nodeIp(node) : null;
    if (ip && !desiredIps.includes(ip)) desiredIps.push(ip);
  }
  await core.patchNamespacedService(
    {
      namespace: 'mail',
      name: 'stalwart-mail',
      body: {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'stalwart-mail', namespace: 'mail' },
        spec: { externalIPs: desiredIps },
      },
    } as unknown as Parameters<typeof core.patchNamespacedService>[0],
    STALWART_EXTERNAL_IPS_PATCH,
  );
}

// ── Private helpers ────────────────────────────────────────────────────────────

/**
 * SSA-apply the Stalwart Deployment's container ports.
 *
 * The Stalwart Deployment manifest declares mail ports WITHOUT
 * hostPort (Phase 7 streamline rewrite). This function then SSA-
 * applies hostPort as a field-manager-owned claim, mode-dependent:
 *
 *   withHostPorts=true (thisNodeOnly mode):
 *     SSA-apply ports list WITH hostPort=containerPort on each mail
 *     port. fieldManager=platform-api.port-exposure claims the
 *     hostPort sub-field. Stalwart pod binds the node's external IP
 *     on each mail port.
 *
 *   withHostPorts=false (allServerNodes mode):
 *     SSA-apply ports list WITHOUT hostPort. Since the manifest
 *     doesn't declare hostPort either, no manager claims it after
 *     this apply — the field is unset and Stalwart binds only the
 *     containerPort inside the pod network. haproxy DaemonSet handles
 *     external traffic on every server node.
 *
 * `force: true` on the SSA-apply: the very first call after
 * deploying this code may find hostPort claimed by another manager
 * (e.g. a stale kustomize-controller ownership from before the
 * manifest rewrite). force=true reassigns ownership to
 * platform-api.port-exposure once; subsequent applies are idempotent.
 *
 * Mail-port list is canonical (MAIL_HOST_PORTS); we mirror the
 * manifest's port names/protocol for consistency.
 */
/**
 * SSA-apply hostPort=containerPort to every Stalwart mail port and
 * wait for the rollout. Post-2026-05-28 hairpin fix: Stalwart hostPort
 * is always-on in every mode (the active node serves via CNI portmap,
 * never via kube-proxy DNAT). The previous `withHostPorts=false` path
 * was removed when removeHostPortsFromDeployment became dead code.
 *
 * SSA `fieldManager=platform-api.port-exposure, force=true` claims the
 * hostPort sub-field on each mail port. Idempotent — the apiserver
 * computes no diff when the field is already at the desired value, so
 * back-to-back calls don't trigger spurious rollouts (but
 * waitForStalwartRollout below still polls — see the rollout-wait
 * note for the cost of that on the steady-state idempotent path).
 *
 * Mail-port list is canonical (mirrors k8s/base/stalwart-mail/stalwart/
 * deployment.yaml). Other container ports (mgmt-http :8080,
 * http-acme :80) stay owned by kustomize-controller's apply — SSA
 * merges per port name.
 */
async function addHostPortsToDeployment(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  const mailPortSpecs: Array<{ name: string; containerPort: number }> = [
    { name: 'smtp', containerPort: 25 },
    { name: 'submissions', containerPort: 465 },
    { name: 'submission', containerPort: 587 },
    { name: 'imap', containerPort: 143 },
    { name: 'imaps', containerPort: 993 },
    { name: 'sieve', containerPort: 4190 },
  ];

  const portsForPatch = mailPortSpecs.map((p) => ({
    name: p.name,
    containerPort: p.containerPort,
    protocol: 'TCP',
    hostPort: p.containerPort,
  }));

  const body = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: DEPLOYMENT_NAME, namespace: MAIL_NS },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'stalwart',
              ports: portsForPatch,
            },
          ],
        },
      },
    },
  };

  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NS,
      name: DEPLOYMENT_NAME,
      body: body as unknown as object,
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    STALWART_PORTS_PATCH,
  ).catch((err) => {
    throw new ApiError(
      'MAIL_DEPLOYMENT_PATCH_FAILED',
      `Failed to apply Stalwart Deployment hostPorts: ${(err as Error).message ?? String(err)}`,
      500,
    );
  });

  // Wait for rollout to complete before returning. When SSA produces
  // no diff this returns on the first poll; when there's a real diff
  // (first deploy, or after a manifest churn) the 90s budget covers
  // pod restart + local-path PVC re-attach + restore-state init.
  // Follow-up: short-circuit when the apiserver returned the same
  // metadata.resourceVersion (no diff applied) to skip the wait.
  await waitForStalwartRollout(apps);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create the haproxy DaemonSet if it doesn't exist; do nothing if it
 * already does. Idempotent — safe to call from a retry loop.
 *
 * The spec comes from buildHaproxyDaemonSet() so this function and
 * `getMailPortExposure`'s status read agree on the object's name +
 * namespace.
 */
async function ensureHaproxyDaemonSetExists(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  try {
    await apps.readNamespacedDaemonSet({
      namespace: HAPROXY_DS_NAMESPACE,
      name: HAPROXY_DS_NAME,
    });
    // Already present — do not overwrite. Operator can `kubectl delete`
    // to force a re-create from the latest builder output.
    return;
  } catch (err) {
    if (!isNotFound(err)) {
      throw new ApiError(
        'MAIL_HAPROXY_DS_READ_FAILED',
        `Failed to read haproxy DaemonSet: ${(err as Error).message ?? String(err)}`,
        500,
      );
    }
    // 404 — fall through to create.
  }

  const body = buildHaproxyDaemonSet();
  try {
    await apps.createNamespacedDaemonSet({
      namespace: HAPROXY_DS_NAMESPACE,
      body: body as unknown as Parameters<typeof apps.createNamespacedDaemonSet>[0]['body'],
    });
  } catch (err) {
    // Race: someone else created it between our read + create. Treat
    // as success since the desired state is "DS exists".
    if (isConflict(err)) return;
    throw new ApiError(
      'MAIL_HAPROXY_DS_CREATE_FAILED',
      `Failed to create haproxy DaemonSet: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }
}

/**
 * Delete the haproxy DaemonSet. Idempotent — 404 is treated as success.
 *
 * Uses propagationPolicy=Foreground so the apiserver blocks the
 * delete-call until child pods are gone. Without this, the default
 * Background GC returns immediately and haproxy pods can keep binding
 * hostPorts 25/465/587/143/993/4190 for their grace period (~10s
 * normally; can be longer). If the symmetric flip to thisNodeOnly
 * then patches the Stalwart Deployment to RE-ADD hostPorts, the new
 * Stalwart pod lands on a node where haproxy is still alive and
 * fails to bind those ports.
 *
 * Foreground GC is exactly what `kubectl delete ds --wait=true`
 * does, and what the symmetric streamline-fix path needs.
 *
 * After the delete returns we poll once to confirm pods are truly
 * gone (Foreground guarantees this, but the SDK won't throw on
 * timeout — we set a 60s cap and surface MAIL_HAPROXY_DS_DELETE_TIMEOUT).
 */
async function ensureHaproxyDaemonSetAbsent(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  try {
    await apps.deleteNamespacedDaemonSet({
      namespace: HAPROXY_DS_NAMESPACE,
      name: HAPROXY_DS_NAME,
      propagationPolicy: 'Foreground',
    });
  } catch (err) {
    if (isNotFound(err)) return;
    throw new ApiError(
      'MAIL_HAPROXY_DS_DELETE_FAILED',
      `Failed to delete haproxy DaemonSet: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }
  // Belt-and-suspenders: poll until the DaemonSet is fully gone.
  // Foreground propagation makes the delete-call wait for child pods,
  // but tenant-side cancellation or apiserver hiccups could short-cut
  // that. Verify empirically.
  await waitForHaproxyDaemonSetGone(apps, 60_000);
}

async function waitForHaproxyDaemonSetGone(
  apps: import('@kubernetes/client-node').AppsV1Api,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await apps.readNamespacedDaemonSet({
        namespace: HAPROXY_DS_NAMESPACE,
        name: HAPROXY_DS_NAME,
      });
      // Still present — wait and retry.
      await sleepMs(2_000);
      continue;
    } catch (err) {
      if (isNotFound(err)) return; // gone — success
      throw new ApiError(
        'MAIL_HAPROXY_DS_DELETE_VERIFY_FAILED',
        `Could not verify haproxy DaemonSet deletion: ${(err as Error).message ?? String(err)}`,
        500,
      );
    }
  }
  throw new ApiError(
    'MAIL_HAPROXY_DS_DELETE_TIMEOUT',
    `haproxy DaemonSet did not finish deleting within ${Math.floor(timeoutMs / 1000)}s — some pods may still be binding hostPorts`,
    504,
  );
}

function isConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; statusCode?: number; body?: { code?: number } };
  const code = e.code ?? e.statusCode ?? e.body?.code;
  return code === 409;
}

// Combined mail-stack PVC (Stalwart RocksDB + Bulwark data). A single
// `local-path` RWO volume whose PV is pinned to exactly one node via
// `spec.nodeAffinity` — and that pinned node is where Stalwart MUST run.
const MAIL_PVC_NAME = 'mail-stack-data';

/**
 * Derive the node the mail-stack PVC is bound to, used as a FALLBACK for
 * the active mail node when `system_settings.mail_active_node` is unset.
 *
 * On a fresh multi-node bootstrap the DB column is never seeded (it is
 * only written on a migration run or by the placement self-heal once a
 * Stalwart pod is Running). With activeNode=null the haproxy-placement
 * resolver can't exclude the node Stalwart needs, so haproxy gets
 * labelled onto EVERY server node — including the one Stalwart must
 * schedule on — and the two fight for hostPort 25/465/587/143/993/4190.
 * Stalwart then stays Pending (observed on the 2026-05-31 staging cold
 * multi-node re-bootstrap: stalwart-mail Pending ~2h).
 *
 * The PVC is `local-path` RWO, so its bound PV is pinned to a single
 * node via `kubernetes.io/hostname` node-affinity — exactly the node
 * Stalwart runs on. Prefer the PVC's `volume.kubernetes.io/selected-node`
 * annotation (set by the provisioner at bind time); fall back to the PV
 * node-affinity hostname (mirrors migration.ts:readActualPvcBoundNode).
 *
 * Best-effort: returns null when the PVC/PV doesn't exist yet or carries
 * no hostname affinity. Callers must treat null as "no active node
 * derived" and stay safe (the single-node guard + null-active handling
 * in the pure resolvers prevent any all-nodes-haproxy regression).
 */
async function deriveActiveNodeFromMailPvc(
  core: import('@kubernetes/client-node').CoreV1Api,
): Promise<string | null> {
  try {
    const pvc = await core.readNamespacedPersistentVolumeClaim({
      name: MAIL_PVC_NAME,
      namespace: MAIL_NS,
    }) as { metadata?: { annotations?: Record<string, string> }; spec?: { volumeName?: string } };
    const selectedNode = pvc.metadata?.annotations?.['volume.kubernetes.io/selected-node'];
    if (selectedNode) return selectedNode;
    // Older PVCs without the annotation — read the bound PV's nodeAffinity.
    const pvName = pvc.spec?.volumeName;
    if (!pvName) return null;
    const pv = await core.readPersistentVolume({ name: pvName }) as {
      spec?: {
        nodeAffinity?: {
          required?: {
            nodeSelectorTerms?: ReadonlyArray<{
              matchExpressions?: ReadonlyArray<{ key?: string; values?: string[] }>;
            }>;
          };
        };
      };
    };
    // Scan ALL terms × ALL matchExpressions for key === 'kubernetes.io/hostname'.
    // local-path always uses that key; scanning (rather than [0][0]) is
    // defensive against PVs that also carry a zone matchExpression.
    const terms = pv.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? [];
    for (const term of terms) {
      for (const expr of term.matchExpressions ?? []) {
        if (expr.key === 'kubernetes.io/hostname' && expr.values && expr.values.length > 0) {
          return expr.values[0];
        }
      }
    }
    return null;
  } catch (err) {
    if (isNotFound(err)) return null;
    // Other read errors are non-fatal for the fallback — surface null and
    // let the resolver's null-active safety handling take over.
    return null;
  }
}
