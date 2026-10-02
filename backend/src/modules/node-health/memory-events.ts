/**
 * Node memory events — kernel OOM kills, container OOM kills and kubelet pod
 * evictions (operator decision: all must be UI-visible and reach admins).
 *
 * Fed by the node-health reconciler's 5-min tick with the raw k8s Event lists
 * (reason=Evicted for Pods, reason=SystemOOM for Nodes, reason=Killing for
 * probe restarts), every pod's container statuses, and the security-probe's
 * OOM witness (oom-witness.ts). Each distinct occurrence is persisted once to
 * `node_memory_events` for the admin UI, with a `cause` that says only what is
 * known; NEW rows are announced by memory-event-notify.ts.
 *
 * Dedupe layers: the UNIQUE dedupe_key column makes ingestion exactly-once
 * across replicas and restarts; the dispatcher dedupe keys stop a re-sent
 * notification; the category rate limits back-stop bursts.
 */

import { inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { nodeMemoryEvents, tenants } from '../../db/schema.js';
import type { NodeMemoryEvent, NodeMemoryEventCause } from '@insula/api-contracts';
import { classifyOom, isExpectedSigkill } from '../../lib/container-termination.js';
import { isSystemNamespace } from '../../lib/namespace-tier.js';
import { judgeKills, type KillCause, type OomWitness } from './oom-witness.js';
import { notifyMemoryEvents } from './memory-event-notify.js';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // UI window: 30 days

/**
 * Tenant vs platform is decided by `lib/namespace-tier.ts` — see there for why
 * this is a prefix rule and not the allowlist it used to be. In short: the old
 * list named 9 of production's 27 namespaces and reported the other eleven
 * platform ones as *tenants*, which is how an admin came to be told that
 * tenant "traefik" was over its memory limit.
 *
 * One refinement for container kills: a pod labelled `platform.io/system:
 * "true"` (the file manager, the SFTP helper, …) lives in a TENANT namespace
 * but is sized by the platform, not the tenant's plan. Telling an admin to
 * raise the tenant's plan for it would be wrong, so it counts as platform.
 */
const PLATFORM_MANAGED_LABEL = 'platform.io/system';

/** Raw k8s Event fields the collector reads (superset of the reconciler's RawEvent). */
export interface RawMemoryEvent {
  readonly reason?: string;
  readonly message?: string;
  readonly count?: number;
  readonly involvedObject?: {
    readonly kind?: string;
    readonly name?: string;
    readonly namespace?: string;
  };
  readonly source?: { readonly host?: string };
  readonly reportingInstance?: string;
  readonly metadata?: { readonly uid?: string; readonly creationTimestamp?: string };
  readonly eventTime?: string;
  readonly lastTimestamp?: string;
  readonly firstTimestamp?: string;
}

/** Container-kill causes that are reported; `not-oom` never is. */
export type ReportedKillCause = Exclude<KillCause, 'not-oom'>;

export interface NormalizedMemoryEvent {
  readonly dedupeKey: string;
  readonly kind: 'system-oom' | 'pod-evicted' | 'container-oom';
  readonly cause: NodeMemoryEventCause;
  readonly nodeName: string;
  readonly namespace: string | null;
  readonly podName: string | null;
  /** OOM-killed container name (container-oom only); null for pod/node events. */
  readonly containerName: string | null;
  readonly systemWorkload: boolean;
  /**
   * A platform-sized pod in a TENANT namespace (file manager, …). Only set for
   * container kills; such a kill is a platform kill even though the namespace
   * names a tenant.
   */
  readonly platformManaged?: boolean;
  /** container-oom only: what the dispatcher dedupes a per-kill alert on. */
  readonly podUid?: string;
  readonly restartCount?: number;
  readonly message: string;
  readonly occurredAt: Date;
}

/** Pod fields the container-OOM collector reads. */
export interface RawPod {
  readonly metadata?: {
    readonly uid?: string;
    readonly name?: string;
    readonly namespace?: string;
    readonly labels?: Readonly<Record<string, string>>;
    /**
     * Set the moment a pod starts terminating. Its containers are about to be
     * SIGKILLed by design, so exit 137 there means nothing — see the
     * terminating-pod check in collectOomKilledContainers().
     */
    readonly deletionTimestamp?: string;
  };
  readonly spec?: { readonly nodeName?: string };
  readonly status?: {
    /**
     * Pod-level reason. `Terminated` / `NodeShutdown` mean the kubelet killed
     * or refused this pod for a node shutdown — its exit 137s are by design.
     * Distinct from the CONTAINER's `terminated.reason` read below.
     */
    readonly reason?: string;
    readonly containerStatuses?: ReadonlyArray<{
      readonly name?: string;
      readonly restartCount?: number;
      readonly state?: { readonly terminated?: RawTermination };
      readonly lastState?: { readonly terminated?: RawTermination };
    }>;
  };
}
interface RawTermination {
  readonly reason?: string;
  readonly exitCode?: number;
  readonly finishedAt?: string;
  /** `containerd://<64 hex>` — names the container's own cgroup to the witness. */
  readonly containerID?: string;
}

/** `containerd://<id>` / `cri-o://<id>` → `<id>`. */
function bareContainerId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const id = raw.replace(/^[a-z-]+:\/\//, '');
  return id.length > 0 ? id : undefined;
}

/**
 * Containers the kubelet killed because a probe failed, indexed as
 * `<namespace>/<pod>/<container>` with the times it said so.
 *
 * WHY
 * ---
 * A failed liveness/startup probe makes the kubelet SIGKILL the container, which
 * is exit 137 — indistinguishable from a cgroup OOM by exit code alone, exactly
 * like the node-shutdown case. Unlike that one the pod stays RUNNING and the
 * container restarts, so none of the pod-level shutdown markers apply and
 * isExpectedSigkill() correctly does not fire.
 *
 * Found by a real DEV reboot, after the node-shutdown fix: the
 * reboot produced no false tenant OOM alerts, but still raised a CRITICAL
 * "Node memory event" for two crowdsec containers. The kernel logged ZERO
 * cgroup OOMs for that boot, and the kubelet had already explained itself:
 *
 *   Normal   Killing    Container crowdsec failed liveness probe, will be restarted
 *   Warning  Unhealthy  Liveness probe failed: … connect: connection refused
 *
 * crowdsec is simply slow to answer /health after a cold boot. Believe the
 * kubelet: it names the cause, so an inference must not overrule it.
 *
 * Matches the kubelet's own message format (`kubelet/prober`). Startup probes
 * are included — they kill the same way.
 */
export function indexProbeKills(
  events: ReadonlyArray<RawMemoryEvent>,
): Map<string, Date[]> {
  const out = new Map<string, Date[]>();
  for (const e of events) {
    if (e.reason !== 'Killing') continue;
    const msg = e.message ?? '';
    // "Container <name> failed liveness probe, will be restarted"
    const m = /Container (\S+) failed (?:liveness|startup) probe/.exec(msg);
    if (!m) continue;
    const ns = e.involvedObject?.namespace;
    const pod = e.involvedObject?.name;
    if (!ns || !pod) continue;
    const at = eventTimestamp(e);
    if (!at) continue;
    const key = `${ns}/${pod}/${m[1]}`;
    const list = out.get(key);
    if (list) list.push(at); else out.set(key, [at]);
  }
  return out;
}

/**
 * How far apart a probe-kill event and the container termination it explains
 * may be. The kubelet posts the event as it kills, so these are near-
 * simultaneous; the window only absorbs clock skew and event-time rounding.
 */
const PROBE_KILL_WINDOW_MS = 5 * 60 * 1000;

function killedByProbe(
  index: ReadonlyMap<string, Date[]>,
  namespace: string | null,
  podName: string | null,
  containerName: string,
  finishedAt: Date,
): boolean {
  if (!namespace || !podName) return false;
  const times = index.get(`${namespace}/${podName}/${containerName}`);
  if (!times) return false;
  return times.some((t) => Math.abs(t.getTime() - finishedAt.getTime()) <= PROBE_KILL_WINDOW_MS);
}

/**
 * Containers killed by SIGKILL (exit 137) or reported OOMKilled, read from
 * container STATUS (containerd-sourced) and judged against the kernel's own
 * OOM counters (the security-probe witness, oom-witness.ts).
 *
 * Container status is the durable signal: kubelet SystemOOM events and
 * cadvisor's container_oom_events_total ride the kmsg oomparser (observed
 * broken on live nodes, and reading 0 on production through a real OOM
 * kill). lastState persists until the NEXT restart, so the 5-min reconciler
 * sees each kill; the dedupe key (uid × container × restartCount × finishedAt)
 * makes re-observations idempotent.
 *
 * What is recorded, and with which cause, is the witness's verdict:
 * kernel-confirmed OOMs always (even on a draining pod or one that also
 * failed a probe); a SIGKILL the kernel shows was NOT memory never; and an
 * unconfirmed exit 137 only when no other explanation exists (not a rollout,
 * node shutdown or probe restart). Pure — unit tested directly.
 */
export function collectOomKilledContainers(
  pods: ReadonlyArray<RawPod>,
  now: Date = new Date(),
  probeKills: ReadonlyMap<string, Date[]> = new Map(),
  witnesses: ReadonlyMap<string, OomWitness> = new Map(),
): NormalizedMemoryEvent[] {
  const cutoff = now.getTime() - RETENTION_MS;
  const out: NormalizedMemoryEvent[] = [];
  for (const pod of pods) {
    const uid = pod.metadata?.uid;
    const namespace = pod.metadata?.namespace ?? null;
    const podName = pod.metadata?.name ?? null;
    const nodeName = pod.spec?.nodeName ?? '';
    if (!uid || !nodeName) continue;
    const platformManaged = pod.metadata?.labels?.[PLATFORM_MANAGED_LABEL] === 'true';
    // A pod that is shutting down has its containers SIGKILLed on purpose once
    // the grace period expires, which is exit 137 — indistinguishable from a
    // cgroup OOM by exit code alone.
    //
    // Two ways that happens, and this used to test only the first:
    //   deletionTimestamp  — a rollout/scale-down/drain deletes the pod.
    //   status.reason      — a NODE SHUTDOWN never deletes the pod, it marks it
    //                        Failed in place, so deletionTimestamp is ABSENT.
    // Missing the second reported five reboot corpses as OOMs on production.
    // See isExpectedSigkill.
    const expectedKill = isExpectedSigkill({
      deletionTimestamp: pod.metadata?.deletionTimestamp,
      reason: pod.status?.reason,
    });
    // Every death in the pod is judged TOGETHER: the witness counts per pod,
    // and one kernel kill must never explain two deaths (judgeKills).
    interface Candidate {
      readonly key: string;
      readonly status: number;
      readonly oomKind: 'explicit' | 'inferred';
      readonly finished: Date;
      readonly containerName: string;
      readonly nameOrNull: string | null;
      readonly restartCount: number;
      readonly containerId?: string;
    }
    const candidates: Candidate[] = [];
    (pod.status?.containerStatuses ?? []).forEach((cs, status) => {
      const seen = new Set<string>();
      // A terminal pod (restartPolicy Never) carries the kill in
      // state.terminated; a restarting one in lastState.terminated. Both can
      // hold the same termination.
      for (const [slot, term] of [['state', cs.state?.terminated], ['last', cs.lastState?.terminated]] as const) {
        if (!term) continue;
        // The shared classifier: 'explicit' = the kubelet said OOMKilled,
        // 'inferred' = exit 137 only (a SIGKILL from any source).
        const oomKind = classifyOom(term);
        if (!oomKind) continue;
        const finished = term.finishedAt ? new Date(term.finishedAt) : null;
        if (!finished || Number.isNaN(finished.getTime()) || finished.getTime() < cutoff) continue;
        const containerId = bareContainerId(term.containerID);
        const signature = `${finished.getTime()}:${containerId ?? ''}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        candidates.push({
          key: `${status}:${slot}`, status, oomKind, finished, containerId,
          containerName: cs.name ?? '', nameOrNull: cs.name ?? null, restartCount: cs.restartCount ?? 0,
        });
      }
    });
    if (candidates.length === 0) continue;
    const causes = judgeKills(
      candidates.map((c) => ({ key: c.key, kubelet: c.oomKind, finishedAt: c.finished, containerId: c.containerId })),
      uid,
      witnesses.get(nodeName),
    );

    const recorded = new Set<number>();
    for (const c of candidates) {
      // One record per container status.
      if (recorded.has(c.status)) continue;
      const cause = causes.get(c.key) ?? (c.oomKind === 'explicit' ? 'oom' : 'unconfirmed');
      // The kernel showed this SIGKILL was not memory. Not a memory event.
      if (cause === 'not-oom') continue;
      const kernelConfirmed = cause === 'memory-limit' || cause === 'node-oom';
      if (c.oomKind === 'inferred' && !kernelConfirmed) {
        // Drop unconfirmed kills on a terminating pod: that is the rollout
        // SIGKILL, not an OOM. The modsec-crs `audit-redactor` sidecar paged
        // an admin as an OOM every time the WAF exclusion reconciler rolled
        // the deployment, while its cgroup reported `oom_kill 0`.
        if (expectedKill) continue;
        // Same rule, second source: if the kubelet said it killed this exact
        // container for a failed probe at about this time, that IS the cause.
        if (killedByProbe(probeKills, namespace, podName, c.containerName, c.finished)) continue;
      }
      recorded.add(c.status);
      out.push({
        dedupeKey: `oomk:${uid}:${c.containerName}:${c.restartCount}:${c.finished.getTime()}`,
        kind: 'container-oom',
        cause,
        nodeName,
        namespace,
        podName,
        containerName: c.nameOrNull,
        systemWorkload: isSystemNamespace(namespace) || platformManaged,
        platformManaged,
        podUid: uid,
        restartCount: c.restartCount,
        message: describeKill(cause, c.nameOrNull ?? '?', c.restartCount),
        occurredAt: c.finished,
      });
    }
  }
  return out;
}

/**
 * The persisted one-line message for a container kill. Says only what the
 * evidence supports: exit 137 is 128+SIGKILL from ANY source, and claiming
 * "OOM-killed at its memory limit" for all of them sent admins to raise a
 * limit on a container using 13% of it.
 */
export function describeKill(cause: ReportedKillCause, container: string, restartCount: number): string {
  const tail = `(restart #${restartCount})`;
  switch (cause) {
    case 'memory-limit':
      return `container ${container} OOM-killed at its memory limit (kernel-confirmed) ${tail}`;
    case 'node-oom':
      return `container ${container} killed by the node's out-of-memory killer - the node ran out of memory, not the container's own limit ${tail}`;
    case 'oom':
      return `container ${container} OOM-killed (reported by the kubelet; own limit vs node-wide OOM not determined) ${tail}`;
    case 'unconfirmed':
      return `container ${container} SIGKILLed (exit 137, cause unconfirmed — could be a cgroup OOM group-kill, a probe restart or a node drain; check the container's memory.peak against its limit before raising it) ${tail}`;
  }
}

/**
 * What a kubelet eviction was about, from the kubelet's own message
 * (pkg/kubelet/eviction/helpers.go). An eviction is not necessarily memory —
 * and not necessarily node pressure: a pod that outgrows its own
 * ephemeral-storage limit is evicted while the node is perfectly healthy.
 */
export function classifyEviction(message: string): NodeMemoryEventCause {
  if (/low on resource: memory/i.test(message) || /MemoryPressure/.test(message)) return 'node-memory-pressure';
  if (/low on resource: (?:ephemeral-storage|inodes)/i.test(message) || /DiskPressure/.test(message)) return 'node-disk-pressure';
  if (/low on resource: pids/i.test(message) || /PIDPressure/.test(message)) return 'node-pid-pressure';
  if (/ephemeral local storage usage exceeds|exceeded its local ephemeral storage limit|Usage of EmptyDir volume .* exceeds the limit/i.test(message)) {
    return 'pod-storage-limit';
  }
  return 'other';
}

function eventTimestamp(e: RawMemoryEvent): Date | null {
  const candidates = [e.eventTime, e.lastTimestamp, e.firstTimestamp, e.metadata?.creationTimestamp];
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Normalize the two raw event lists into persistable rows. Pure — unit
 * tested directly. Events with no uid or no resolvable node are dropped
 * (nothing actionable to show), as are events older than the retention
 * window (a fresh DB should not back-ingest ancient noise).
 */
export function normalizeMemoryEvents(
  evicted: ReadonlyArray<RawMemoryEvent>,
  systemOom: ReadonlyArray<RawMemoryEvent>,
  now: Date = new Date(),
): NormalizedMemoryEvent[] {
  const cutoff = now.getTime() - RETENTION_MS;
  const out: NormalizedMemoryEvent[] = [];

  for (const e of evicted) {
    if (e.reason !== 'Evicted' || e.involvedObject?.kind !== 'Pod') continue;
    const uid = e.metadata?.uid;
    const occurredAt = eventTimestamp(e);
    const nodeName = e.source?.host ?? e.reportingInstance ?? '';
    if (!uid || !occurredAt || occurredAt.getTime() < cutoff || !nodeName) continue;
    const namespace = e.involvedObject?.namespace ?? null;
    const message = (e.message ?? '').slice(0, 1000);
    out.push({
      dedupeKey: `${uid}:${e.count ?? 1}`,
      kind: 'pod-evicted',
      cause: classifyEviction(message),
      nodeName,
      namespace,
      podName: e.involvedObject?.name ?? null,
      containerName: null,
      systemWorkload: isSystemNamespace(namespace),
      message,
      occurredAt,
    });
  }

  for (const e of systemOom) {
    if (e.reason !== 'SystemOOM' || e.involvedObject?.kind !== 'Node') continue;
    const uid = e.metadata?.uid;
    const occurredAt = eventTimestamp(e);
    const nodeName = e.involvedObject?.name ?? e.source?.host ?? '';
    if (!uid || !occurredAt || occurredAt.getTime() < cutoff || !nodeName) continue;
    out.push({
      dedupeKey: `${uid}:${e.count ?? 1}`,
      kind: 'system-oom',
      cause: 'node-oom',
      nodeName,
      namespace: null,
      podName: null,
      containerName: null,
      // A kernel OOM kill is a node-level system incident by definition.
      systemWorkload: true,
      message: (e.message ?? '').slice(0, 1000),
      occurredAt,
    });
  }

  return out;
}

/** A tenant namespace's id + display name, for naming and deep-linking. */
export interface TenantRef {
  readonly id: string;
  readonly name: string;
}

/**
 * Map each affected TENANT namespace to its tenant. Only tenant-tier events
 * carry a resolvable namespace; a namespace with no tenant row (already
 * deleted) is simply absent and callers fall back to the namespace string.
 */
async function resolveTenants(
  db: Database,
  events: ReadonlyArray<NormalizedMemoryEvent>,
): Promise<Map<string, TenantRef>> {
  const namespaces = [...new Set(
    events.filter((e) => e.namespace && !isSystemNamespace(e.namespace)).map((e) => e.namespace as string),
  )];
  const out = new Map<string, TenantRef>();
  if (namespaces.length === 0) return out;
  try {
    const rows = await db
      .select({ id: tenants.id, ns: tenants.kubernetesNamespace, name: tenants.name })
      .from(tenants)
      .where(inArray(tenants.kubernetesNamespace, namespaces));
    for (const r of rows) if (r.ns) out.set(r.ns, { id: r.id, name: r.name });
  } catch {
    // Best-effort: a lookup failure just means the notification shows the
    // namespace instead of the display name — never block the notification.
  }
  return out;
}

export interface MemoryEventSources {
  readonly evicted: ReadonlyArray<RawMemoryEvent>;
  readonly systemOom: ReadonlyArray<RawMemoryEvent>;
  readonly pods?: ReadonlyArray<RawPod>;
  /** reason=Killing events — probe restarts, see indexProbeKills(). */
  readonly killing?: ReadonlyArray<RawMemoryEvent>;
  /** Per-node OOM witness, see oom-witness.ts. Empty = judge on the kubelet's word. */
  readonly witnesses?: ReadonlyMap<string, OomWitness>;
  readonly now?: Date;
  /**
   * Nodes whose notifications are held (join grace window, join-grace.ts).
   * Their events are still RECORDED — only the notification is skipped.
   */
  readonly isNotificationSuppressed?: (nodeName: string) => boolean;
}

/**
 * Persist + notify. Exactly-once across platform-api replicas: the UNIQUE
 * dedupe_key means only the replica that actually inserted a row counts
 * it as new, and only new rows drive notifications. Never throws — the
 * reconciler tick must survive a notification hiccup.
 */
export async function recordMemoryEvents(
  db: Database,
  sources: MemoryEventSources,
): Promise<{ readonly insertedCount: number }> {
  const now = sources.now ?? new Date();
  try {
    const probeKills = indexProbeKills(sources.killing ?? []);
    const normalized = [
      ...normalizeMemoryEvents(sources.evicted, sources.systemOom, now),
      ...collectOomKilledContainers(sources.pods ?? [], now, probeKills, sources.witnesses ?? new Map()),
    ];

    const inserted: NormalizedMemoryEvent[] = [];
    for (const e of normalized) {
      const rows = await db.insert(nodeMemoryEvents)
        .values({
          dedupeKey: e.dedupeKey,
          kind: e.kind,
          cause: e.cause,
          nodeName: e.nodeName,
          namespace: e.namespace,
          podName: e.podName,
          systemWorkload: e.systemWorkload,
          message: e.message,
          occurredAt: e.occurredAt,
        })
        .onConflictDoNothing({ target: nodeMemoryEvents.dedupeKey })
        .returning({ id: nodeMemoryEvents.id });
      if (rows.length > 0) inserted.push(e);
    }

    // 30-day retention, enforced opportunistically on every tick.
    await db.delete(nodeMemoryEvents)
      .where(lt(nodeMemoryEvents.occurredAt, new Date(now.getTime() - RETENTION_MS)));

    const tenantsByNs = await resolveTenants(db, inserted);
    await notifyMemoryEvents(db, inserted, {
      now,
      tenantFor: (ns) => tenantsByNs.get(ns),
      isNotificationSuppressed: sources.isNotificationSuppressed ?? (() => false),
    });

    return { insertedCount: inserted.length };
  } catch (err) {
    console.error('[node-health-monitor] memory-event recording failed:', (err as Error).message);
    return { insertedCount: 0 };
  }
}

/** Read-side for GET /admin/node-health/memory-events. */
export async function readMemoryEvents(db: Database, limit: number): Promise<NodeMemoryEvent[]> {
  const rows = await db.select().from(nodeMemoryEvents)
    .orderBy(sql`${nodeMemoryEvents.occurredAt} DESC`)
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as NodeMemoryEvent['kind'],
    nodeName: r.nodeName,
    namespace: r.namespace,
    podName: r.podName,
    systemWorkload: r.systemWorkload,
    cause: (r.cause ?? null) as NodeMemoryEvent['cause'],
    message: r.message,
    occurredAt: r.occurredAt.toISOString(),
  }));
}
