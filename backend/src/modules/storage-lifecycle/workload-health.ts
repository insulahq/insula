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

import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { alertGroupKey, claimedEpisodesKey, groupAlerts, healSummary, workloadsByTenant, type AlertRow } from './workload-alerts.js';
import { cappedList } from '../notifications/list-items.js';
import {
  STORAGE_QUIESCED_ANNOTATION,
  STORAGE_PREQUIESCE_REPLICAS_ANNOTATION,
} from '../../shared/scale-deployment.js';
import type { QuiesceSnapshot } from './quiesce.js';
import { parseK8sQuantity } from '../../shared/k8s-quantity.js';
import {
  describeQuotaRefusal, quotaRefusalVerdict, refusalForWorkload,
  type LiveQuota, type QuotaRefusal, type QuotaVerdict, type TerminatingPod,
} from './quota-refusal.js';

/**
 * How long a workload may be unavailable before it counts as an outage.
 *
 * Long enough to cover the honest slow paths: a Longhorn re-attach that loses
 * kubelet's exponential CSI backoff race (measured 11s and 19s on production),
 * a cold image pull, a rolling update. Short enough that an operator hears about
 * a real outage in minutes rather than hours.
 */
export const GRACE_MS = 8 * 60 * 1000;

/** The same window as a Postgres interval literal. */
const GRACE_INTERVAL_SQL = `${Math.round(GRACE_MS / 1000)} seconds`;

/**
 * The shorter window for a volume that will not mount right after Longhorn
 * salvaged it (a recorded storage failover, tenant-placement/store.ts).
 *
 * After a salvage Longhorn deletes the workload's pods itself, 30 s later, and
 * they normally come straight back. When they cannot mount the volume instead,
 * nothing about it is slow or still settling: the salvage shut the filesystem
 * down, the staging directory went stale under kubelet, and kubelet retries
 * that for ever. Eight more minutes buy nothing. Measured on production: a 60 s
 * node freeze, two tenants on exactly this path, healed at the first try —
 * 13 minutes after the freeze, almost all of it this window and the old 5 min
 * tick.
 *
 * Only for `volume_attach`. A workload that is merely slow to come back after
 * the salvage — a database in crash recovery is "not ready" for minutes —
 * keeps the full window: re-staging its volume would restart the recovery.
 */
export const FAILOVER_GRACE_MS = 3 * 60 * 1000;

/** How long after a salvage a volume that will not mount is put down to it. */
export const FAILOVER_RECENT_MS = 30 * 60 * 1000;

/**
 * "This open episode has outlived its grace window" — the ONE gate, as a SQL
 * condition on `tenant_workload_health_events e`.
 *
 * The reconciler acts on it and both dashboard cards filter by it: the whole
 * point of the shared table is that the two consoles cannot disagree with the
 * reconciler about whether a tenant is up. The cards once hardcoded
 * `INTERVAL '8 minutes'`; with a second, shorter window that would be an alert
 * about a tenant the dashboard still shows as fine. Every caller aliases the
 * episode table as `e`.
 */
export function episodePastGraceSql(): SQL {
  return sql`e.first_seen_at < now() - (CASE
      WHEN e.reason = 'volume_attach' AND EXISTS (
        SELECT 1 FROM tenant_storage_failovers f
         WHERE f.tenant_id = e.tenant_id
           AND f.remount_requested_at > now() - ${`${Math.round(FAILOVER_RECENT_MS / 1000)} seconds`}::interval)
      THEN ${`${Math.round(FAILOVER_GRACE_MS / 1000)} seconds`}::interval
      ELSE ${GRACE_INTERVAL_SQL}::interval END)`;
}

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
  | 'stranded_at_zero' | 'node_down' | 'unknown';

/**
 * The node a tenant is pinned to, when that node is down — or null.
 *
 * Decided BEFORE the cluster's messages are read: while a node shuts down the
 * pods on it still count against the namespace quota, so every replacement is
 * refused with "exceeded quota" in the first seconds, and that event stays
 * "recent" for ten minutes. Production: a tenant pinned to a node
 * that was powered off was recorded as `quota_rejected`; the alert said to
 * raise its plan limits, and the auto-heal scaled it down and up against a
 * node that was not there — then left the tenant marked FAILED.
 *
 * Only a node known and NotReady counts: one that cannot be read, or no
 * longer exists, is not evidence of anything here.
 */
export function pinnedNodeDown(
  pin: string | null,
  readyByNode: ReadonlyMap<string, boolean>,
): string | null {
  if (!pin) return null;
  return readyByNode.get(pin) === false ? pin : null;
}

/**
 * Translate what the cluster says into a cause the operator can act on, and the
 * healer can branch on.
 *
 * Order matters, twice over.
 *
 * The stale staging directory comes first. It is the one message here that
 * names its cause outright and never clears by itself, and the quota message
 * that accompanies it is a by-product: Longhorn deletes the pods after a
 * salvage, each replacement is refused while its predecessor is still
 * terminating, and that refusal is still among the namespace's recent events
 * when a later replacement exists and sits unmountable. Seen on production: two tenants down
 * on a stale staging directory, both recorded as `quota_rejected` — had the
 * heal failed, the alert would have told the operator to raise plan limits.
 * A quota that really is too small still gets its turn: once the volume mounts
 * the stale-directory message is gone and the next tick reads the quota one.
 *
 * Any OTHER volume failure stays behind the quota: the ReplicaSet refuses to
 * create a pod that the volume could not have mounted anyway, and of those two
 * the quota is the one a human has to decide about.
 */
