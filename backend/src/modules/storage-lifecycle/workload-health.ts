/**
 * Tenant workload availability reconciler — detect, auto-heal, then alert.
 *
 * WHY THIS EXISTS
 * ---------------
 * Nothing in the platform watched whether a tenant's workloads were actually
 * RUNNING. A production tenant once had all four Deployments at
 * `spec.replicas=1` / `availableReplicas=0` for 18h38m and every existing check
 * passed:
 *
 *   • `namespace-integrity` audits only MISSING objects — the namespace, PVC,
 *     ResourceQuota and NetworkPolicy were all present, so it found nothing.
 *   • the PVC was `Bound`; the Longhorn volume `attached` / `healthy`.
 *   • the node was `Ready`; nothing was OOM-killed; no volume was full.
 *   • the storage-lifecycle module emitted no notifications at all.
 *
 * The actual fault was a stale CSI staging directory: after a host I/O stall
 * shut the volume's XFS log down, every mount failed with
 * `mkdir …/globalmount: file exists`, 571 times, on a 2m2s backoff that kubelet
 * never escapes. A tenant can be 100% down while every component reports
 * healthy — so the only honest check is the one this file makes: does the
 * workload have the replicas its spec asks for?
 *
 * WHAT IT DOES, IN ORDER
 * ----------------------
 *   1. One cluster-wide Deployment LIST. For each tenant Deployment with
 *      `spec.replicas > 0` and `availableReplicas < spec.replicas`, open or
 *      refresh an episode row; for each healthy one, close any open episode.
 *   2. Past the grace window, try to HEAL: a controlled re-stage of the volume
 *      (scale every PVC consumer to 0 → wait for Longhorn `detached` → scale
 *      back up, verified). That is precisely the cycle that cleared the stale
 *      globalmount in the incident — there it happened by accident, as a side
 *      effect of an operator running fsck. Here it is the deliberate remedy.
 *   3. Only when healing has been TRIED and FAILED does it alert: the operator
 *      on every channel (`admin.tenant_workloads_down`), the tenant in-app
 *      (`tenant.workloads_down`). An alert that fires before auto-heal has run
 *      trains people to ignore it.
 *
 * SAFETY PROPERTIES
 * -----------------
 *   • Never touches a tenant with an in-flight storage op — the orchestrator
 *     owns the namespace then.
 *   • Never touches a non-active tenant: scaled-to-0 IS the designed state for
 *     suspended and archived tenants. Cf. an idle resting state is not a fault.
 *   • Grace window before acting. A rollout, an image pull and a node reboot all
 *     look like "down" for a few seconds and none of them is a fault.
 *   • Bounded heal attempts with exponential backoff, so a genuinely broken
 *     tenant is not scaled up and down forever.
 *   • HA-safe with no lease: the scheduler runs on every api replica, so each
 *     heal is CLAIMED with a single conditional UPDATE. Exactly one replica
 *     wins; the losers do nothing.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';

/**
 * How long a workload may be unavailable before it counts as an outage.
 *
 * Long enough to cover the honest slow paths: a Longhorn re-attach that loses
 * kubelet's exponential CSI backoff race (measured 11s and 19s on production),
 * a cold image pull, a rolling update. Short enough that an operator hears about
 * a real outage in minutes rather than hours.
 */
const GRACE_MS = 8 * 60 * 1000;

/** Heal attempts before we stop trying and leave it to the operator. */
const MAX_HEAL_ATTEMPTS = 3;

/** Backoff between heal attempts on the same episode: 10min, 40min, 160min. */
const HEAL_BACKOFF_BASE_MS = 10 * 60 * 1000;

/** Re-alert ladder for a sustained, unhealed outage: 1h → 6h → daily. */
const NOTIFY_LADDER_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

/** Cleared episodes are a short audit tail. */
const CLEARED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export interface WorkloadHealthResult {
  readonly observedDown: number;
  readonly episodesOpened: number;
  readonly episodesCleared: number;
  readonly healAttempted: number;
  readonly healed: number;
  readonly alerted: number;
}

