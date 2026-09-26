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
import type { QuiesceSnapshot } from './quiesce.js';

/**
 * How long a workload may be unavailable before it counts as an outage.
 *
 * Long enough to cover the honest slow paths: a Longhorn re-attach that loses
 * kubelet's exponential CSI backoff race (measured 11s and 19s on production),
 * a cold image pull, a rolling update. Short enough that an operator hears about
 * a real outage in minutes rather than hours.
 */
export const GRACE_MS = 8 * 60 * 1000;

/**
 * The same window as a Postgres interval literal, for the dashboard queries.
 *
 * Both dashboard cards read this table and independently gate on the grace
 * window. They used to hardcode `INTERVAL '8 minutes'`, so changing GRACE_MS
 * would silently desynchronise the panels from the reconciler that owns the
 * state — and the whole point of the shared table is that the two consoles
 * cannot disagree about whether a tenant is up.
 */
export const GRACE_INTERVAL_SQL = `${Math.round(GRACE_MS / 1000)} seconds`;

/** Heal attempts before we stop trying and leave it to the operator. */
const MAX_HEAL_ATTEMPTS = 3;

/** Backoff between heal attempts on the same episode: 10min, 40min, 160min. */
const HEAL_BACKOFF_BASE_MS = 10 * 60 * 1000;

/** Re-alert ladder for a sustained, unhealed outage: 1h → 6h → daily. */
const NOTIFY_LADDER_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

/**
 * How long a workload must stay healthy before a new outage counts as a NEW
 * episode rather than a continuation.
 *
 * Shorter than this and the counters carry over, so a flapping workload still
 * marches up the heal-attempt budget and the notify ladder.
 */
const FLAP_QUIET_MS = 60 * 60 * 1000;
const FLAP_QUIET_SQL = `${Math.round(FLAP_QUIET_MS / 1000)} seconds`;

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

/**
 * Plain-language cause for a persisted reason slug.
 *
 * TOTAL over HealReason, deliberately. The alert used to fall back to
 * re-classifying the stored `detail` column when this returned null — but
 * `detail` is truncated to 1000 chars at write time, so for a long pod-message
 * list whose determinative keyword falls past the cut the label disagreed with
 * the `reason` the row was actually classified as. The reason is decided once,
 * on the full text, and persisted; the label must be derived from THAT and
 * nothing else. A `Record` rather than a switch so adding a HealReason is a
 * compile error here instead of a silently missing label.
 */
const REASON_LABELS: Record<HealReason, string> = {
  volume_attach: 'the storage volume would not attach or mount',
  quota_rejected: 'the namespace ResourceQuota refused to admit the pod',
  unschedulable: 'no node could accept the pod',
  image: 'the container image could not be pulled',
  crash: 'the container keeps crashing on startup',
  stranded_at_zero: 'a storage operation scaled it down and never brought it back up',
  unknown: 'the pod did not become ready',
};