export function classifyUnavailability(
  replicaFailure: string | null,
  podMessages: readonly string[],
): { reason: HealReason; detail: string | null; label: string } {
  const all = [replicaFailure ?? '', ...podMessages].join(' | ');
  const detail = all.trim() ? all.trim().slice(0, 1000) : null;

  // The stale-staging-directory failure. kubelet retries this forever on a
  // 2m2s backoff and never repairs it; only a full detach + re-stage does.
  if (/globalmount.*file exists|failed to create dir.*globalmount/i.test(all)) {
    return {
      reason: 'volume_attach',
      detail,
      label: 'a stale CSI staging directory is blocking every mount (kubelet cannot self-repair this)',
    };
  }
  if (/exceeded quota|forbidden:.*quota/i.test(all)) {
    return {
      reason: 'quota_rejected',
      detail,
      label: 'the namespace ResourceQuota refused to admit the pod',
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
  node_down: 'the node it is pinned to is down',
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
    case 'quota_rejected':     // ONLY when terminating pods make the room — see healableNow
    case 'unknown':            // no diagnosis; one bounded attempt is reasonable
      return true;
    case 'image':              // needs a corrected image reference
    case 'crash':              // needs a code or limits change
    case 'unschedulable':      // needs capacity, a taint change or an unpin
    case 'node_down':          // needs the node back; a scale cycle cannot bring it
      return false;
  }
}

/**
 * `isHealable`, with the live quota's say for a refusal. A refusal is worth a
 * restart only when the refused workloads would fit once the pods already
 * terminating are gone; a FULL quota — or one that cannot be read — is not:
 * restarting the namespace only reshuffles which workload is admitted first
 * (production: the established site lost its slot to a pod added minutes
 * earlier, three restarts running). Pure.
 */
export function healableNow(reason: HealReason, quota: QuotaVerdict | null): boolean {
  if (!isHealable(reason)) return false;
  if (reason !== 'quota_rejected') return true;
  return quota?.kind === 'fits';
}

/** What to tell the operator to go and do, per cause. */
export function recommendedAction(reason: HealReason, detail?: string | null, workload?: string): string {
  if (reason === 'quota_rejected') {
    const figures = describeQuotaRefusal(detail, workload);
    // The heal summary already says whether a restart was tried and why not.
    return `The namespace quota is full${figures ? ` (${figures})` : ''}. `
      + 'Raise that limit for the tenant, or stop or remove one of its applications.';
  }
  switch (reason) {
    case 'stranded_at_zero':
      return 'The tenant is parked at 0 replicas by a storage operation that did not finish. '
        + 'Auto-heal restores from the operation\u2019s persisted replica snapshot; if that keeps failing, '
        + 'use Reset to idle on the tenant\u2019s Storage Operations card, then check the ResourceQuota has room.';
    case 'volume_attach':
      return 'Check the kubelet journal for this PV (`journalctl -u k3s | grep <pv-name>`) and count MountDevice succeeded vs failed. '
        + 'A stale staging directory needs the volume fully detached and re-staged; auto-heal already tried exactly that.';
    case 'unschedulable':
      return 'No node can fit or tolerate the pod — check node capacity, taints and any node pin on the tenant.';
    case 'node_down':
      return 'It comes back by itself when that node is back. To run it elsewhere meanwhile, re-pin the tenant '
        + 'from its Placement card — its data needs a copy on the new node.';
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
  /**
   * Replica count recorded when quiesce scaled this Deployment down, read off
   * the hold annotation. `null` on a workload quiesced by a release that did not
   * yet stamp it — the heal then falls back to a validated op snapshot.
   */
  preQuiesceReplicas: number | null;
}

/**
 * Parse the pre-quiesce replica annotation defensively.
 *
 * It is operator-visible and hand-editable, so it can be absent, empty, "abc",
 * "-1" or "1e9". Anything that is not a plain non-negative integer is treated as
 * ABSENT rather than coerced — a restore to `NaN` or to a wild number is worse
 * than falling back to the op snapshot. 0 is rejected too: quiesce only stamps
 * Deployments it scaled down FROM a positive count, so 0 means the annotation is
 * not trustworthy.
 */
export function parsePreQuiesceReplicas(raw: string | undefined): number | null {
  if (!raw || !/^[0-9]{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
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
      preQuiesceReplicas: parsePreQuiesceReplicas(
        d.metadata?.annotations?.[STORAGE_PREQUIESCE_REPLICAS_ANNOTATION],
      ),
    });
  }
  return out;
}

/** A pod, as far as its present state matters to the diagnosis. */
export interface EvidencePod {
  readonly metadata?: {
    readonly uid?: string;
    readonly name?: string;
    readonly ownerReferences?: ReadonlyArray<{ readonly kind?: string; readonly name?: string }>;
  };
  readonly status?: {
    readonly phase?: string;
    readonly conditions?: ReadonlyArray<{ type?: string; status?: string; reason?: string; message?: string }>;
    readonly containerStatuses?: ReadonlyArray<{ state?: { waiting?: { reason?: string; message?: string } } }>;
  };
}

/** A namespace event. The clients hand timestamps over as Date or string. */
export interface EvidenceEvent {
  readonly type?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly involvedObject?: { readonly kind?: string; readonly uid?: string; readonly name?: string };
  readonly lastTimestamp?: Date | string | null;
  readonly eventTime?: Date | string | null;
  readonly series?: { readonly lastObservedTime?: Date | string | null } | null;
  readonly metadata?: { readonly creationTimestamp?: Date | string | null };
}

/**
 * How long an event about something other than a pod (a ReplicaSet's
 * FailedCreate) still counts as the present. A rejection that persists is on
 * the Deployment's ReplicaFailure condition anyway, which is read separately.
 */
export const RECENT_EVENT_MS = 10 * 60 * 1000;

function eventLastSeenMs(e: EvidenceEvent): number | null {
  const stamps = [e.series?.lastObservedTime, e.lastTimestamp, e.eventTime, e.metadata?.creationTimestamp]
    .map((t) => (t ? new Date(t).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  return stamps.length > 0 ? Math.max(...stamps) : null;
}

/**
 * What the namespace says is wrong NOW. Pure.
 *
 * Warning events outlive what they describe by about an hour, and the
 * diagnosis decides when — and whether — a tenant's workloads are scaled to
 * zero. Read without regard to age they misdiagnose in both directions:
 *
 *   • After a salvage every replacement pod logs a FailedMount or two before it
 *     mounts. A database then spends minutes in crash recovery, "not ready" —
 *     and with those events still counted it reads as a volume that will not
 *     mount, on the short post-failover window, and is re-staged mid-recovery.
 *   • A tenant healed of a stale staging directory and, twenty minutes later,
 *     genuinely over its quota would be put down to the directory again and
 *     bounced three times before anyone was told about the quota.
 *
 * So an event about a pod counts only while that pod exists and has not
 * started (phase Pending): a mount, attach, pull or scheduling failure is by
 * definition the trouble of a pod that is not running yet, and whatever ails a
 * running one is on its container statuses. An event about anything else
 * counts while it is recent. Pod conditions and waiting states are the present
 * by nature.
 */
export function currentEvidence(pods: readonly EvidencePod[], events: readonly EvidenceEvent[], nowMs: number): string[] {
  return currentEvidenceByOwner(pods, events, nowMs).map((e) => e.msg).slice(0, 20);
}

/** One piece of evidence and the Deployment it is about, or null when that cannot be told. */
export interface OwnedEvidence {
  readonly owner: string | null;
  readonly msg: string;
}

/** The Deployment a ReplicaSet belongs to: its generated name is `<deployment>-<hash>`. Pure. */
export function deploymentOfReplicaSet(name: string | undefined): string | null {
  if (!name) return null;
  const at = name.lastIndexOf('-');
  return at > 0 ? name.slice(0, at) : null;
}

/** The Deployment a pod belongs to, read from its ReplicaSet owner. Null for a pod no ReplicaSet owns. Pure. */
export function deploymentOfPod(pod: EvidencePod): string | null {
  const rs = pod.metadata?.ownerReferences?.find((o) => o.kind === 'ReplicaSet');
  return deploymentOfReplicaSet(rs?.name);
}

/**
 * currentEvidence with each message's owner. The evidence is read once per
 * namespace, but the cause is decided per workload: a starting file manager
 * was recorded as `quota_rejected` because ANOTHER Deployment's ReplicaSet had
 * a quota FailedCreate in the namespace (seen on staging) — and the quota
 * check runs before the volume one, so a real mount failure next to a quota
 * refusal elsewhere would never have been treated as one. See evidenceFor.
 */
export function currentEvidenceByOwner(pods: readonly EvidencePod[], events: readonly EvidenceEvent[], nowMs: number): OwnedEvidence[] {
  const out: OwnedEvidence[] = [];
  const notStarted = new Map<string, string | null>();
  for (const p of pods) {
    if (p.status?.phase === 'Succeeded') continue;
    const owner = deploymentOfPod(p);
    if (p.status?.phase === 'Pending' && p.metadata?.uid) notStarted.set(p.metadata.uid, owner);
    for (const c of p.status?.conditions ?? []) {
      if (c.status === 'False' && c.message) out.push({ owner, msg: `${c.reason ?? c.type}: ${c.message}` });
    }
    for (const cs of p.status?.containerStatuses ?? []) {
      const w = cs.state?.waiting;
      if (w?.reason) out.push({ owner, msg: `${w.reason}: ${w.message ?? ''}` });
    }
  }
  for (const e of events) {
    if (e.type !== 'Warning' || !e.message) continue;
    let owner: string | null = null;
    if (e.involvedObject?.kind === 'Pod') {
      if (!e.involvedObject.uid || !notStarted.has(e.involvedObject.uid)) continue;
      owner = notStarted.get(e.involvedObject.uid) ?? null;
    } else {
      const seen = eventLastSeenMs(e);
      // An event nobody can date is not evidence of the present.
      if (seen === null || nowMs - seen > RECENT_EVENT_MS) continue;
      if (e.involvedObject?.kind === 'ReplicaSet') owner = deploymentOfReplicaSet(e.involvedObject.name);
    }
    out.push({ owner, msg: `${e.reason ?? 'Warning'}: ${e.message}` });
  }
  return out;
}

/** The evidence about one Deployment: its own, plus what cannot be attributed to any. Pure. */
export function evidenceFor(workload: string, evidence: readonly OwnedEvidence[]): string[] {
  return evidence.filter((e) => e.owner === null || e.owner === workload).map((e) => e.msg).slice(0, 20);
}

/** The namespace's present pod states and events — where FailedMount/globalmount shows up. */
async function podMessagesFor(k8s: K8sClients, namespace: string): Promise<OwnedEvidence[]> {
  let pods: readonly EvidencePod[] = [];
  let events: readonly EvidenceEvent[] = [];
  try {
    pods = (await k8s.core.listNamespacedPod({ namespace } as never) as { items?: EvidencePod[] }).items ?? [];
  } catch { /* best-effort enrichment only */ }
  try {
    events = (await (k8s.core as unknown as {
      listNamespacedEvent: (a: { namespace: string }) => Promise<{ items?: EvidenceEvent[] }>;
    }).listNamespacedEvent({ namespace })).items ?? [];
  } catch { /* events may be rotated or RBAC-restricted */ }
  return currentEvidenceByOwner(pods, events, Date.now());
}

const QUOTA_KEYS = ['requests.cpu', 'requests.memory', 'limits.cpu', 'limits.memory'] as const;

interface PodResourceSpec {
  readonly resources?: { readonly requests?: Record<string, string>; readonly limits?: Record<string, string> };
}

/** What one pod counts against a quota per key: containers summed, or the largest init container if bigger. Pure. */
export function podQuotaHolds(spec: {
  readonly containers?: readonly PodResourceSpec[];
  readonly initContainers?: readonly PodResourceSpec[];
}): Record<string, string> {
  const read = (c: PodResourceSpec, key: (typeof QUOTA_KEYS)[number]): number => {
    const [kind, res] = key.split('.') as ['requests' | 'limits', string];
    const v = c.resources?.[kind]?.[res];
    return v === undefined ? 0 : (parseK8sQuantity(v) ?? 0);
  };
  const out: Record<string, string> = {};
  for (const key of QUOTA_KEYS) {
    const sum = (spec.containers ?? []).reduce((s, c) => s + read(c, key), 0);
    const init = Math.max(0, ...(spec.initContainers ?? []).map((c) => read(c, key)));
    const v = Math.max(sum, init);
    if (v > 0) out[key] = String(v);
  }
  return out;
}

/**
 * The namespace's quotas and what its terminating pods still hold — what a
 * quota refusal is judged against (quota-refusal.ts). Empty on a read
 * failure, which the verdict reads as "cannot tell": no restart.
 */
async function quotaFactsFor(k8s: K8sClients, namespace: string): Promise<{
  quotas: Map<string, LiveQuota>; terminating: TerminatingPod[];
}> {
  const quotas = new Map<string, LiveQuota>();
  const terminating: TerminatingPod[] = [];
  try {
    const list = await (k8s.core as unknown as {
      listNamespacedResourceQuota: (a: { namespace: string }) => Promise<{ items?: Array<{
        metadata?: { name?: string };
        spec?: { hard?: Record<string, string>; scopeSelector?: { matchExpressions?: Array<{ scopeName?: string; operator?: string; values?: string[] }> } };
        status?: { hard?: Record<string, string>; used?: Record<string, string> };
      }> }>;
    }).listNamespacedResourceQuota({ namespace });
    for (const q of list.items ?? []) {
      const name = q.metadata?.name;
      if (!name) continue;
      const pc = (q.spec?.scopeSelector?.matchExpressions ?? [])
        .find((e) => e.scopeName === 'PriorityClass' && e.operator === 'In');
      quotas.set(name, {
        hard: q.status?.hard ?? q.spec?.hard ?? {},
        used: q.status?.used ?? {},
        priorityClasses: pc?.values ?? null,
      });
    }
    const pods = await k8s.core.listNamespacedPod({ namespace } as never) as {
      items?: Array<{ metadata?: { deletionTimestamp?: unknown }; spec?: { priorityClassName?: string } & Parameters<typeof podQuotaHolds>[0] }>;
    };
    for (const p of pods.items ?? []) {
      if (!p.metadata?.deletionTimestamp || !p.spec) continue;
      terminating.push({ priorityClassName: p.spec.priorityClassName ?? null, holds: podQuotaHolds(p.spec) });
    }
  } catch (err) {
    console.warn(`[workload-health] ${namespace}: quota read failed, a quota refusal cannot be judged: ${err instanceof Error ? err.message : String(err)}`);
    return { quotas: new Map(), terminating: [] };
  }
  return { quotas, terminating };
}

/**
 * How often an outage that has outlived its grace window is diagnosed afresh.
 * Until then it is read on every tick — that is when the diagnosis decides
 * anything. Afterwards the cause seldom changes, and a tenant with a bad image
 * reference would otherwise cost a pod list and an event list a minute for as
 * long as it stays broken.
 */
const EVIDENCE_REFRESH_MS = 5 * 60 * 1000;

/** Per namespace: since when THIS process has seen it down, and the evidence it last read. */
const evidenceSeen = new Map<string, { since: number; at: number; msgs: OwnedEvidence[] }>();

/** Whether the namespace's evidence has to be read again. Pure. */
export function evidenceIsStale(seen: { since: number; at: number } | undefined, nowMs: number): boolean {
  if (!seen) return true;
  if (nowMs - seen.since < GRACE_MS) return true;
  return nowMs - seen.at >= EVIDENCE_REFRESH_MS;
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
    // quiesce -> unquiesce: `quiesce` captures the CURRENT replica counts, which
    // are all 0, so the restore would faithfully put it back to 0. The intended
    // counts have to come from whatever recorded them BEFORE the scale-down.
    if (strandedAtZero) {
      // ── Work out what THIS tenant's workloads should be running ──
      //
      // Preferred source: the pre-quiesce replica count stamped on each held
      // Deployment by the quiesce that scaled it down. It is local to the
      // namespace, per-workload, and cannot name a workload that belongs to
      // another tenant or no longer exists.
      const here = (await listTenantDeployments(k8s)).filter((d) => d.namespace === namespace);
      const stranded = here.filter((d) => d.desired === 0 && d.held);
      if (stranded.length === 0) {
        // Raced with something that already restored it. Not a failure.
        await releaseTenant(false, null);
        return;
      }
      const annotated = stranded.filter((d) => d.preQuiesceReplicas !== null);

      let snapshot: QuiesceSnapshot | null = null;
      let source = '';
      if (annotated.length === stranded.length) {
        snapshot = {
          deployments: annotated.map((d) => ({ name: d.name, replicas: d.preQuiesceReplicas as number })),
          cronJobs: [],
        };
        source = 'the pre-quiesce replica annotations on the held Deployments';
      } else {
        // ── Fallback for workloads quiesced before the annotation existed ──
        //
        // Historical behaviour was "take the tenant's most recent operation that
        // carries a snapshot". That op is not necessarily the one that stranded
        // this tenant: it can predate workloads added since, list workloads since
        // deleted, or be an unrelated earlier operation. So candidates are now
        // VALIDATED against the workloads actually stranded right now, newest
        // first, and the first one that covers them all wins. An op that covers
        // only some of them is rejected outright rather than used to restore a
        // subset — a partial restore leaves the tenant down while reporting
        // success, which is the failure mode this whole reconciler exists for.
        const strandedNames = new Set(stranded.map((d) => d.name));
        const cands = await db.execute<{ id: string; snap: unknown }>(sql`
          SELECT id, params -> 'quiesceSnapshot' AS snap
            FROM storage_operations
           WHERE tenant_id = ${tenantId}
             AND id <> ${opId}
             AND params -> 'quiesceSnapshot' IS NOT NULL
           ORDER BY created_at DESC
           LIMIT 20
        `);
        const rejected: string[] = [];
        for (const row of cands.rows ?? []) {
          const snap = row.snap as QuiesceSnapshot | null;
          const deps = (snap?.deployments ?? []).filter((d) => d.replicas > 0);
          const covered = [...strandedNames].every((n) => deps.some((d) => d.name === n));
          if (!covered) {
            const missing = [...strandedNames].filter((n) => !deps.some((d) => d.name === n));
            rejected.push(`${row.id.slice(0, 8)} (missing ${missing.join(',')})`);
            continue;
          }
          // Restore ONLY the stranded workloads. Replaying the whole snapshot
          // could scale up a workload the operator has since deliberately set to
          // 0, or one that no longer exists.
          snapshot = {
            deployments: deps.filter((d) => strandedNames.has(d.name)),
            cronJobs: [],
          };
          source = `storage operation ${row.id.slice(0, 8)} (validated against the stranded workloads)`;
          break;
        }
        if (!snapshot) {
          // Nothing trustworthy to restore from. Dropping the holds at least
          // re-enables reactive auto-start; the counts are not recoverable
          // automatically, and the caller turns this into an operator alert.
          const { clearQuiesceHold } = await import('./quiesce.js');
          await clearQuiesceHold(k8s, namespace);
          throw new Error(
            `${namespace} is held at 0 replicas (${[...strandedNames].join(', ')}) and nothing records what it should be running: `
            + `no pre-quiesce replica annotation, and ${(cands.rows ?? []).length} recent operation snapshot(s) did not cover it`
            + `${rejected.length ? ` — rejected ${rejected.join('; ')}` : ''}. `
            + 'Holds cleared so auto-start works again; the intended replica counts need an operator.',
          );
        }
      }

      console.warn(
        `[workload-health] ${namespace}: restoring ${snapshot.deployments.map((d) => `${d.name}->${d.replicas}`).join(', ')} from ${source}`,
      );
      // unquiesce (not unquiesceBestEffort) so a failure to come back up THROWS
      // and the caller records it, rather than being swallowed.
      await unquiesce(k8s, namespace, snapshot);
      // Prove the outcome against the cluster rather than trusting the call.
      const stillDown = (await listTenantDeployments(k8s))
        .filter((d) => d.namespace === namespace)
        .filter((d) => (d.desired === 0 && d.held) || (d.desired > 0 && d.available < d.desired));
      if (stillDown.length > 0) {
        throw new Error(
          `${namespace} still has ${stillDown.length} workload(s) down after restoring from ${source}: `
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

/** Ready per node name. Empty when the list fails — then no node counts as down. */
async function nodeReadiness(k8s: K8sClients): Promise<Map<string, boolean>> {
  try {
    const list = await k8s.core.listNode();
    return new Map((list.items ?? []).map((n) => [
      n.metadata?.name ?? '',
      (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
    ]));
  } catch (err) {
    console.warn(`[workload-health] node list failed, pinned-node check skipped: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}

/** See the call site. Never throws: one tenant's error must not stop the sweep. */
async function resetRecoveredAutohealFailures(
  db: Database,
  k8s: K8sClients,
  deployments: readonly DeploymentView[],
  byNs: ReadonlyMap<string, { id: string; status: string; lifecycle_state: string; active_op_id: string | null }>,
  downByNs: ReadonlyMap<string, DeploymentView[]>,
): Promise<void> {
  for (const ns of new Set(deployments.map((d) => d.namespace))) {
    const t = byNs.get(ns);
    if (!t || t.status !== 'active' || t.lifecycle_state !== 'failed' || t.active_op_id !== null) continue;
    if (downByNs.has(ns)) continue;
    const mine = deployments.filter((d) => d.namespace === ns);
    // A hold on a workload that is back at its replica count is a leftover,
    // not an outage: the heal that set it gave up while the workload could
    // not be admitted, and it came up later by itself. Production: sitewright
    // ran 1/1 under its hold, and this reset waited for the 15-minute
    // watchdog while the tenant panel kept saying a storage operation failed.
    // Held at 0 is still stranded and still blocks.
    if (mine.some((d) => (d.held && d.desired === 0) || (d.desired > 0 && d.available < d.desired))) continue;
    const staleHolds = mine.filter((d) => d.held);
    try {
      const res = await db.execute(sql`
        UPDATE tenants
           SET storage_lifecycle_state = 'idle'
         WHERE id = ${t.id}
           AND storage_lifecycle_state = 'failed'
           AND active_storage_op_id IS NULL
           AND (SELECT so.op_type::text || ':' || so.state::text
                  FROM storage_operations so
                 WHERE so.tenant_id = ${t.id}
                 ORDER BY so.created_at DESC
                 LIMIT 1) = 'autoheal:failed'
      `);
      if ((res.rowCount ?? 0) > 0) {
        console.warn(`[workload-health] ${ns}: every workload is up again — storage state FAILED, left by a failed auto-heal, reset to idle`);
        if (staleHolds.length > 0) {
          // Best-effort: watchdog Leg B clears whatever this misses. Only while
          // no operation has claimed the tenant since the reset above — a hold
          // set by a NEW operation is not ours to clear.
          const [owner] = (await db.execute<{ op: string | null }>(sql`
            SELECT active_storage_op_id AS op FROM tenants WHERE id = ${t.id}
          `)).rows ?? [];
          if (owner && owner.op === null) {
            const { clearQuiesceHold } = await import('./quiesce.js');
            for (const d of staleHolds) await clearQuiesceHold(k8s, ns, d.name);
          }
        }
      }
    } catch (err) {
      console.warn(`[workload-health] resetting the failed state of ${ns} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Send the down alerts claimed this tick, grouped (workload-alerts.ts). A
 * group goes out when at least one of its episodes claimed a ladder slot; it
 * lists every episode of the group that reached the alert stage. Returns how
 * many admin alerts were sent.
 */
async function dispatchDownAlerts(
  db: Database,
  alertRows: readonly AlertRow[],
  claimed: ReadonlyArray<{ row: AlertRow; notifyCount: number; lastNotifiedAt: string | null }>,
): Promise<number> {
  if (claimed.length === 0) return 0;
  const { notifyAdminTenantWorkloadsDown, notifyTenantWorkloadsDown } = await import('../notifications/events.js');
  let sent = 0;
  for (const g of groupAlerts(alertRows, labelForReason)) {
    const mine = claimed.filter((c) => alertGroupKey(c.row) === g.key);
    if (mine.length === 0) continue;
    // dedupeKey keyed on the EPISODES this alert announces and their ladder
    // round (claimedEpisodesKey), never on a wall-clock bucket: a bucket whose
    // width matches the caller's period deduplicates nothing.
    const adminSent = await notifyAdminTenantWorkloadsDown(db, {
      tenantName: g.subject,
      namespace: g.key.startsWith('node:') ? '' : g.namespace,
      workloads: cappedList(g.workloads),
      downSince: g.downSince,
      downMinutes: String(g.downMinutes),
      reason: g.reason,
      // Derived from the PERSISTED reason, never re-parsed from the truncated
      // `detail` column — see REASON_LABELS.
      reasonLabel: labelForReason(g.reason),
      detail: g.detail ?? undefined,
      healSummary: healSummary(g.attempts),
      lastHealError: g.lastHealError ?? undefined,
      recommendedAction: recommendedAction(g.reason, g.detail),
    }, `workloads-down:${g.key}:admin:${claimedEpisodesKey(mine)}`);

    // The ADMIN copy is the one that matters: it is the alert whose absence let a
    // tenant stay down for 18 hours. If it did not go out, GIVE THE LADDER SLOTS
    // BACK so the next tick retries instead of deferring by the ladder step
    // (1h → 6h → daily) over a delivery that never happened.
    if (!adminSent.ok) {
      for (const c of mine) {
        await db.execute(sql`
          UPDATE tenant_workload_health_events
             SET last_notified_at = ${c.lastNotifiedAt}, notify_count = ${c.notifyCount}
           WHERE tenant_id = ${c.row.tenantId} AND workload = ${c.row.workload}
             AND cleared_at IS NULL
        `);
      }
      console.error(
        `[workload-health] ADMIN alert for ${g.subject} did NOT dispatch `
        + `(${adminSent.error ?? 'unknown'}) — ladder slots released, retrying next tick`,
      );
      continue;
    }
    sent += 1;
  }

  // The tenant's own copy: one per tenant, its workloads as a list.
  const claimedTenants = new Set(claimed.map((c) => c.row.tenantId));
  for (const t of workloadsByTenant(alertRows.filter((r) => claimedTenants.has(r.tenantId)))) {
    const mine = claimed.filter((c) => c.row.tenantId === t.tenantId);
    const res = await notifyTenantWorkloadsDown(db, t.tenantId, {
      workloads: cappedList(t.workloads),
      downSince: t.downSince,
      reasonLabel: labelForReason(t.reason),
    }, `workloads-down:tenant:${t.tenantId}:${claimedEpisodesKey(mine)}`);
    // Informational, and its address may simply be undeliverable; it never
    // holds the admin ladder back.
    if (!res.ok) console.warn(`[workload-health] tenant copy for ${t.tenantId} did not dispatch: ${res.error ?? 'unknown'}`);
  }
  return sent;
}

/** "Back up" for episodes that had alerted — same grouping as the alert. Never throws. */
async function dispatchRecoveries(db: Database, recovered: readonly AlertRow[]): Promise<void> {
  if (recovered.length === 0) return;
  try {
    const { notifyAdminTenantWorkloadsRecovered, notifyTenantWorkloadsRecovered } = await import('../notifications/events.js');
    for (const g of groupAlerts(recovered)) {
      await notifyAdminTenantWorkloadsRecovered(db, {
        tenantName: g.subject,
        workloads: cappedList(g.workloads),
        downSince: g.downSince,
        downMinutes: String(g.downMinutes),
      }, `workloads-recovered:${g.key}:${g.downSince}`);
    }
    for (const t of workloadsByTenant(recovered)) {
      await notifyTenantWorkloadsRecovered(db, t.tenantId, {
        workloads: cappedList(t.workloads),
        downSince: t.downSince,
      }, `workloads-recovered:tenant:${t.tenantId}:${t.downSince}`);
    }
  } catch (err) {
    console.warn(`[workload-health] recovery notices failed: ${err instanceof Error ? err.message : String(err)}`);
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
    lifecycle_state: string; active_op_id: string | null; pin: string | null;
  }>(sql`
    SELECT id, name, kubernetes_namespace AS namespace, status::text AS status,
           storage_lifecycle_state::text AS lifecycle_state,
           active_storage_op_id AS active_op_id, node_name AS pin
      FROM tenants
  `);
  const byNs = new Map((tenantRows.rows ?? []).map((t) => [t.namespace, t]));
  const byId = new Map((tenantRows.rows ?? []).map((t) => [t.id, t]));
  const readyByNode = await nodeReadiness(k8s);

  // Episodes that had alerted and are over: reported back in the shape the
  // outage was reported (workload-alerts.ts).
  const recovered: AlertRow[] = [];
  const noteRecovered = (
    tenantId: string, workload: string,
    rows: ReadonlyArray<{ notify_count: number; reason: string; first_seen_at: string | Date; down_minutes: number }>,
  ) => {
    const t = byId.get(tenantId);
    for (const r of rows) {
      if (!t || r.notify_count <= 0) continue;
      recovered.push({
        tenantId, tenantName: t.name, namespace: t.namespace, workload, reason: r.reason as HealReason,
        detail: null, downMinutes: r.down_minutes, firstSeenAt: new Date(r.first_seen_at).toISOString(),
        attempts: 0, lastHealError: null, pin: t.pin,
      });
    }
  };

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
        const res = await db.execute<{ notify_count: number; reason: string; first_seen_at: string; down_minutes: number }>(sql`
          UPDATE tenant_workload_health_events
             SET cleared_at = now(), available_replicas = ${d.available}
           WHERE tenant_id = ${tenant.id} AND workload = ${d.name} AND cleared_at IS NULL
          RETURNING notify_count, reason, first_seen_at,
                    FLOOR(EXTRACT(EPOCH FROM (now() - first_seen_at)) / 60)::int AS down_minutes
        `);
        if ((res.rowCount ?? 0) > 0) episodesCleared += 1;
        noteRecovered(tenant.id, d.name, res.rows ?? []);
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

  // A namespace that is up again starts from scratch the next time it is down.
  for (const namespace of [...evidenceSeen.keys()]) {
    if (!downByNs.has(namespace)) evidenceSeen.delete(namespace);
  }

  for (const [namespace, downs] of downByNs) {
    const tenant = byNs.get(namespace)!;
    const nowMs = Date.now();
    let seen = evidenceSeen.get(namespace);
    if (!seen || evidenceIsStale(seen, nowMs)) {
      seen = { since: seen?.since ?? nowMs, at: nowMs, msgs: await podMessagesFor(k8s, namespace) };
      evidenceSeen.set(namespace, seen);
    }
    const podMsgs = seen.msgs;

    const deadNode = pinnedNodeDown(tenant.pin, readyByNode);
    for (const d of downs) {
      const stranded = d.desired === 0 && d.held;
      const { reason, detail } = deadNode
        ? { reason: 'node_down' as HealReason, detail: `Pinned to ${deadNode}, which is not Ready.` }
        : stranded
          ? {
              reason: 'stranded_at_zero' as HealReason,
              detail: 'Deployment is at 0 replicas with the storage-quiesce hold still set — '
                + 'a storage operation scaled it down and never successfully scaled it back up.',
            }
          : classifyUnavailability(d.replicaFailure, evidenceFor(d.name, podMsgs));
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
               --
               -- The node coming BACK also restarts the clock: while it was
               -- down the episode aged past the grace window, so the first
               -- tick after its return (pods still re-attaching their volumes,
               -- as every rebooted node's do) would scale the tenant down for
               -- a heal at once. Lab staging: a heal fired two minutes after
               -- the node returned. A cause that follows node_down gets its
               -- own grace window and its own heal budget.
               first_seen_at = CASE WHEN tenant_workload_health_events.cleared_at
                                         < now() - ${FLAP_QUIET_SQL}::interval
                                    THEN now()
                                    WHEN tenant_workload_health_events.reason = 'node_down'
                                         AND EXCLUDED.reason <> 'node_down'
                                    THEN now()
                                    ELSE tenant_workload_health_events.first_seen_at END,
               heal_attempts = CASE WHEN tenant_workload_health_events.cleared_at
                                         < now() - ${FLAP_QUIET_SQL}::interval
                                    THEN 0
                                    WHEN tenant_workload_health_events.reason = 'node_down'
                                         AND EXCLUDED.reason <> 'node_down'
                                    THEN 0
                                    ELSE tenant_workload_health_events.heal_attempts END,
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

  // A tenant the auto-heal gave up on stays storage-state FAILED — which
  // refuses every later resize, restore, suspend or move — even after its
  // workloads came back on their own. Production: the heal waited
  // out a node outage, gave up seconds before the node returned, and left
  // the tenant FAILED with nothing on screen saying so. Once every workload is
  // up and none still carries the quiesce hold, a FAILED whose last operation
  // is that auto-heal is over. A failed resize/restore/fsck stays FAILED:
  // those need the operator.
  await resetRecoveredAutohealFailures(db, k8s, deployments, byNs, downByNs);

  // ── Act on episodes that have outlived the grace window ──
  const due = await db.execute<{
    tenant_id: string; workload: string; namespace: string; reason: string;
    detail: string | null; heal_attempts: number; last_heal_error: string | null;
    first_seen_at: string; down_minutes: number; notify_count: number;
    last_notified_at: string | null; tenant_name: string; pin: string | null;
    ns_attempts: number;
  }>(sql`
    SELECT e.tenant_id, e.workload, e.namespace, e.reason, e.detail,
           e.heal_attempts, e.last_heal_error, e.first_seen_at,
           -- The heal budget is the NAMESPACE's: a heal restarts every workload
           -- in it, whichever one's episode claimed it. Per-episode budgets let
           -- two workloads that knocked each other out take turns — production:
           -- two full restarts three and a half minutes apart. Episodes closed
           -- within the flap window still count, as they do for one workload.
           COALESCE((SELECT MAX(x.heal_attempts) FROM tenant_workload_health_events x
                      WHERE x.tenant_id = e.tenant_id AND x.namespace = e.namespace
                        AND (x.cleared_at IS NULL OR x.cleared_at > now() - ${FLAP_QUIET_SQL}::interval)), 0)::int
             AS ns_attempts,
           FLOOR(EXTRACT(EPOCH FROM (now() - e.first_seen_at)) / 60)::int AS down_minutes,
           e.notify_count, e.last_notified_at, t.name AS tenant_name, t.node_name AS pin
      FROM tenant_workload_health_events e
      JOIN tenants t ON t.id = e.tenant_id
     WHERE e.cleared_at IS NULL
       AND ${episodePastGraceSql()}
       AND t.status = 'active'
       AND t.active_storage_op_id IS NULL
     ORDER BY e.first_seen_at ASC
  `);

  const healedNamespaces = new Set<string>();
  const failedNamespaces = new Set<string>();
  // Per namespace, read once per tick and only when a quota refusal is due.
  const quotaVerdicts = new Map<string, QuotaVerdict>();
  const quotaVerdictFor = async (namespace: string): Promise<QuotaVerdict> => {
    const known = quotaVerdicts.get(namespace);
    if (known) return known;
    const refusals = (due.rows ?? [])
      .filter((r) => r.namespace === namespace && r.reason === 'quota_rejected')
      .map((r) => refusalForWorkload(r.detail, r.workload))
      .filter((r): r is QuotaRefusal => r !== null);
    const facts = await quotaFactsFor(k8s, namespace);
    const verdict = quotaRefusalVerdict(refusals, facts.quotas, facts.terminating);
    quotaVerdicts.set(namespace, verdict);
    return verdict;
  };
  // Collected through the loop and dispatched after it, grouped: one alert
  // per tenant (per node when the node is the cause), never one per workload.
  const alertRows: AlertRow[] = [];
  const claimed: Array<{ row: AlertRow; notifyCount: number; lastNotifiedAt: string | null }> = [];

  for (const row of due.rows ?? []) {
    const reason = row.reason as HealReason;
    const quota = reason === 'quota_rejected' ? await quotaVerdictFor(row.namespace) : null;
    const healable = healableNow(reason, quota);
    const nsAttempts = Math.max(row.ns_attempts ?? 0, row.heal_attempts);
    if (failedNamespaces.has(row.namespace)) {
      // One heal per namespace per tick — the action is namespace-wide.
    } else if (
      !healedNamespaces.has(row.namespace)
      && nsAttempts < MAX_HEAL_ATTEMPTS
      && healable
    ) {
      // Claim the attempt. A single conditional UPDATE across every open
      // episode in this namespace, so exactly one api replica proceeds and the
      // backoff is enforced in the database rather than in each process.
      //
      // Scoped by tenant_id AND namespace. `tenants_namespace_unique` makes the
      // namespace sufficient today, but a heal SCALES WORKLOADS TO ZERO — it is
      // not a statement to leave resting on one uniqueness index in another
      // table. Both columns are on the row; use both.
      const backoffSec = Math.round(
        (HEAL_BACKOFF_BASE_MS * Math.pow(4, nsAttempts)) / 1000,
      );
      const backoff = `${backoffSec} seconds`;
      // The per-row conditions are the cross-replica guard: a second replica's
      // UPDATE waits on the first one's row locks and re-checks them against
      // the rows the first one just stamped. The NOT EXISTS is the namespace's
      // budget — it sees the episodes this statement does not update.
      const claim = await db.execute(sql`
        UPDATE tenant_workload_health_events
           SET heal_attempts = ${nsAttempts + 1}, last_heal_at = now()
         WHERE tenant_id = ${row.tenant_id}
           AND namespace = ${row.namespace}
           AND cleared_at IS NULL
           AND heal_attempts < ${MAX_HEAL_ATTEMPTS}
           AND (last_heal_at IS NULL OR last_heal_at < now() - ${backoff}::interval)
           AND NOT EXISTS (
             SELECT 1 FROM tenant_workload_health_events x
              WHERE x.tenant_id = ${row.tenant_id}
                AND x.namespace = ${row.namespace}
                AND (x.cleared_at IS NULL OR x.cleared_at > now() - ${FLAP_QUIET_SQL}::interval)
                AND (x.heal_attempts >= ${MAX_HEAL_ATTEMPTS} OR x.last_heal_at > now() - ${backoff}::interval))
      `);
      if ((claim.rowCount ?? 0) > 0) {
        healAttempted += 1;
        console.warn(
          `[workload-health] ${row.namespace}/${row.workload} unavailable for ${row.down_minutes}min `
          + `(${row.reason}) — attempt ${nsAttempts + 1}/${MAX_HEAL_ATTEMPTS}: re-staging the volume`,
        );
        try {
          await healNamespace(
            db, k8s, row.namespace, `${row.namespace}-storage`,
            row.reason === 'stranded_at_zero', row.tenant_id,
          );
          // Record the attempt as successful only against OBSERVED recovery:
          // unquiesce now verifies availability, so returning without throwing
          // means the replicas are actually up.
          const closed = await db.execute<{ workload: string; notify_count: number; reason: string; first_seen_at: string; down_minutes: number }>(sql`
            UPDATE tenant_workload_health_events
               SET healed_at = now(), cleared_at = now(), last_heal_error = NULL
             WHERE tenant_id = ${row.tenant_id}
               AND namespace = ${row.namespace} AND cleared_at IS NULL
            RETURNING workload, notify_count, reason, first_seen_at,
                      FLOOR(EXTRACT(EPOCH FROM (now() - first_seen_at)) / 60)::int AS down_minutes
          `);
          for (const c of closed.rows ?? []) noteRecovered(row.tenant_id, c.workload, [c]);
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
             WHERE tenant_id = ${row.tenant_id}
               AND namespace = ${row.namespace} AND cleared_at IS NULL
          `);
          console.error(`[workload-health] ${row.namespace} auto-heal FAILED: ${msg}`);
        }
      }
    }

    // ── Alert. Only reached when healing was tried and did not fix it, or the
    // attempt budget is spent. The ladder stops it becoming wallpaper.
    const attempts = failedNamespaces.has(row.namespace) ? nsAttempts + 1 : nsAttempts;
    // Alert when auto-heal has been tried and failed, when its budget is spent,
    // or when the cause is one auto-heal deliberately will not attempt — in that
    // last case the budget is never spent, so waiting for it would mean a tenant
    // with a bad image stays down and silent forever.
    const notHealable = !healable;
    const exhausted = failedNamespaces.has(row.namespace)
      || attempts >= MAX_HEAL_ATTEMPTS
      || notHealable;
    if (!exhausted) continue;

    const alertRow: AlertRow = {
      tenantId: row.tenant_id, tenantName: row.tenant_name, namespace: row.namespace, workload: row.workload,
      reason: (row.reason as HealReason) || 'unknown', detail: row.detail, downMinutes: row.down_minutes,
      firstSeenAt: new Date(row.first_seen_at).toISOString(), attempts,
      lastHealError: row.last_heal_error, pin: row.pin,
    };
    alertRows.push(alertRow);

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
    claimed.push({ row: alertRow, notifyCount: row.notify_count, lastNotifiedAt: row.last_notified_at });
  }

  alerted += await dispatchDownAlerts(db, alertRows, claimed);
  await dispatchRecoveries(db, recovered);

  // GC the audit tail.
  await db.execute(sql`
    DELETE FROM tenant_workload_health_events
     WHERE cleared_at IS NOT NULL
       AND cleared_at < now() - ${`${Math.round(CLEARED_RETENTION_MS / 1000)} seconds`}::interval
  `);

  return { observedDown, episodesOpened, episodesCleared, healAttempted, healed, alerted };
}