export type HealReason = 'volume_attach' | 'quota_rejected' | 'unschedulable' | 'image' | 'crash'
  | 'stranded_at_zero' | 'unknown';

/**
 * Translate what the cluster says into a cause the operator can act on, and the
 * healer can branch on.
 *
 * Order matters: a quota rejection and a volume failure can both be present
 * (the ReplicaSet refuses to create a pod that the volume could not have
 * mounted anyway), and the quota is the one a human has to decide about.
 */
export function classifyUnavailability(
  replicaFailure: string | null,
  podMessages: readonly string[],
): { reason: HealReason; detail: string | null; label: string } {
  const all = [replicaFailure ?? '', ...podMessages].join(' | ');
  const detail = all.trim() ? all.trim().slice(0, 1000) : null;

  if (/exceeded quota|forbidden:.*quota/i.test(all)) {
    return {
      reason: 'quota_rejected',
      detail,
      label: 'the namespace ResourceQuota refused to admit the pod',
    };
  }
  // The stale-staging-directory failure. kubelet retries this forever on a
  // 2m2s backoff and never repairs it; only a full detach + re-stage does.
  if (/globalmount.*file exists|failed to create dir.*globalmount/i.test(all)) {
    return {
      reason: 'volume_attach',
      detail,
      label: 'a stale CSI staging directory is blocking every mount (kubelet cannot self-repair this)',
    };
  }
  if (/not ready for workloads|AttachVolume\.Attach failed|FailedAttachVolume|FailedMount|volume .* not (?:yet )?attached/i.test(all)) {
    return { reason: 'volume_attach', detail, label: 'the storage volume would not attach or mount' };
  }
  if (/Insufficient|didn't match|had taint|nodes are available|Unschedulable/i.test(all)) {
    return { reason: 'unschedulable', detail, label: 'no node could accept the pod' };
  }
  if (/ImagePullBackOff|ErrImagePull|manifest unknown|pull access denied/i.test(all)) {
    return { reason: 'image', detail, label: 'the container image could not be pulled' };
  }
  if (/CrashLoopBackOff|back-off .* restarting failed container|OOMKilled/i.test(all)) {
    return { reason: 'crash', detail, label: 'the container keeps crashing on startup' };
  }
  return { reason: 'unknown', detail, label: 'the pod did not become ready' };
}

/** Plain-language cause for a reason slug that did not come from cluster text. */
function labelForReason(reason: HealReason): string | null {
  if (reason === 'stranded_at_zero') {
    return 'a storage operation scaled it down and never brought it back up';
  }
  return null;
}

/**
 * Is this a cause a volume re-stage can plausibly fix?
 *
 * The heal action is disruptive — the tenant PVC is RWO, so every consumer has
 * to go to 0 for the volume to detach, which briefly takes down the workloads in
 * that namespace that are still HEALTHY. That price is worth paying to clear a
 * stuck mount. It is not worth paying for a cause the re-stage cannot touch: a
 * bad image reference, a crash-looping container and an unschedulable pod all
 * come back in exactly the same state, so bouncing the namespace turns a partial
 * outage into a total one and changes nothing. Those go straight to the operator.
 */
export function isHealable(reason: HealReason): boolean {
  switch (reason) {
    case 'volume_attach':      // a stale staging dir / stuck attachment — the whole point
    case 'stranded_at_zero':   // restore from the op snapshot
    case 'quota_rejected':     // a still-terminating pod holding the quota frees up
    case 'unknown':            // no diagnosis; one bounded attempt is reasonable
      return true;
    case 'image':              // needs a corrected image reference
    case 'crash':              // needs a code or limits change
    case 'unschedulable':      // needs capacity, a taint change or an unpin
      return false;
  }
}

