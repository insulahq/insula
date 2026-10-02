/**
 * Deployment status reconciler.
 *
 * Checks actual K8s Deployment/CronJob status and updates DB accordingly.
 * Detects CrashLoopBackOff, OOMKilled, ImagePullBackOff.
 */

import { eq, inArray } from 'drizzle-orm';
import { deployments, catalogEntries, tenants } from '../../db/schema.js';
import { getDeploymentStatus } from './k8s-deployer.js';
import type { ComponentPodStatus, DeployComponentInput } from './k8s-deployer.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import { reconcileCustomRow, applyReconcileOutcome } from '../custom-deployments/reconcile.js';
import { buildWorkloadSnapshot, type WorkloadSnapshot } from './workload-snapshot.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReconcileResult {
  readonly checked: number;
  readonly updated: number;
  readonly errors: readonly string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Max time a deployment can stay in pending/deploying before escalating to failed */
const STALE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

/**
 * How long a `stopped` row must sit untouched before the reconciler will
 * believe the cluster over it WITHOUT further evidence. Comfortably longer than
 * the gap between writing the status and scaling the workload down, so a stop
 * in progress is never undone. {@link stoppedRowMayChange} has the evidence
 * that lets a row converge sooner.
 */
export const STOPPED_RECHECK_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Allowance for the two clocks being compared: a row's `updated_at` is stamped
 * by platform-api, a pod's `creationTimestamp` by the apiserver. Same cluster,
 * NTP-synced — this only has to absorb skew, not a scheduling delay.
 */
const POD_CLOCK_SKEW_MS = 10 * 1000;

// ─── Map K8s phase to DB status ─────────────────────────────────────────────

function phaseToDbStatus(phase: string): 'running' | 'stopped' | 'pending' | 'failed' {
  switch (phase) {
    case 'running': return 'running';
    case 'stopped': return 'stopped';
    case 'failed': return 'failed';
    case 'starting': return 'pending';
    case 'not_deployed': return 'pending';
    default: return 'pending';
  }
}

// ─── Component Resolution (duplicated from service.ts to avoid circular deps) ─

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return null; } }
  return value as T;
}

