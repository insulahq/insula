/**
 * Node memory events — SystemOOM + pod evictions (operator decision
 * 2026-07-25: both must be UI-visible and reach admins as notifications).
 *
 * Fed by the node-health reconciler's 5-min tick with the raw k8s Event
 * lists (reason=Evicted for Pods, reason=SystemOOM for Nodes). Each
 * distinct occurrence (k8s event uid × aggregation count) is persisted
 * once to `node_memory_events` for the admin UI, and NEW rows dispatch a
 * categorized admin notification:
 *
 *   critical — SystemOOM, or an eviction touching a SYSTEM namespace.
 *              The eviction design (platform-critical PriorityClass +
 *              eviction-hard=memory.available<256Mi) makes system
 *              casualties abnormal by construction, so seeing one is a
 *              red flag.
 *   warning  — tenant-only evictions: the DESIGNED backpressure. Worth
 *              knowing (node oversubscribed / tenant undersized), not an
 *              incident per se.
 *
 * Dedupe layers: the UNIQUE dedupe_key column makes ingestion exactly-once
 * across replicas and restarts; the dispatcher dedupeKey is hour-scoped
 * per (node × class) so a sustained incident notifies at most hourly; the
 * category rate limits back-stop bursts.
 */

import { inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { nodeMemoryEvents, tenants } from '../../db/schema.js';
import { notifyAdminNodeMemoryEvents } from '../notifications/events.js';
import type { NodeMemoryEvent } from '@insula/api-contracts';
import { classifyOom } from '../../lib/container-termination.js';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // UI window: 30 days

/**
 * Namespaces whose pods count as SYSTEM workloads. Everything else
 * (client-* tenant namespaces and anything unknown) is tenant-tier.
 */
const SYSTEM_NAMESPACES = new Set([
  'platform',
  'platform-system',
  'platform-tenant-ops',
  'mail',
  'kube-system',
  'flux-system',
  'longhorn-system',
  'cert-manager',
  'cnpg-system',
]);

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

export interface NormalizedMemoryEvent {
  readonly dedupeKey: string;
  readonly kind: 'system-oom' | 'pod-evicted' | 'container-oom';
  readonly nodeName: string;
  readonly namespace: string | null;
  readonly podName: string | null;
  /** OOM-killed container name (container-oom only); null for pod/node events. */
  readonly containerName: string | null;
  readonly systemWorkload: boolean;
  readonly message: string;
  readonly occurredAt: Date;
}

/** Pod fields the container-OOM collector reads. */
export interface RawPod {
  readonly metadata?: { readonly uid?: string; readonly name?: string; readonly namespace?: string };
  readonly spec?: { readonly nodeName?: string };
  readonly status?: {
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
}

/**
 * Containers OOM-killed at their own cgroup limit, read from container
 * STATUS (containerd-sourced) rather than events or metrics. Both of
 * those ride cadvisor's kmsg oomparser — observed permanently broken on
 * a live node (2026-07-25) — and the per-container metric series is torn
 * down before the 60s scrape can capture a short-lived kill. lastState
 * persists until the NEXT restart, so the 5-min reconciler reliably sees
 * each kill; the dedupe key (uid × container × restartCount × finishedAt)
 * makes re-observations idempotent. Exit 137 with reason "Error" is
 * included: cgroup-v2 group kills are reported that way by some
 * containerd versions (observed on DEV) — the message marks the
 * inference. Pure — unit tested directly.
 */
export function collectOomKilledContainers(
  pods: ReadonlyArray<RawPod>,
  now: Date = new Date(),
): NormalizedMemoryEvent[] {
  const cutoff = now.getTime() - RETENTION_MS;
  const out: NormalizedMemoryEvent[] = [];
  for (const pod of pods) {
    const uid = pod.metadata?.uid;
    const namespace = pod.metadata?.namespace ?? null;
    const podName = pod.metadata?.name ?? null;
    const nodeName = pod.spec?.nodeName ?? '';
    if (!uid || !nodeName) continue;
    for (const cs of pod.status?.containerStatuses ?? []) {
      // A terminal pod (restartPolicy Never) carries the kill in
      // state.terminated; a restarting one in lastState.terminated.
      for (const term of [cs.state?.terminated, cs.lastState?.terminated]) {
        if (!term) continue;
        // This module got it right before the others did; it now shares the
        // classifier so the whole platform agrees on what an OOM is. Note the
        // inferred arm no longer requires reason==='Error' — a SIGKILL with no
        // reason set at all is still exit 137.
        const oomKind = classifyOom(term);
        if (!oomKind) continue;
        const oomExplicit = oomKind === 'explicit';
        const finished = term.finishedAt ? new Date(term.finishedAt) : null;
        if (!finished || Number.isNaN(finished.getTime()) || finished.getTime() < cutoff) continue;
        out.push({
          dedupeKey: `oomk:${uid}:${cs.name ?? ''}:${cs.restartCount ?? 0}:${finished.getTime()}`,
          kind: 'container-oom',
          nodeName,
          namespace,
          podName,
          containerName: cs.name ?? null,
          systemWorkload: namespace !== null && SYSTEM_NAMESPACES.has(namespace),
          message: oomExplicit
            ? `container ${cs.name ?? '?'} OOM-killed at its memory limit (restart #${cs.restartCount ?? 0})`
            : `container ${cs.name ?? '?'} SIGKILLed exit 137 — cgroup OOM group-kill reports as "Error" on some containerd versions (restart #${cs.restartCount ?? 0})`,
          occurredAt: finished,
        });
        break; // one record per container status — state+lastState can hold the same termination
      }
    }
  }
  return out;
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
    out.push({
      dedupeKey: `${uid}:${e.count ?? 1}`,
      kind: 'pod-evicted',
      nodeName,
      namespace,
      podName: e.involvedObject?.name ?? null,
      containerName: null,
      systemWorkload: namespace !== null && SYSTEM_NAMESPACES.has(namespace),
      message: (e.message ?? '').slice(0, 1000),
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

/**
 * Group NEW events into per-(node × class) notification payloads. Pure —
 * unit tested directly.
 */
export function summarizeForNotification(
  inserted: ReadonlyArray<NormalizedMemoryEvent>,
  labelForNamespace: (ns: string) => string | undefined = () => undefined,
): Array<{ nodeName: string; severity: 'critical' | 'warning'; summary: string }> {
  interface Group {
    nodeName: string;
    severity: 'critical' | 'warning';
    oom: number;
    sysEvict: NormalizedMemoryEvent[];
    tenantEvict: NormalizedMemoryEvent[];
    sysOomk: NormalizedMemoryEvent[];
    tenantOomk: NormalizedMemoryEvent[];
  }
  const groups = new Map<string, Group>();
  for (const e of inserted) {
    const severity: 'critical' | 'warning' = e.systemWorkload ? 'critical' : 'warning';
    const key = `${e.nodeName} ${severity}`;
    const g = groups.get(key) ?? { nodeName: e.nodeName, severity, oom: 0, sysEvict: [], tenantEvict: [], sysOomk: [], tenantOomk: [] };
    if (e.kind === 'system-oom') g.oom += 1;
    else if (e.kind === 'container-oom') (e.systemWorkload ? g.sysOomk : g.tenantOomk).push(e);
    else (e.systemWorkload ? g.sysEvict : g.tenantEvict).push(e);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const parts: string[] = [];
    if (g.oom > 0) parts.push(`kernel SystemOOM (${g.oom} event${g.oom === 1 ? '' : 's'})`);
    const named = (label: string, evs: NormalizedMemoryEvent[]): void => {
      if (evs.length === 0) return;
      parts.push(`${evs.length} ${label}: ${joinNamed(evs.map((e) => describeEvent(e, labelForNamespace)))}`);
    };
    named('SYSTEM pod(s) evicted', g.sysEvict);
    named('SYSTEM container(s) OOM-killed at their memory limit', g.sysOomk);
    named('tenant pod(s) evicted', g.tenantEvict);
    named('tenant container(s) OOM-killed at their memory limit', g.tenantOomk);
    const advice = g.severity === 'warning'
      ? "Raise the tenant's plan/memory limit if this recurs. Details: Monitoring -> Node health -> Memory events."
      : 'A SYSTEM workload was hit - investigate now. Details: Monitoring -> Node health -> Memory events.';
    return { nodeName: g.nodeName, severity: g.severity, summary: `${parts.join('; ')}. ${advice}` };
  });
}

/** How many affected objects to name individually before switching to "+N more". */
const MAX_NAMED = 3;

/**
 * Human identity of one memory event: the tenant NAME (or namespace for SYSTEM
 * workloads) plus pod + container when known. This is what the notification was
 * missing - it named a count and a node and nothing you could act on.
 */
function describeEvent(
  e: NormalizedMemoryEvent,
  labelForNamespace: (ns: string) => string | undefined,
): string {
  const who = e.systemWorkload
    ? (e.namespace ?? 'node')
    : (e.namespace ? (labelForNamespace(e.namespace) ?? e.namespace) : 'unknown tenant');
  const prefix = e.systemWorkload ? who : `tenant "${who}"`;
  const bits: string[] = [];
  if (e.containerName) bits.push(`container ${e.containerName}`);
  if (e.podName) bits.push(`pod ${e.podName}`);
  return bits.length > 0 ? `${prefix} (${bits.join(', ')})` : prefix;
}

/** Join named descriptions with a "+N more" tail when the list is long. */
function joinNamed(descriptions: string[]): string {
  if (descriptions.length <= MAX_NAMED) return descriptions.join('; ');
  return `${descriptions.slice(0, MAX_NAMED).join('; ')}; +${descriptions.length - MAX_NAMED} more`;
}

/**
 * Map each affected TENANT namespace to its display name for the notification.
 * Only tenant-tier events carry a resolvable namespace; SYSTEM ones use the raw
 * namespace. A namespace with no tenant row (already deleted) is simply absent
 * from the map and the summary falls back to the namespace string.
 */
async function resolveTenantLabels(
  db: Database,
  events: ReadonlyArray<NormalizedMemoryEvent>,
): Promise<Map<string, string>> {
  const namespaces = [...new Set(
    events.filter((e) => !e.systemWorkload && e.namespace).map((e) => e.namespace as string),
  )];
  const out = new Map<string, string>();
  if (namespaces.length === 0) return out;
  try {
    const rows = await db
      .select({ ns: tenants.kubernetesNamespace, name: tenants.name })
      .from(tenants)
      .where(inArray(tenants.kubernetesNamespace, namespaces));
    for (const r of rows) if (r.ns) out.set(r.ns, r.name);
  } catch {
    // Best-effort: a lookup failure just means the summary shows the namespace
    // instead of the display name — never block the notification.
  }
  return out;
}

/**
 * Persist + notify. Exactly-once across platform-api replicas: the UNIQUE
 * dedupe_key means only the replica that actually inserted a row counts
 * it as new, and only new rows drive notifications. Never throws — the
 * reconciler tick must survive a notification hiccup.
 */
export async function recordMemoryEvents(
  db: Database,
  evicted: ReadonlyArray<RawMemoryEvent>,
  systemOom: ReadonlyArray<RawMemoryEvent>,
  pods: ReadonlyArray<RawPod> = [],
  now: Date = new Date(),
): Promise<{ readonly insertedCount: number }> {
  try {
    const normalized = [
      ...normalizeMemoryEvents(evicted, systemOom, now),
      ...collectOomKilledContainers(pods, now),
    ];

    const inserted: NormalizedMemoryEvent[] = [];
    for (const e of normalized) {
      const rows = await db.insert(nodeMemoryEvents)
        .values({
          dedupeKey: e.dedupeKey,
          kind: e.kind,
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

    // Resolve the affected tenant namespaces to their display names so the
    // notification can say WHO was hit, not just "1 tenant container(s)".
    const nsToLabel = await resolveTenantLabels(db, inserted);
    for (const n of summarizeForNotification(inserted, (ns) => nsToLabel.get(ns))) {
      const hour = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
      await notifyAdminNodeMemoryEvents(db, n.severity, { nodeName: n.nodeName, summary: n.summary },
        `node-memory:${n.severity}:${n.nodeName}:${hour}`);
    }

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
    message: r.message,
    occurredAt: r.occurredAt.toISOString(),
  }));
}