/** What to tell the operator to go and do, per cause. */
function recommendedAction(reason: HealReason): string {
  switch (reason) {
    case 'stranded_at_zero':
      return 'The tenant is parked at 0 replicas by a storage operation that did not finish. '
        + 'Auto-heal restores from the operation\u2019s persisted replica snapshot; if that keeps failing, '
        + 'use Clear failed state on the tenant\u2019s storage page, then check the ResourceQuota has room.';
    case 'quota_rejected':
      return 'Raise the tenant’s plan limits or free memory in the namespace — the pod cannot be admitted until it fits. '
        + 'Note that a still-terminating pod counts against the quota, so a restore can need roughly double the headroom for a moment.';
    case 'volume_attach':
      return 'Check the kubelet journal for this PV (`journalctl -u k3s | grep <pv-name>`) and count MountDevice succeeded vs failed. '
        + 'A stale staging directory needs the volume fully detached and re-staged; auto-heal already tried exactly that.';
    case 'unschedulable':
      return 'No node can fit or tolerate the pod — check node capacity, taints and any node pin on the tenant.';
    case 'image':
      return 'Verify the image reference and registry credentials for this workload.';
    case 'crash':
      return 'The image starts and dies — read the container log; if it is OOMKilled, its memory limit is too low.';
    default:
      return 'Inspect the Deployment, its ReplicaSet conditions and its pod events in the tenant namespace.';
  }
}

interface DeploymentView {
  namespace: string;
  name: string;
  desired: number;
  available: number;
  replicaFailure: string | null;
  held: boolean;
}

async function listTenantDeployments(k8s: K8sClients): Promise<DeploymentView[]> {
  const list = await (k8s.apps as unknown as {
    listDeploymentForAllNamespaces: (a?: { labelSelector?: string }) => Promise<{
      items?: Array<{
        metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> };
        spec?: { replicas?: number };
        status?: { availableReplicas?: number; conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }> };
      }>;
    }>;
  }).listDeploymentForAllNamespaces({});
  const out: DeploymentView[] = [];
  for (const d of list.items ?? []) {
    const namespace = d.metadata?.namespace;
    const name = d.metadata?.name;
    if (!namespace || !name) continue;
    if (!namespace.startsWith('tenant-')) continue;
    const cond = (d.status?.conditions ?? []).find((c) => c.type === 'ReplicaFailure' && c.status === 'True');
    out.push({
      namespace,
      name,
      desired: d.spec?.replicas ?? 0,
      available: d.status?.availableReplicas ?? 0,
      replicaFailure: cond ? `${cond.reason ?? 'ReplicaFailure'}: ${(cond.message ?? '').slice(0, 300)}` : null,
      held: d.metadata?.annotations?.[STORAGE_QUIESCED_ANNOTATION] === 'true',
    });
  }
  return out;
}

/** Pod-level events for a namespace, which is where FailedMount/globalmount shows up. */
async function podMessagesFor(k8s: K8sClients, namespace: string): Promise<string[]> {
  const msgs: string[] = [];
  try {
    const pods = await k8s.core.listNamespacedPod({ namespace } as never) as {
      items?: Array<{
        status?: {
          phase?: string;
          conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
          containerStatuses?: Array<{ state?: { waiting?: { reason?: string; message?: string } } }>;
        };
      }>;
    };
    for (const p of pods.items ?? []) {
      if (p.status?.phase === 'Succeeded') continue;
      for (const c of p.status?.conditions ?? []) {
        if (c.status === 'False' && c.message) msgs.push(`${c.reason ?? c.type}: ${c.message}`);
      }
      for (const cs of p.status?.containerStatuses ?? []) {
        const w = cs.state?.waiting;
        if (w?.reason) msgs.push(`${w.reason}: ${w.message ?? ''}`);
      }
    }
  } catch { /* best-effort enrichment only */ }
  try {
    const ev = await (k8s.core as unknown as {
      listNamespacedEvent: (a: { namespace: string }) => Promise<{
        items?: Array<{ type?: string; reason?: string; message?: string }>;
      }>;
    }).listNamespacedEvent({ namespace });
    for (const e of ev.items ?? []) {
      if (e.type !== 'Warning' || !e.message) continue;
      msgs.push(`${e.reason ?? 'Warning'}: ${e.message}`);
    }
  } catch { /* events may be rotated or RBAC-restricted */ }
  return msgs.slice(0, 20);
}