export function labelForReason(reason: HealReason): string {
  return REASON_LABELS[reason] ?? REASON_LABELS.unknown;
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
  const { randomUUID } = await import('node:crypto');
  const opId = randomUUID();

  // ── Register the heal as a REAL storage operation, and CLAIM the tenant ──
  //
  // A heal performs the same destructive quiesce cycle as a resize or an fsck,
  // so it has to be visible to the machinery that guards those:
  //   * `mustBeIdle()` gates resize / restore / fsck / suspend / resume /
  //     archive on `storage_lifecycle_state = 'idle'`. Without this claim an
  //     operator could start a DESTRUCTIVE resize — which deletes and recreates
  //     the PVC — while the heal was mid-cycle on the same RWO volume.
  //   * quiesce-watchdog Leg B hunts for hold-annotated Deployments on active
  //     tenants with `active_storage_op_id IS NULL`, which is precisely what a
  //     heal in progress used to look like. It would fire concurrently and
  //     restore from an unrelated stale snapshot while we were scaling down.
  //   * Leg A recovers non-terminal op rows older than 6h, so if this process
  //     dies mid-heal the tenant still gets its workloads back.
  //
  // The tenant claim is a conditional UPDATE, so it doubles as the cross-process
  // mutual exclusion: if anything else already owns the tenant we abort before
  // touching a single Deployment.
  await db.execute(sql`
    INSERT INTO storage_operations (id, tenant_id, op_type, state, progress_pct, progress_message, params)
    VALUES (${opId}, ${tenantId}, 'autoheal', 'quiescing', 0,
            ${strandedAtZero
              ? 'Auto-heal: restoring workloads stranded at 0 replicas'
              : 'Auto-heal: re-staging the tenant volume'},
            ${JSON.stringify({ autoHeal: true, strandedAtZero })}::jsonb)
  `);
  const claim = await db.execute(sql`
    UPDATE tenants
       SET active_storage_op_id = ${opId}, storage_lifecycle_state = 'quiescing'
     WHERE id = ${tenantId} AND active_storage_op_id IS NULL
  `);
  if ((claim.rowCount ?? 0) === 0) {
    await db.execute(sql`
      UPDATE storage_operations
         SET state = 'failed', completed_at = now(),
             last_error = 'Aborted before touching anything: another storage operation owns this tenant'
       WHERE id = ${opId}
    `);
    throw new Error(
      `${namespace}: another storage operation claimed the tenant before the heal started — skipping`,
    );
  }

  const releaseTenant = async (failed: boolean, err: string | null): Promise<void> => {
    await db.execute(sql`
      UPDATE storage_operations
         SET state = ${failed ? 'failed' : 'idle'}, progress_pct = 100, completed_at = now(),
             last_error = ${err}
       WHERE id = ${opId}
    `);
    // Only release the pointer if it is still OURS — never clobber a newer op.
    await db.execute(sql`
      UPDATE tenants
         SET active_storage_op_id = NULL,
             storage_lifecycle_state = ${failed ? 'failed' : 'idle'}
       WHERE id = ${tenantId} AND active_storage_op_id = ${opId}
    `);
  };

  try {
    // A namespace parked at 0 by an unfinished storage op cannot be healed by
    // quiesce→unquiesce: `quiesce` captures the CURRENT replica counts, which are
    // all 0, so the restore would faithfully put it back to 0. The intended counts
    // live on the operation row that scaled it down, which is what
    // unquiesceBestEffort reads.
    if (strandedAtZero) {
      const op = await db.execute<{ id: string }>(sql`
        SELECT id FROM storage_operations
         WHERE tenant_id = ${tenantId}
           AND id <> ${opId}
           AND params -> 'quiesceSnapshot' IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1
      `);
      const sourceOpId = (op.rows ?? [])[0]?.id;
      if (!sourceOpId) {
        // No snapshot anywhere to restore from. Dropping the holds at least
        // re-enables reactive auto-start; the replica counts are simply not
        // recoverable automatically, and the caller turns this into an alert.
        const { clearQuiesceHold } = await import('./quiesce.js');
        await clearQuiesceHold(k8s, namespace);
        throw new Error(
          `${namespace} is held at 0 replicas but no storage operation carries a replica snapshot to restore from — `
          + 'holds cleared so auto-start works again, but the intended replica counts cannot be recovered automatically',
        );
      }
      await unquiesceBestEffort(db, k8s, sourceOpId, namespace, null);
      // unquiesceBestEffort swallows by design, so prove the outcome here rather
      // than trusting it: a heal that reports success over a still-down tenant is
      // the bug this whole change set is about.
      const stillDown = (await listTenantDeployments(k8s))
        .filter((d) => d.namespace === namespace)
        .filter((d) => (d.desired === 0 && d.held) || (d.desired > 0 && d.available < d.desired));
      if (stillDown.length > 0) {
        throw new Error(
          `${namespace} still has ${stillDown.length} workload(s) down after restoring from op ${sourceOpId}: `
          + stillDown.map((d) => `${d.name} ${d.available}/${d.desired}${d.held ? ' (held)' : ''}`).join(', '),
        );
      }
      await releaseTenant(false, null);
      return;
    }

    // ── The re-stage cycle ──
    // `quiesce` is given the persist callback for the same reason every other
    // orchestrator gives it one: it writes the pre-quiesce replica counts to the
    // op row BEFORE scaling anything, so a throw PART WAY through the scale-down
    // loop (a 409, a 5xx, a network blip on the third of four Deployments) still
    // leaves a complete snapshot on disk for the failure path — and for Leg A —
    // to restore from. Without it, a mid-loop throw meant the local snapshot was
    // never assigned and nothing restored the workloads at all.
    let snap: QuiesceSnapshot | null = null;
    try {
      snap = await quiesce(k8s, namespace, async (captured) => {
        await db.execute(sql`
          UPDATE storage_operations
             SET params = params || ${JSON.stringify({ quiesceSnapshot: captured })}::jsonb
           WHERE id = ${opId}
        `);
      });
      await waitForQuiesced(k8s, namespace);
      // The step kubelet never takes on its own: let the volume go fully
      // detached, which releases the staging directory and the attachment
      // tickets, and flushes the filesystem journal.
      await waitForVolumeDetachedByPvc(k8s, namespace, pvcName);
      await unquiesce(k8s, namespace, snap);
    } catch (err) {
      // Restore on EVERY failure path, including a throw from inside quiesce
      // itself, falling back to the op-persisted snapshot when the local is
      // still null. Leaving a namespace we just scaled down at 0 would turn a
      // partial outage into a total one.
      const primary = err instanceof Error ? err.message : String(err);
      await unquiesceBestEffort(db, k8s, opId, namespace, snap);
      // Re-throw the ORIGINAL cause: a `finally`-based restore would let a
      // secondary error from the restore mask "never reached detached", and the
      // operator-facing recommendation is derived from the cause.
      throw new Error(primary);
    }
    await releaseTenant(false, null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await releaseTenant(true, msg.slice(0, 2000));
    throw err;
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
      //
      // Wrapped because an unhandled throw here escapes the whole reconcile and
      // every LATER tenant in the list goes unprocessed for this tick. One
      // tenant's transient DB error must not blind the sweep to the rest.
      try {
        const res = await db.execute(sql`
          UPDATE tenant_workload_health_events
             SET cleared_at = now(), available_replicas = ${d.available}
           WHERE tenant_id = ${tenant.id} AND workload = ${d.name} AND cleared_at IS NULL
        `);
        if ((res.rowCount ?? 0) > 0) episodesCleared += 1;
      } catch (err) {
        console.warn(`[workload-health] clearing episode ${d.namespace}/${d.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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
      // Same isolation as the clear path: one tenant must not abort the sweep.
      try {
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
               -- A workload that went down again shortly after being "healed" is
               -- FLAPPING, not recovered. Resetting the counters on every reopen
               -- meant such a tenant could cycle down/up indefinitely without ever
               -- reaching MAX_HEAL_ATTEMPTS or the notify ladder — continuous real
               -- instability that never alerted. Only a reopen after a decent
               -- quiet period counts as a fresh incident; a fast re-break
               -- CONTINUES the previous episode and keeps its counters.
               --
               -- NULL semantics are load-bearing and deliberate: for a row that
               -- is still OPEN, cleared_at IS NULL, so the comparison against
               -- now() minus the interval is NULL, the CASE takes the ELSE, and a
               -- plain refresh
               -- leaves every counter and the clock untouched. Three states, one
               -- comparison: open -> keep, recently closed -> keep, long closed
               -- -> reset.
               first_seen_at = CASE WHEN tenant_workload_health_events.cleared_at
                                         < now() - ${FLAP_QUIET_SQL}::interval
                                    THEN now() ELSE tenant_workload_health_events.first_seen_at END,
               heal_attempts = CASE WHEN tenant_workload_health_events.cleared_at
                                         < now() - ${FLAP_QUIET_SQL}::interval
                                    THEN 0 ELSE tenant_workload_health_events.heal_attempts END,
               notify_count = CASE WHEN tenant_workload_health_events.cleared_at
                                        < now() - ${FLAP_QUIET_SQL}::interval
                                   THEN 0 ELSE tenant_workload_health_events.notify_count END,
               last_notified_at = CASE WHEN tenant_workload_health_events.cleared_at
                                         < now() - ${FLAP_QUIET_SQL}::interval
                                       THEN NULL ELSE tenant_workload_health_events.last_notified_at END,
               -- A REOPENED episode has not been healed at all, so the previous
               -- episode's heal outcome must not survive into it. Observed on DEV:
               -- a reopened row kept last_heal_error from the prior outage while
               -- heal_attempts was correctly reset to 0, and the dashboard card --
               -- which decides "tried and failed" from last_heal_error -- rendered
               -- "0 heal attempt(s) failed". Reset the pair together or the two
               -- fields disagree about the same episode.
               last_heal_error = CASE WHEN tenant_workload_health_events.cleared_at
                                         < now() - ${FLAP_QUIET_SQL}::interval
                                      THEN NULL ELSE tenant_workload_health_events.last_heal_error END,
               last_heal_at = CASE WHEN tenant_workload_health_events.cleared_at
                                         < now() - ${FLAP_QUIET_SQL}::interval
                                   THEN NULL ELSE tenant_workload_health_events.last_heal_at END,
               healed_at = NULL,
               cleared_at = NULL
      `);
      if ((ins.rowCount ?? 0) > 0) episodesOpened += 1;
      } catch (err) {
        console.warn(`[workload-health] recording episode ${namespace}/${d.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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
    // Derived from the PERSISTED reason, never re-parsed from the truncated
    // `detail` column — see REASON_LABELS.
    const label = labelForReason(effReason);
    const { notifyAdminTenantWorkloadsDown, notifyTenantWorkloadsDown } = await import('../notifications/events.js');
    const downSince = new Date(row.first_seen_at).toISOString();
    // dedupeKey keyed on the EPISODE (tenant × workload × first_seen), never on
    // a wall-clock bucket: a bucket whose width matches the caller's period
    // deduplicates nothing, which is how saturation alerts once fired hourly
    // forever.
    const episodeKey = `workloads-down:${row.tenant_id}:${row.workload}:${downSince}`;
    const adminSent = await notifyAdminTenantWorkloadsDown(db, {
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
    const tenantSent = await notifyTenantWorkloadsDown(db, row.tenant_id, {
      workload: row.workload,
      downSince,
      reasonLabel: label,
    }, `${episodeKey}:tenant:${row.notify_count}`);

    // The ADMIN copy is the one that matters: it is the alert whose absence let a
    // tenant stay down for 18 hours. If it did not go out, GIVE THE LADDER SLOT
    // BACK so the next tick retries in 5 minutes instead of deferring by the
    // ladder step (1h → 6h → daily) over a delivery that never happened.
    if (!adminSent.ok) {
      await db.execute(sql`
        UPDATE tenant_workload_health_events
           SET last_notified_at = ${row.last_notified_at},
               notify_count = ${row.notify_count}
         WHERE tenant_id = ${row.tenant_id} AND workload = ${row.workload}
           AND cleared_at IS NULL
      `);
      console.error(
        `[workload-health] ADMIN alert for ${row.namespace}/${row.workload} did NOT dispatch `
        + `(${adminSent.error ?? 'unknown'}) — ladder slot released, retrying next tick`,
      );
      continue;
    }
    if (!tenantSent.ok) {
      // The tenant copy is informational and its address may simply be
      // undeliverable; do not hold the admin ladder back for it.
      console.warn(
        `[workload-health] tenant copy for ${row.namespace}/${row.workload} did not dispatch: ${tenantSent.error ?? 'unknown'}`,
      );
    }
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