function resolveComponentsForReconcile(
  entry: typeof catalogEntries.$inferSelect,
): DeployComponentInput[] {
  const baseComponents = (parseJson<unknown[]>(entry.components) ?? []) as Array<{
    name: string;
    type: 'deployment' | 'statefulset' | 'cronjob' | 'job';
    image: string;
    ports?: Array<{ port: number; protocol: string; ingress?: boolean }>;
    optional?: boolean;
    schedule?: string;
  }>;

  if (baseComponents.length === 0) {
    return [{
      name: entry.code,
      type: 'deployment',
      image: entry.image ?? `${entry.code}:latest`,
      ports: [{ port: 8080, protocol: 'tcp', ingress: true }],
      optional: false,
    }];
  }

  return baseComponents.map(comp => ({
    name: comp.name,
    type: comp.type,
    image: comp.image,
    ports: comp.ports ?? [],
    optional: comp.optional ?? false,
    schedule: comp.schedule,
  }));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Reconcile all deployments that are in a non-terminal DB state
 * (running, pending, deploying) against actual K8s cluster state.
 */
/**
 * Should this tick write to the row at all?
 *
 * The reconciler runs constantly over every active deployment, so it only
 * writes when something actually moved. That guard used to consider the status,
 * the transitional message and the node — which left one hole: a row that was
 * ALREADY `running` when something wrote an error to it never transitions
 * again, so the "clear errors when status recovers" branch was unreachable and
 * the failure stayed on the row for good. A tenant editing resources or env
 * vars then kept seeing a banner describing an attempt that had long since
 * been superseded.
 *
 * Split out from the loop so the decision can be tested on its own — the loop
 * around it needs a live db, k8s and catalog graph, which is exactly the shape
 * of test that would have passed against the hole.
 */
export function needsStatusWrite(
  current: {
    readonly status: string;
    readonly statusMessage: string | null;
    readonly lastError: string | null;
    readonly currentNodeName: string | null;
  },
  next: {
    readonly status: string;
    readonly statusMessage: string | null;
    readonly nodeName: string | null;
  },
): boolean {
  if (next.status !== current.status) return true;
  if (next.statusMessage !== current.statusMessage) return true;
  if (next.nodeName !== current.currentNodeName) return true;
  // Healthy, but still carrying the last failure. Nothing else will ever clear
  // it, because nothing else is going to change.
  return next.status === 'running'
    && (current.lastError !== null || current.statusMessage !== null);
}

/**
 * Is this workload in the hands of a storage operation right now?
 *
 * A storage operation (snapshot restore, resize, fsck, suspend, the
 * workload-health heal, …) quiesces the tenant: it stamps the hold annotation
 * on each Deployment and scales it to 0, does its work, scales it back up and
 * releases the hold only once the workload is available again. Read during that
 * window, the cluster says `replicas: 0` — which the phase logic reports as
 * `stopped`, exactly what a user's Stop looks like.
 *
 * Recording that was the bug: a 15-second tick always lands inside a restore,
 * so the row flipped to `stopped` minutes into it. After the restore the pods
 * were back, but a `stopped` row is not re-examined for {@link STOPPED_RECHECK_MS}
 * — so the tenant saw their restored apps as STOPPED for up to ten minutes, and
 * every panel that reads usage only for `running` apps showed none.
 *
 * So the row is left alone while BOTH hold: the workload carries the hold, AND
 * the tenant has an operation in flight. Requiring the second is deliberate.
 * A hold that outlives its operation (the op failed, and unquiesce keeps the
 * hold for quiesce-watchdog) marks a workload that is genuinely down; that one
 * must be reported as it is, not frozen at whatever the row said before. Same
 * rule workload-health and quiesce-watchdog already apply: an in-flight
 * operation owns the namespace.
 *
 * `activeAtTickStart` is the tenant read taken once per tick. A held workload
 * whose tenant looked idle then is re-checked against the database: the tick
 * walks rows one by one, and wherever it reads the cluster per row (custom
 * containers always; catalog apps when the workload snapshot failed) an
 * operation can start between that tenant read and this row's read. Every
 * operation records itself on the tenant BEFORE quiesce stamps the hold, so a
 * hold seen now with no operation on the re-read really has outlived it. The
 * re-read only happens for a held workload, which is rare.
 */
export async function storageOpOwnsWorkload(
  db: Database,
  tenantId: string,
  components: readonly Pick<ComponentPodStatus, 'heldByStorageOp'>[],
  activeAtTickStart: ReadonlySet<string>,
): Promise<boolean> {
  if (!components.some((c) => c.heldByStorageOp === true)) return false;
  if (activeAtTickStart.has(tenantId)) return true;
  const [t] = await db
    .select({ activeStorageOpId: tenants.activeStorageOpId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return Boolean(t?.activeStorageOpId);
}

/**
 * May a row that says `stopped` be moved to `next` now?
 *
 * `stopped` is usually INTENT, and `updateDeployment` writes it BEFORE it scales
 * the workload down — so for a moment the pods are still Ready, and believing
 * the cluster then would undo a stop in progress. That is why a stopped row
 * used to be ignored outright until it was {@link STOPPED_RECHECK_MS} old.
 *
 * Age is one proof that no stop is in flight. The other is the pods themselves:
 * a stop in progress is acting on pods that already existed when the row was
 * written. If EVERY live pod of a running workload was created after that write,
 * something brought the workload back since — a restore, a resume, a recovery —
 * and the row is simply stale. Waiting out the remainder of ten minutes then
 * only prolongs a wrong answer.
 *
 * Only a move to `running` takes that shortcut: it is the one transition the
 * evidence fully supports (pods exist, are newer, and are Ready). Anything else
 * waits for age, as before.
 *
 * @param oldestPodCreatedAtMs  one entry per running Deployment component: the
 *   creation time of its oldest live pod, or null/undefined when unknown.
 */
export function stoppedRowMayChange(
  updatedAt: Date,
  next: string,
  oldestPodCreatedAtMs: ReadonlyArray<number | null | undefined>,
  now: number = Date.now(),
): boolean {
  if (now - updatedAt.getTime() >= STOPPED_RECHECK_MS) return true;
  if (next !== 'running' || oldestPodCreatedAtMs.length === 0) return false;
  const stoppedAt = updatedAt.getTime();
  return oldestPodCreatedAtMs.every(
    (ms) => typeof ms === 'number' && ms > stoppedAt + POD_CLOCK_SKEW_MS,
  );
}

/**
 * Minimal logger surface, matching the shape the bandwidth meter uses. Kept
 * optional so the existing tests can call the reconciler with two arguments.
 */
export interface ReconcileLogger {
  warn?: (obj: unknown, msg?: string) => void;
}

export async function reconcileDeploymentStatuses(
  db: Database,
  k8s: K8sClients,
  logger: ReconcileLogger = {},
): Promise<ReconcileResult> {
  let checked = 0;
  let updated = 0;
  const errors: string[] = [];

  // Include `failed` so a deployment that recovers (e.g. after an RBAC
  // patch or a dependency coming up late) can flip back to `running`
  // without manual intervention. Without this, once a row is marked
  // failed the reconciler ignores it forever and the UI shows it as
  // broken even though the pods are healthy.
  //
  // ★ And `stopped`, for exactly the same reason.
  //
  // Excluding it made the status a one-way door: a row marked stopped was
  // never looked at again, so a deployment whose pods came back stayed
  // "stopped" forever. Observed on a test cluster — replicas=1, readyReplicas=1,
  // database still stopped — which is not a cosmetic disagreement. Everything
  // that asks "what is live?" by filtering `status = 'running'` skips that
  // workload while it consumes real CPU and memory: the CPU-tier dry run and
  // migration (ADR-062) and the deployments list API among them.
  //
  // EVERY stopped row is fetched; whether it may move is decided per row by
  // stoppedRowMayChange, which needs the pods to decide. That gate is what
  // protects a stop in progress (`updateDeployment` writes status='stopped'
  // BEFORE it scales to zero). It used to be an `updated_at` bound in this
  // query, which could not see the pods — so a row wrongly marked stopped sat
  // there for the full window even while its freshly restored pods served.
  // Cost: nearly every stopped row was already past that bound, and with the
  // workload snapshot a row is an in-memory lookup, not an API call.
  const activeDeployments = await db
    .select()
    .from(deployments)
    .where(inArray(deployments.status, ['running', 'pending', 'deploying', 'failed', 'stopped']));

  if (activeDeployments.length === 0) {
    return { checked: 0, updated: 0, errors: [] };
  }

  // One pair of cluster-wide LISTs replaces ~2 API round-trips per component
  // per tick. The client opens a fresh TLS connection per request (see
  // workload-snapshot.ts), so request count — not payload size — is the cost.
  //
  // A failure here is NOT fatal: getDeploymentStatus falls back to its
  // per-call reads when handed no snapshot, so a bad cycle costs request
  // volume, never correctness. It is logged because silently reverting to the
  // old behaviour is a regression nobody would otherwise notice.
  let snapshot: WorkloadSnapshot | undefined;
  try {
    snapshot = await buildWorkloadSnapshot(k8s);
  } catch (err) {
    logger.warn?.(
      { err: err instanceof Error ? err.message : String(err) },
      'status-reconciler: cluster workload snapshot failed — falling back to per-deployment reads this cycle',
    );
  }

  // Group deployments by tenant for namespace lookup
  const tenantIds = [...new Set(activeDeployments.map(d => d.tenantId))];
  // Read AFTER the workload snapshot, so an operation that had already started
  // when the snapshot was taken is visible here too. One that starts later is
  // not in the snapshot either — the snapshot predates its scale-down. Rows
  // read from the cluster one by one can still catch a later one mid-quiesce;
  // storageOpOwnsWorkload re-checks the tenant for exactly those.
  const tenantRows = await db
    .select({
      id: tenants.id,
      kubernetesNamespace: tenants.kubernetesNamespace,
      activeStorageOpId: tenants.activeStorageOpId,
    })
    .from(tenants)
    .where(inArray(tenants.id, tenantIds));

  const namespaceMap = new Map<string, string>();
  const tenantsWithActiveStorageOp = new Set<string>();
  for (const c of tenantRows) {
    if (c.kubernetesNamespace) {
      namespaceMap.set(c.id, c.kubernetesNamespace);
    }
    if (c.activeStorageOpId) tenantsWithActiveStorageOp.add(c.id);
  }

  // Pre-fetch all catalog entries needed. Custom deployments have
  // catalogEntryId=null (ADR-036); filter them out of the lookup —
  // PR-2 introduces a custom-deployment-specific reconciler path.
  const catalogEntryIds = [...new Set(
    activeDeployments
      .map(d => d.catalogEntryId)
      .filter((id): id is string => id !== null),
  )];
  const entryRows = catalogEntryIds.length > 0
    ? await db
      .select()
      .from(catalogEntries)
      .where(inArray(catalogEntries.id, catalogEntryIds))
    : [];

  const entryMap = new Map<string, typeof catalogEntries.$inferSelect>();
  for (const e of entryRows) {
    entryMap.set(e.id, e);
  }

  for (const deployment of activeDeployments) {
    const namespace = namespaceMap.get(deployment.tenantId);
    if (!namespace) continue;

    // Custom deployments take a dedicated reconcile path that reads
    // a single Deployment object (no catalog component model) and
    // populates the image-audit table.
    if (deployment.source === 'custom') {
      checked++;
      try {
        const outcome = await reconcileCustomRow(db, k8s, deployment, namespace);
        if (await storageOpOwnsWorkload(
          db, deployment.tenantId, [{ heldByStorageOp: outcome.heldByStorageOp }], tenantsWithActiveStorageOp,
        )) continue;
        if (deployment.status === 'stopped' && outcome.status !== 'stopped'
          && !stoppedRowMayChange(
            deployment.updatedAt,
            outcome.status,
            outcome.status === 'running' ? [outcome.oldestPodCreatedAtMs] : [],
          )) continue;
        const wasChanged = await applyReconcileOutcome(db, deployment.id, deployment, outcome);
        if (wasChanged) updated++;
      } catch (err) {
        errors.push(`${deployment.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    // Defensive: a `catalog`-source row with a NULL catalog_entry_id
    // should never exist (the XOR constraint rejects it at INSERT
    // time), but if one ever slips through we skip rather than NPE.
    if (deployment.catalogEntryId === null) continue;
    const entry = entryMap.get(deployment.catalogEntryId);
    if (!entry) continue;

    checked++;

    try {
      const components = resolveComponentsForReconcile(entry);
      const k8sStatus = await getDeploymentStatus(k8s, namespace, deployment.name, components, snapshot);
      if (await storageOpOwnsWorkload(db, deployment.tenantId, k8sStatus.components, tenantsWithActiveStorageOp)) {
        continue;
      }
      let newDbStatus = phaseToDbStatus(k8sStatus.phase);
      let timeoutMessage: string | null = null;

      if (deployment.status === 'stopped' && newDbStatus !== 'stopped'
        && !stoppedRowMayChange(
          deployment.updatedAt,
          newDbStatus,
          k8sStatus.components
            .filter((c) => c.type === 'deployment' && c.phase === 'running')
            .map((c) => c.oldestPodCreatedAtMs),
        )) {
        continue;
      }

      // Staleness timeout: if deployment has been in pending/deploying for too long, escalate to failed
      if (newDbStatus === 'pending' && (deployment.status === 'pending' || deployment.status === 'deploying')) {
        const age = Date.now() - deployment.updatedAt.getTime();
        if (age > STALE_TIMEOUT_MS) {
          newDbStatus = 'failed';
          const startingComponent = k8sStatus.components.find(c => c.phase === 'starting' || c.phase === 'not_deployed');
          const detail = startingComponent?.message ?? 'No progress detected';
          timeoutMessage = `Timed out after 60 minutes: ${detail}`;
        }
      }

      // Store status message for transitioning states (shown in UI tiles)
      const statusMessage = newDbStatus === 'pending'
        ? (k8sStatus.components.find(c => c.message)?.message ?? null)
        : null;

      // Capture host node — first scheduled node across all components.
      // The "Node" column on the admin Deployments / Installed Applications
      // tables reads this. Multi-replica deployments report the first
      // observed node only (see k8s-deployer.ts comment).
      const observedNode = k8sStatus.components
        .map((c) => c.nodeName)
        .find((n): n is string => Boolean(n)) ?? null;

      const nodeChanged = observedNode !== (deployment.currentNodeName ?? null);

      if (needsStatusWrite(
        {
          status: deployment.status,
          statusMessage: deployment.statusMessage ?? null,
          lastError: deployment.lastError ?? null,
          currentNodeName: deployment.currentNodeName ?? null,
        },
        { status: newDbStatus, statusMessage, nodeName: observedNode },
      )) {
        const updateValues: Record<string, unknown> = { status: newDbStatus, statusMessage };
        if (nodeChanged) updateValues.currentNodeName = observedNode;

        // Store user-friendly error message when status changes to failed.
        // We persist the OperatorError envelope as JSON in the lastError
        // column so the UI can render the full structured panel —
        // remediation steps, raw diagnostics, retry-ability — instead
        // of a single string. Backwards-compatible: legacy callers
        // that read lastError as a plain string still get a reasonable
        // first line because we prefix the JSON with the title.
        if (newDbStatus === 'failed') {
          const { translateOperatorError } = await import('../../shared/operator-error.js');
          let envelope;
          if (timeoutMessage) {
            envelope = translateOperatorError(timeoutMessage, { kind: 'workload' });
          } else {
            const failedComponent = k8sStatus.components.find(c => c.phase === 'failed');
            envelope = translateOperatorError(failedComponent?.message ?? 'No detail available', { kind: 'workload' });
          }
          updateValues.lastError = JSON.stringify(envelope);
          updateValues.statusMessage = null;
        } else if (newDbStatus === 'running') {
          // Clear errors when status recovers
          updateValues.lastError = null;
          updateValues.statusMessage = null;
        }

        await db.update(deployments).set(updateValues).where(eq(deployments.id, deployment.id));
        updated++;
      }
    } catch (err) {
      errors.push(`${deployment.name} (${deployment.id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { checked, updated, errors };
}