/**
 * Heal by re-staging the volume: scale every PVC consumer to 0, wait for
 * Longhorn to report `detached`, then scale back up and CONFIRM availability.
 *
 * This single action covers all three observed causes that are actually
 * fixable from here:
 *   • a stale CSI staging dir — only a full detach clears it;
 *   • a volume stuck mid-attach — the detach resets the attachment tickets;
 *   • a quota rejection caused by a still-terminating pod holding its memory —
 *     the wait lets it finish before the replacement is created.
 *
 * It deliberately does NOT try to fix a cause it cannot — see `isHealable`.
 *
 * COST: the tenant PVC is RWO, so every consumer must go to 0 for the volume to
 * detach. In a namespace where only one of four workloads is down, healing
 * briefly takes the other three down too. That is why it is gated on the cause,
 * on the grace window, and on a bounded attempt budget.
 */
async function healNamespace(
  db: Database,
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
  strandedAtZero: boolean,
  tenantId: string,
): Promise<void> {
  const { quiesce, unquiesce, waitForQuiesced } = await import('./quiesce.js');
  const { waitForVolumeDetachedByPvc, unquiesceBestEffort } = await import('./service.js');

  // A namespace parked at 0 by an unfinished storage op cannot be healed by
  // quiesce→unquiesce: `quiesce` captures the CURRENT replica counts, which are
  // all 0, so the restore would faithfully put it back to 0. The intended counts
  // live on the operation row that scaled it down, which is what
  // unquiesceBestEffort reads.
  if (strandedAtZero) {
    const op = await db.execute<{ id: string }>(sql`
      SELECT id FROM storage_operations
       WHERE tenant_id = ${tenantId}
       ORDER BY created_at DESC
       LIMIT 1
    `);
    const opId = (op.rows ?? [])[0]?.id;
    if (!opId) {
      // No op ever recorded — the holds are the only thing keeping the tenant
      // down, so dropping them lets the reactive auto-start work again.
      const { clearQuiesceHold } = await import('./quiesce.js');
      await clearQuiesceHold(k8s, namespace);
      throw new Error(
        `${namespace} is held at 0 replicas but has no storage_operations row to restore from — `
        + 'holds cleared; the intended replica counts are not recoverable automatically',
      );
    }
    await unquiesceBestEffort(db, k8s, opId, namespace, null);
    // unquiesceBestEffort swallows by design, so prove the outcome here rather
    // than trusting it: a heal that reports success over a still-down tenant is
    // the bug this whole change set is about.
    const stillHeld = (await listTenantDeployments(k8s))
      .filter((d) => d.namespace === namespace)
      .filter((d) => (d.desired === 0 && d.held) || (d.desired > 0 && d.available < d.desired));
    if (stillHeld.length > 0) {
      throw new Error(
        `${namespace} still has ${stillHeld.length} workload(s) down after restoring from op ${opId}: `
        + stillHeld.map((d) => `${d.name} ${d.available}/${d.desired}${d.held ? ' (held)' : ''}`).join(', '),
      );
    }
    return;
  }

  const snap = await quiesce(k8s, namespace);
  try {
    await waitForQuiesced(k8s, namespace);
    // The step kubelet never takes on its own: let the volume go fully
    // detached, which releases the staging directory and the attachment
    // tickets, and flushes the filesystem journal.
    await waitForVolumeDetachedByPvc(k8s, namespace, pvcName);
  } finally {
    // Always attempt the restore, even if the detach wait timed out — leaving a
    // tenant we just scaled down at 0 would turn a partial outage into a total
    // one. unquiesce verifies availability and keeps the quiesce-hold on
    // anything it could not restore, so the next tick still owns it.
    await unquiesce(k8s, namespace, snap);
  }
}

export async function reconcileTenantWorkloadHealth(
  db: Database,
  k8s: K8sClients,
): Promise<WorkloadHealthResult> {
  let observedDown = 0;
  let episodesOpened = 0;
  let episodesCleared = 0;
  let healAttempted = 0;
  let healed = 0;
  let alerted = 0;

  let deployments: DeploymentView[];
  try {
    deployments = await listTenantDeployments(k8s);
  } catch (err) {
    console.warn(`[workload-health] cluster-wide Deployment list failed: ${err instanceof Error ? err.message : String(err)}`);
    return { observedDown, episodesOpened, episodesCleared, healAttempted, healed, alerted };
  }

  // Only ACTIVE tenants with no in-flight storage op are ours to judge.
  // Suspended/archived tenants are scaled to 0 by design, and a live op means
  // the orchestrator owns the namespace.
  const tenantRows = await db.execute<{
    id: string; name: string; namespace: string; status: string;
    lifecycle_state: string; active_op_id: string | null;
  }>(sql`
    SELECT id, name, kubernetes_namespace AS namespace, status::text AS status,
           storage_lifecycle_state::text AS lifecycle_state,
           active_storage_op_id AS active_op_id
      FROM tenants
  `);
  const byNs = new Map((tenantRows.rows ?? []).map((t) => [t.namespace, t]));

  const downByNs = new Map<string, DeploymentView[]>();

  for (const d of deployments) {
    const tenant = byNs.get(d.namespace);
    if (!tenant) continue;
    const eligible = tenant.status === 'active' && tenant.active_op_id === null;

    // TWO shapes of "down", and the second one is easy to miss:
    //
    //   a) desired > 0 but not enough available — the pod is refused, unmountable
    //      or crash-looping.
    //   b) desired == 0 WHILE the quiesce-hold annotation is still set — a
    //      restore whose scale-up never took effect at all. `desired > 0` is
    //      false here, so a check written only for (a) reports this tenant as
    //      perfectly healthy while its site serves nothing. This is exactly the
    //      state `unquiesce` leaves behind when it cannot scale a workload back
    //      up, and it is the state the hold annotation exists to mark.
    const strandedAtZero = d.desired === 0 && d.held;
    const isDown = (d.desired > 0 && d.available < d.desired) || strandedAtZero;
    if (!isDown) {
      // Healthy → close any open episode. Done for EVERY tenant, including
      // ineligible ones: a suspended tenant that comes back up should not keep
      // a stale open episode that both dashboards would render.
      const res = await db.execute(sql`
        UPDATE tenant_workload_health_events
           SET cleared_at = now(), available_replicas = ${d.available}
         WHERE tenant_id = ${tenant.id} AND workload = ${d.name} AND cleared_at IS NULL
      `);
      if ((res.rowCount ?? 0) > 0) episodesCleared += 1;
      continue;
    }

    if (!eligible) continue;
    // A workload the orchestrator is deliberately holding at 0 is not down —
    // but `desired > 0` with the hold present means a restore already failed,
    // which IS an outage and is exactly what we want to catch.
    observedDown += 1;
    downByNs.set(d.namespace, [...(downByNs.get(d.namespace) ?? []), d]);
  }

  for (const [namespace, downs] of downByNs) {
    const tenant = byNs.get(namespace)!;
    const podMsgs = await podMessagesFor(k8s, namespace);

    for (const d of downs) {
      const stranded = d.desired === 0 && d.held;
      const { reason, detail } = stranded
        ? {
            reason: 'stranded_at_zero' as HealReason,
            detail: 'Deployment is at 0 replicas with the storage-quiesce hold still set — '
              + 'a storage operation scaled it down and never successfully scaled it back up.',
          }
        : classifyUnavailability(d.replicaFailure, podMsgs);
      // Open or refresh. `first_seen_at` is left alone on conflict — it is the
      // hysteresis clock and must measure the OUTAGE, not the last tick.
      const ins = await db.execute(sql`
        INSERT INTO tenant_workload_health_events
          (tenant_id, workload, namespace, desired_replicas, available_replicas, reason, detail)
        VALUES (${tenant.id}, ${d.name}, ${namespace}, ${d.desired}, ${d.available}, ${reason}, ${detail})
        ON CONFLICT (tenant_id, workload) DO UPDATE
           SET last_seen_at = now(),
               desired_replicas = EXCLUDED.desired_replicas,
               available_replicas = EXCLUDED.available_replicas,
               reason = EXCLUDED.reason,
               detail = EXCLUDED.detail,
               -- A workload that went down again after being cleared starts a
               -- NEW episode: reopen and restart the clock and the counters,
               -- otherwise an old cleared row makes a fresh outage look like it
               -- has already exhausted its heal attempts.
               first_seen_at = CASE WHEN tenant_workload_health_events.cleared_at IS NOT NULL
                                    THEN now() ELSE tenant_workload_health_events.first_seen_at END,
               heal_attempts = CASE WHEN tenant_workload_health_events.cleared_at IS NOT NULL
                                    THEN 0 ELSE tenant_workload_health_events.heal_attempts END,
               notify_count = CASE WHEN tenant_workload_health_events.cleared_at IS NOT NULL
                                   THEN 0 ELSE tenant_workload_health_events.notify_count END,
               last_notified_at = CASE WHEN tenant_workload_health_events.cleared_at IS NOT NULL
                                       THEN NULL ELSE tenant_workload_health_events.last_notified_at END,
               healed_at = NULL,
               cleared_at = NULL
      `);
      if ((ins.rowCount ?? 0) > 0) episodesOpened += 1;
    }
  }

  // ── Act on episodes that have outlived the grace window ──
  const due = await db.execute<{
    tenant_id: string; workload: string; namespace: string; reason: string;
    detail: string | null; heal_attempts: number; last_heal_error: string | null;
    first_seen_at: string; down_minutes: number; notify_count: number;
    last_notified_at: string | null; tenant_name: string;
  }>(sql`
    SELECT e.tenant_id, e.workload, e.namespace, e.reason, e.detail,
           e.heal_attempts, e.last_heal_error, e.first_seen_at,
           FLOOR(EXTRACT(EPOCH FROM (now() - e.first_seen_at)) / 60)::int AS down_minutes,
           e.notify_count, e.last_notified_at, t.name AS tenant_name
      FROM tenant_workload_health_events e
      JOIN tenants t ON t.id = e.tenant_id
     WHERE e.cleared_at IS NULL
       AND e.first_seen_at < now() - ${`${Math.round(GRACE_MS / 1000)} seconds`}::interval
       AND t.status = 'active'
       AND t.active_storage_op_id IS NULL
     ORDER BY e.first_seen_at ASC
  `);

  const healedNamespaces = new Set<string>();
  const failedNamespaces = new Set<string>();

  for (const row of due.rows ?? []) {
    if (failedNamespaces.has(row.namespace)) {
      // One heal per namespace per tick — the action is namespace-wide.
    } else if (
      !healedNamespaces.has(row.namespace)
      && row.heal_attempts < MAX_HEAL_ATTEMPTS
      && isHealable(row.reason as HealReason)
    ) {
      // Claim the attempt. A single conditional UPDATE across every open
      // episode in this namespace, so exactly one api replica proceeds and the
      // backoff is enforced in the database rather than in each process.
      const backoffSec = Math.round(
        (HEAL_BACKOFF_BASE_MS * Math.pow(4, row.heal_attempts)) / 1000,
      );
      const claim = await db.execute(sql`
        UPDATE tenant_workload_health_events
           SET heal_attempts = heal_attempts + 1, last_heal_at = now()
         WHERE namespace = ${row.namespace}
           AND cleared_at IS NULL
           AND heal_attempts < ${MAX_HEAL_ATTEMPTS}
           AND (last_heal_at IS NULL OR last_heal_at < now() - ${`${backoffSec} seconds`}::interval)
      `);
      if ((claim.rowCount ?? 0) > 0) {
        healAttempted += 1;
        console.warn(
          `[workload-health] ${row.namespace}/${row.workload} unavailable for ${row.down_minutes}min `
          + `(${row.reason}) — attempt ${row.heal_attempts + 1}/${MAX_HEAL_ATTEMPTS}: re-staging the volume`,
        );
        try {
          await healNamespace(
            db, k8s, row.namespace, `${row.namespace}-storage`,
            row.reason === 'stranded_at_zero', row.tenant_id,
          );
          // Record the attempt as successful only against OBSERVED recovery:
          // unquiesce now verifies availability, so returning without throwing
          // means the replicas are actually up.
          await db.execute(sql`
            UPDATE tenant_workload_health_events
               SET healed_at = now(), cleared_at = now(), last_heal_error = NULL
             WHERE namespace = ${row.namespace} AND cleared_at IS NULL
          `);
          healedNamespaces.add(row.namespace);
          healed += 1;
          console.warn(`[workload-health] ${row.namespace} recovered by auto-heal`);
          continue;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failedNamespaces.add(row.namespace);
          await db.execute(sql`
            UPDATE tenant_workload_health_events
               SET last_heal_error = ${msg.slice(0, 2000)}
             WHERE namespace = ${row.namespace} AND cleared_at IS NULL
          `);
          console.error(`[workload-health] ${row.namespace} auto-heal FAILED: ${msg}`);
        }
      }
    }

    // ── Alert. Only reached when healing was tried and did not fix it, or the
    // attempt budget is spent. The ladder stops it becoming wallpaper.
    const attempts = failedNamespaces.has(row.namespace) ? row.heal_attempts + 1 : row.heal_attempts;
    // Alert when auto-heal has been tried and failed, when its budget is spent,
    // or when the cause is one auto-heal deliberately will not attempt — in that
    // last case the budget is never spent, so waiting for it would mean a tenant
    // with a bad image stays down and silent forever.
    const notHealable = !isHealable(row.reason as HealReason);
    const exhausted = failedNamespaces.has(row.namespace)
      || attempts >= MAX_HEAL_ATTEMPTS
      || notHealable;
    if (!exhausted) continue;

    const ladderIdx = Math.min(row.notify_count, NOTIFY_LADDER_MS.length - 1);
    const dueAgainMs = NOTIFY_LADDER_MS[ladderIdx];
    const notifyClaim = await db.execute(sql`
      UPDATE tenant_workload_health_events
         SET last_notified_at = now(), notify_count = notify_count + 1
       WHERE tenant_id = ${row.tenant_id} AND workload = ${row.workload}
         AND cleared_at IS NULL
         AND (last_notified_at IS NULL
              OR last_notified_at < now() - ${`${Math.round(dueAgainMs / 1000)} seconds`}::interval)
    `);
    if ((notifyClaim.rowCount ?? 0) === 0) continue; // another replica sent it, or not due yet

    const effReason = (row.reason as HealReason) || 'unknown';
    const label = labelForReason(effReason)
      ?? classifyUnavailability(null, [row.detail ?? '']).label;
    const { notifyAdminTenantWorkloadsDown, notifyTenantWorkloadsDown } = await import('../notifications/events.js');
    const downSince = new Date(row.first_seen_at).toISOString();
    // dedupeKey keyed on the EPISODE (tenant × workload × first_seen), never on
    // a wall-clock bucket: a bucket whose width matches the caller's period
    // deduplicates nothing, which is how saturation alerts once fired hourly
    // forever.
    const episodeKey = `workloads-down:${row.tenant_id}:${row.workload}:${downSince}`;
    await notifyAdminTenantWorkloadsDown(db, {
      tenantName: row.tenant_name,
      namespace: row.namespace,
      workload: row.workload,
      downSince,
      downMinutes: String(row.down_minutes),
      reason: effReason,
      reasonLabel: label,
      detail: row.detail ?? undefined,
      healAttempts: String(attempts),
      lastHealError: row.last_heal_error ?? undefined,
      recommendedAction: recommendedAction(effReason),
    }, `${episodeKey}:admin:${row.notify_count}`);
    await notifyTenantWorkloadsDown(db, row.tenant_id, {
      workload: row.workload,
      downSince,
      reasonLabel: label,
    }, `${episodeKey}:tenant:${row.notify_count}`);
    alerted += 1;
  }

  // GC the audit tail.
  await db.execute(sql`
    DELETE FROM tenant_workload_health_events
     WHERE cleared_at IS NOT NULL
       AND cleared_at < now() - ${`${Math.round(CLEARED_RETENTION_MS / 1000)} seconds`}::interval
  `);

  return { observedDown, episodesOpened, episodesCleared, healAttempted, healed, alerted };
}
