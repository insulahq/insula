/**
 * Node-health reconciler — 5-min tick.
 *
 * Closes the three monitoring gaps surfaced by the worker
 * incident (Calico Felix crash-looped, evicted Longhorn pods, worker
 * silently lost driver.longhorn.io for 10 days):
 *
 *   1. Host disk pressure visibility (kubelet's DiskPressure
 *      condition is only seen via `kubectl describe node`).
 *   2. CSINode driver count drop (cluster-health module surfaces
 *      it in API but never alerts).
 *   3. Pod-eviction loops (nothing watches Pod/Node events).
 *
 * Same scheduler shape as capacity-reconciler (the Longhorn-capacity
 * cousin): 90s INITIAL_DELAY past startup migrations, 5min cadence,
 * single in-process timer, stop() on app close. Notifications fan
 * out to admin/super_admin role on severity transitions, with 24h
 * re-fire for sustained warning/critical to prevent alert fatigue.
 */

import crypto from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { runExclusive } from '../../shared/exclusive-run.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { nodeHealthState, notifications, users } from '../../db/schema.js';
import {
  notifyAdminNodeDown,
  notifyAdminNodeShuttingDown,
  notifyAdminNodeBackOnline,
  notifyAdminNodeStartupComplete,
} from '../notifications/events.js';
import {
  detectBootTransitions,
  formatDowntime,
  kubeletReportsShutdown,
  wentDownAt,
  type BootFacts,
  type PrevBootState,
} from './boot-events.js';
import { nodeDownDedupeKey } from './fast-down-watch.js';
import { backOnlinePayload, claimOutageEnd, endedOnSameBoot, nodeBackDedupeKey, type SameBootReturn } from './back-online.js';
import { recordMemoryEvents } from './memory-events.js';
import { readOomWitnesses } from './oom-witness.js';
import { readNodeDiskStats } from './kubelet-disk.js';
import { describeSuppression, loadJoinGrace } from './join-grace.js';
import { outageHoldIndex } from './outage-hold.js';
import { reapShutdownDebris } from './shutdown-debris.js';
import {
  buildEntry,
  computeClusterBaseline,
  decideHealthNotification,
  overallSeverity,
  type NodeFacts,
} from './service.js';
import type {
  NodeHealthEntry,
  NodeHealthSeverity,
} from '@insula/api-contracts';

const TICK_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 90_000;
const EVICTION_WINDOW_MS = 60 * 60 * 1000; // 1h

interface RawNode {
  /** creationTimestamp + addresses feed the join grace window (join-grace.ts). */
  readonly metadata?: { readonly name?: string; readonly creationTimestamp?: Date | string };
  readonly status?: {
    readonly addresses?: ReadonlyArray<{ readonly type?: string; readonly address?: string }>;
    readonly conditions?: ReadonlyArray<{
      readonly type?: string;
      readonly status?: string;
      /** Ready's transition time is, in practice, the moment the node booted. */
      readonly lastTransitionTime?: string;
      /** Ready's message carries the kubelet's graceful-shutdown report. */
      readonly message?: string;
    }>;
    /** Kernel bootID — changes on every boot. See boot-events.ts. */
    readonly nodeInfo?: { readonly bootID?: string };
  };
}

interface RawCSINode {
  readonly metadata?: { readonly name?: string };
  readonly spec?: {
    readonly drivers?: ReadonlyArray<{ readonly name?: string }>;
  };
}

interface RawEvent {
  readonly reason?: string;
  readonly type?: string;
  readonly message?: string;
  readonly count?: number;
  readonly involvedObject?: { readonly kind?: string; readonly name?: string; readonly namespace?: string };
  readonly source?: { readonly host?: string };
  readonly reportingInstance?: string;
  readonly metadata?: { readonly uid?: string; readonly creationTimestamp?: string };
  readonly eventTime?: string;
  readonly lastTimestamp?: string;
  readonly firstTimestamp?: string;
}

/**
 * One reconcile pass. Exported for unit tests; the public entrypoint
 * is `startNodeHealthScheduler` below which wraps it in a setTimeout
 * loop.
 */
export async function reconcileNodeHealth(
  db: Database,
  k8s: K8sClients,
  now: Date = new Date(),
): Promise<{
  readonly entries: ReadonlyArray<NodeHealthEntry>;
  readonly notified: ReadonlyArray<string>;
}> {
  // ── 1. Pull all data sources in parallel ────────────────────────
  const [nodeList, csiNodeList, eventList, oomEventList, killingEventList] = await Promise.all([
    k8s.core.listNode({}) as Promise<{ items?: ReadonlyArray<RawNode> }>,
    k8s.storage.listCSINode({}) as Promise<{ items?: ReadonlyArray<RawCSINode> }>,
    k8s.core.listEventForAllNamespaces({
      fieldSelector: 'reason=Evicted',
    } as Parameters<typeof k8s.core.listEventForAllNamespaces>[0])
      .catch(() => ({ items: [] as RawEvent[] })) as Promise<{ items?: ReadonlyArray<RawEvent> }>,
    // Kernel OOM kills surface as kubelet-posted SystemOOM events on the
    // NODE object(operator decision: must be visible + alerted).
    k8s.core.listEventForAllNamespaces({
      fieldSelector: 'reason=SystemOOM',
    } as Parameters<typeof k8s.core.listEventForAllNamespaces>[0])
      .catch(() => ({ items: [] as RawEvent[] })) as Promise<{ items?: ReadonlyArray<RawEvent> }>,
    // Probe restarts SIGKILL the container (exit 137) exactly like a cgroup
    // OOM. The kubelet posts a Killing event naming the probe as the cause —
    // believe it, rather than inferring memory. See indexProbeKills().
    k8s.core.listEventForAllNamespaces({
      fieldSelector: 'reason=Killing',
    } as Parameters<typeof k8s.core.listEventForAllNamespaces>[0])
      .catch(() => ({ items: [] as RawEvent[] })) as Promise<{ items?: ReadonlyArray<RawEvent> }>,
  ]);

  // ── 2. Index lookup tables ──────────────────────────────────────
  const csiByNode = new Map<string, string[]>();
  for (const c of csiNodeList.items ?? []) {
    const name = c.metadata?.name;
    if (!name) continue;
    csiByNode.set(name, (c.spec?.drivers ?? []).map((d) => d.name ?? '').filter((n) => n.length > 0));
  }

  const evictionsByNode = new Map<string, number>();
  const cutoff = now.getTime() - EVICTION_WINDOW_MS;
  for (const e of eventList.items ?? []) {
    if (e.reason !== 'Evicted') continue;
    if (e.involvedObject?.kind !== 'Pod') continue;
    const ts = pickEventTimestamp(e);
    if (!ts || ts.getTime() < cutoff) continue;
    const host = e.source?.host ?? e.reportingInstance ?? '';
    if (!host) continue;
    evictionsByNode.set(host, (evictionsByNode.get(host) ?? 0) + 1);
  }

  // ── 3. Build NodeFacts for each node ────────────────────────────
  // Phase 1b: read root-fs fill % per node from kubelet /stats/summary so the
  // 75/90 % thresholds (service.ts) fire BEFORE the kernel raises DiskPressure
  // (~88% in the incident). Best-effort: a node absent from the map
  // stays diskUsedPct:null ("unknown"), never a false alert. ~250 ms/node over a
  // 5-min tick, so the roundtrip cost is immaterial.
  const nodeNames = (nodeList.items ?? [])
    .map((n) => n.metadata?.name)
    .filter((name): name is string => Boolean(name));
  const diskPctByNode = await readNodeDiskStats(nodeNames);

  const facts: NodeFacts[] = [];
  const bootFacts: BootFacts[] = [];
  // When each node that is not Ready left Ready (wentDownAt).
  const downAtByNode = new Map<string, Date>();
  for (const n of nodeList.items ?? []) {
    const name = n.metadata?.name;
    if (!name) continue;
    const conditions = n.status?.conditions ?? [];
    const cond = (type: string) =>
      conditions.find((c) => c.type === type)?.status === 'True';
    const readyCond = conditions.find((c) => c.type === 'Ready');
    const ready = readyCond?.status === 'True';
    const readyAt = readyCond?.lastTransitionTime
      ? new Date(readyCond.lastTransitionTime)
      : null;
    bootFacts.push({
      nodeName: name,
      bootId: n.status?.nodeInfo?.bootID ?? null,
      ready,
      readySince: readyAt && !Number.isNaN(readyAt.getTime()) ? readyAt : null,
      shuttingDown: kubeletReportsShutdown(readyCond),
    });
    if (!ready) downAtByNode.set(name, wentDownAt(readyCond, now));
    facts.push({
      name,
      ready,
      diskPressure: cond('DiskPressure'),
      memoryPressure: cond('MemoryPressure'),
      pidPressure: cond('PIDPressure'),
      csiDrivers: csiByNode.get(name) ?? [],
      evictionsLastHour: evictionsByNode.get(name) ?? 0,
      diskUsedPct: diskPctByNode.get(name) ?? null,
    });
  }

  // ── 4. Compute baseline + per-node entry ────────────────────────
  const baseline = computeClusterBaseline(facts);
  const entries = facts.map((f) => buildEntry(f, baseline, now));

  // Nodes still inside their join grace window: their state is persisted and
  // shown as usual, but nothing about them is NOTIFIED (join-grace.ts).
  const grace = await loadJoinGrace(k8s, nodeList.items ?? [], now);
  // Nodes back from an outage and still settling (outage-hold.ts) hold their
  // WARNING transitions only — see decideHealthNotification. Not the down,
  // shutting-down or startup notices: those are the outage's own story.
  const outage = outageHoldIndex(nodeList.items ?? [], now);

  // ── 5. Diff against persisted state, persist + notify ──────────
  const prevRows = await db.select().from(nodeHealthState);
  const prevByName = new Map(prevRows.map((r) => [r.nodeName, r]));

  // ── 5a. Node reboot lifecycle ────
  // Computed from prevRows BEFORE the upsert loop overwrites them, and applied
  // into that same upsert so bootId/rebootAnnounced advance atomically with the
  // rest of the row. Notifications are dispatched after the writes so a
  // notification failure cannot replay the transition on the next tick.
  const prevBoot = new Map<string, PrevBootState>(
    prevRows.map((r) => [r.nodeName, {
      bootId: r.bootId ?? null,
      ready: r.ready,
      observedAt: r.observedAt ?? null,
      rebootAnnounced: r.rebootAnnounced,
      downSince: r.downSince ?? null,
    }]),
  );
  const bootTransitions = detectBootTransitions(bootFacts, prevBoot, now);
  const transitionByNode = new Map(bootTransitions.map((t) => [t.nodeName, t]));
  const bootFactByNode = new Map(bootFacts.map((b) => [b.nodeName, b]));

  const adminUserIds = await getAdminUserIds(db);
  const notified: string[] = [];
  // Same-boot returns this tick claimed (back-online.ts), announced after the writes.
  const backOnline: SameBootReturn[] = [];

  for (const entry of entries) {
    const prev = prevByName.get(entry.name);
    const joining = grace.get(entry.name);
    const settle = outage.get(entry.name);
    const decision = decideHealthNotification({
      newSeverity: entry.severity,
      prev: prev
        ? { severity: prev.severity as NodeHealthSeverity, lastNotifiedAt: prev.lastNotifiedAt ?? null }
        : undefined,
      suppressed: joining !== undefined,
      // Back from a reboot: the startup notice below is its recovery
      // announcement, and while it settles its pods' start-up is not news.
      settling: settle?.reason === 'back-recently',
      startupNoticeNow: transitionByNode.get(entry.name)?.kind === 'startup-complete' && !joining,
      now,
    });
    const willNotify = decision.notify;
    const notifiedAt = decision.lastNotifiedAt;
    if (settle?.reason === 'back-recently' && !joining && entry.severity !== 'normal' && !willNotify && notifiedAt === null) {
      console.log(`[node-health-monitor] ${describeSuppression(entry.name, settle, `${entry.severity} health alert`)}`);
    }

    // A new boot resets the "already announced" flag; announcing a shutdown
    // sets it. Anything else carries the previous value forward. A shutdown
    // held back by the join grace window was NOT announced, so it must not be
    // recorded as if it had been — startup-complete would then claim it was.
    const bootFact = bootFactByNode.get(entry.name);
    const transition = transitionByNode.get(entry.name);
    // A node back on a new boot reports its bootID before it is Ready (a k3s
    // node waits for its network). Adopting the new one then left the next
    // tick no reboot to see, and the startup notice never went out. It is
    // adopted once the node is Ready — the tick startup-complete fires on.
    const liveBootId = bootFact?.bootId ?? null;
    const nextBootId = liveBootId && (entry.ready || !prev?.bootId)
      ? liveBootId
      : (prev?.bootId ?? liveBootId);
    const bootRolled = Boolean(prev?.bootId && nextBootId !== prev.bootId);
    // The outage's start, for the startup notice's downtime: kept from
    // whichever detector saw it first, cleared once the node is Ready again.
    const downAt = downAtByNode.get(entry.name) ?? now;
    const shutdownNoticeNow = transition?.kind === 'shutting-down' && !joining;
    const nextRebootAnnounced = bootRolled
      ? false
      : shutdownNoticeNow ? true : (prev?.rebootAnnounced ?? false);

    // Back on the same boot: claim the outage on record before the upsert below
    // clears it, so this tick or the fast down-watch — never both — sends the
    // all-clear. Claimed before, not after, the write: the claim IS the clear.
    const sameBootReturn = prev?.downSince && !joining
      ? endedOnSameBoot(
        { nodeName: entry.name, downSince: prev.downSince, bootId: prev.bootId ?? null },
        { ready: entry.ready, readySince: bootFact?.readySince ?? null, bootId: liveBootId },
      )
      : null;
    if (sameBootReturn && await claimOutageEnd(db, entry.name, sameBootReturn.downSince)) {
      backOnline.push(sameBootReturn);
    }
    // That notice is the outage's all-clear. "Recovered to normal" for the same
    // return — the reconciler's own, when it had seen the node NotReady — would
    // be a second one. It stays for a node that comes back with something else
    // still wrong: that is news the all-clear does not carry.
    const allClearCovers = prev?.ready === false && entry.ready && !bootRolled && !joining
      && entry.severity === 'normal';

    if (joining && (entry.severity !== 'normal' || transition)) {
      console.log(`[node-health-monitor] ${describeSuppression(
        entry.name, joining, `${entry.severity} health alert${transition ? ` and ${transition.kind} notice` : ''}`,
      )}`);
    }

    await db.insert(nodeHealthState)
      .values({
        nodeName: entry.name,
        ready: entry.ready,
        bootId: nextBootId,
        rebootAnnounced: nextRebootAnnounced,
        pressures: [...entry.pressures],
        csiDriversPresent: entry.csiDriversPresent,
        csiDriversExpected: entry.csiDriversExpected,
        csiDriversMissing: [...entry.csiDriversMissing],
        evictionsLastHour: entry.evictionsLastHour,
        diskUsedPct: entry.diskUsedPct === null ? null : entry.diskUsedPct.toString(),
        severity: entry.severity,
        lastNotifiedAt: notifiedAt,
        observedAt: now,
        // Not for a node inside its join window: it is NotReady by definition and
        // was never announced, so there is no outage to close (back-online.ts).
        downSince: entry.ready || joining ? null : (prev?.downSince ?? downAt),
      })
      .onConflictDoUpdate({
        target: nodeHealthState.nodeName,
        set: {
          ready: entry.ready,
          bootId: nextBootId,
          // The fast down-watch sets reboot_announced when IT announces a
          // shutdown (fast-down-watch.ts markShutdownAnnounced), possibly after
          // this tick read the row. Keep a true it wrote for this same boot.
          rebootAnnounced: bootRolled
            ? false
            : sql`${nodeHealthState.rebootAnnounced} OR ${nextRebootAnnounced}`,
          pressures: [...entry.pressures],
          csiDriversPresent: entry.csiDriversPresent,
          csiDriversExpected: entry.csiDriversExpected,
          csiDriversMissing: [...entry.csiDriversMissing],
          evictionsLastHour: entry.evictionsLastHour,
          diskUsedPct: entry.diskUsedPct === null ? null : entry.diskUsedPct.toString(),
          severity: entry.severity,
          lastNotifiedAt: notifiedAt,
          observedAt: now,
          // The fast down-watch records the moment too (fast-down-watch.ts
          // recordWentDown), and one already recorded is kept. A node that
          // went down after this tick listed it reads Ready here: its moment
          // is later than the tick, and is not this tick's to clear. Nor is
          // one written after this tick READ the row: the fast watch can
          // announce an outage that began before the tick, between the read
          // and this write, and nulling it then lost that outage's all-clear
          // (back-online.ts) — the watch closes it on its next pass instead.
          downSince: entry.ready
            ? sql`CASE WHEN ${nodeHealthState.downSince} > ${now.toISOString()}::timestamptz
                OR ${nodeHealthState.downSince} IS DISTINCT FROM ${prev?.downSince ? prev.downSince.toISOString() : null}::timestamptz
              THEN ${nodeHealthState.downSince} END`
            : joining
              ? sql`${nodeHealthState.downSince}`
              : sql`COALESCE(${nodeHealthState.downSince}, ${downAt.toISOString()}::timestamptz)`,
        },
      });

    if (willNotify && !allClearCovers) {
      await fanoutNotification(db, adminUserIds, entry, decision.prevSeverityForCopy, {
        // Exactly what the fast down-watch reads (the Node's own bootID, no
        // fallback), or the two would announce one outage twice.
        goingDownKey: nodeDownDedupeKey(entry.name, bootFact?.bootId ?? null, now),
        shutdownNoticeNow,
      });
      notified.push(entry.name);
    }
  }

  // ── 5a'. All-clear for same-boot returns this tick claimed ──
  for (const r of backOnline) {
    await notifyAdminNodeBackOnline(db, backOnlinePayload(r), nodeBackDedupeKey(r.nodeName, r.bootId, r.downSince));
  }

  // ── 5b. Dispatch the shutdown / startup lifecycle notifications ──
  // After persistence: a dispatch failure must not cause the transition to be
  // re-detected (and re-sent) on the next tick. dispatchSafe never throws, but
  // the ordering is the guarantee, not its implementation.
  for (const t of bootTransitions) {
    // A joining node restarts k3s and sometimes the whole host while it
    // bootstraps; neither is a reboot anyone needs telling about.
    if (grace.has(t.nodeName)) continue;
    if (t.kind === 'shutting-down') {
      // The going-down key: the fast down-watch usually announced this
      // shutdown already, and then this send is a no-op.
      const boot = bootFactByNode.get(t.nodeName)?.bootId ?? null;
      await notifyAdminNodeShuttingDown(db, { nodeName: t.nodeName }, nodeDownDedupeKey(t.nodeName, boot, now));
    } else {
      await notifyAdminNodeStartupComplete(db, {
        nodeName: t.nodeName,
        downtimeText: t.downtimeMs === null ? 'unknown' : `~${formatDowntime(t.downtimeMs)}`,
        bootedAtText: t.bootedAt ? ` at ${t.bootedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC` : '',
        announcementNote: startupAnnouncementNote(t.rebootWasAnnounced, entries.length),
      }, `node-startup:${t.nodeName}:${t.bootId}`);
    }
  }

  // Drop rows for nodes that no longer exist (operator deleted a node).
  const liveNames = new Set(entries.map((e) => e.name));
  const stale = prevRows.filter((r) => !liveNames.has(r.nodeName));
  if (stale.length > 0) {
    await db.delete(nodeHealthState).where(inArray(nodeHealthState.nodeName, stale.map((s) => s.nodeName)));
  }

  // ── 6. Record distinct memory events + notify admins ───────────
  // (never throws — a notification hiccup must not fail the tick)
  // Container kills come from pod STATUS (containerd-sourced) — the only
  // durable record that one happened: kubelet SystemOOM events and cadvisor's
  // container_oom_events_total both ride the kmsg oomparser (observed broken
  // on live nodes). WHETHER each was an OOM comes from the kernel's own
  // counters, via the security-probe witness (oom-witness.ts).
  const [podList, witnesses] = await Promise.all([
    (k8s.core.listPodForAllNamespaces({}) as Promise<{ items?: ReadonlyArray<unknown> }>)
      .catch(() => ({ items: [] as unknown[] })),
    readOomWitnesses(k8s, (message) =>
      console.warn(`[node-health-monitor] OOM witness unreadable — kills judged on the kubelet's word: ${message}`)),
  ]);
  type MemoryEventPods = NonNullable<Parameters<typeof recordMemoryEvents>[1]['pods']>;
  await recordMemoryEvents(db, {
    evicted: eventList.items ?? [],
    systemOom: oomEventList.items ?? [],
    pods: (podList.items ?? []) as MemoryEventPods,
    killing: killingEventList.items ?? [],
    witnesses,
    now,
    // Recorded for the panel either way; only the notification waits out the
    // join grace window.
    isNotificationSuppressed: (nodeName) => grace.has(nodeName),
  });

  // ── 7. Reap node-reboot debris ─────────────────────────────────
  // Nothing in Kubernetes removes these (terminated-pod-gc-threshold defaults
  // to 12500), so they pile up across reboots — 822 from one reboot in
  // tigera-operator, still 20 per reboot after the priority-class
  // fix. They are also pod objects carrying exit-137 container statuses, which
  // is what made the OOM detectors report reboot corpses as tenant OOM kills.
  // Runs AFTER recordMemoryEvents so a kill is recorded before its record goes.
  await reapShutdownDebris(
    k8s,
    (podList.items ?? []) as Parameters<typeof reapShutdownDebris>[1],
    now.getTime(),
  ).catch(() => 0);

  return { entries, notified };
}

async function getAdminUserIds(db: Database): Promise<string[]> {
  const rows = await db.select({ id: users.id })
    .from(users)
    .where(inArray(users.roleName, ['super_admin', 'admin']));
  return rows.map((r) => r.id);
}

/**
 * The startup notice's closing sentence. The single-node explanation only
 * where it is true: on a multi-node cluster an unannounced shutdown means the
 * kubelet never reported one (a crash, a power cut) — that node was announced
 * as down instead.
 */
export function startupAnnouncementNote(shutdownWasAnnounced: boolean, nodeCount: number): string {
  if (shutdownWasAnnounced) return 'The shutdown was announced beforehand.';
  return nodeCount <= 1
    ? 'No shutdown notice was sent — on a single-node cluster the control plane goes down with the node, so the restart can only be reported once it is back.'
    : 'No shutdown notice was sent — the node did not report a graceful shutdown before it went down.';
}

async function fanoutNotification(
  db: Database,
  adminUserIds: ReadonlyArray<string>,
  entry: NodeHealthEntry,
  prevSeverity: NodeHealthSeverity,
  goingDown: {
    /** nodeDownDedupeKey — shared with the fast down-watch and the shutdown notice. */
    readonly goingDownKey: string;
    /** This tick announces a graceful shutdown instead; "down" would repeat it. */
    readonly shutdownNoticeNow: boolean;
  },
): Promise<void> {
  const title = titleFor(entry, prevSeverity);
  const conditions = conditionsFor(entry);
  const type = entry.severity === 'critical' ? 'error'
    : entry.severity === 'warning' ? 'warning'
    : 'info';

  // A NotReady node is already reported by the categorised `admin.node_down`
  // dispatch below, which carries a better title and an action path. Emitting
  // the raw row as well produced TWO notifications for one event during the
  // drill — "Node down" (critical) and "Node X flagged CRITICAL"
  // (info) — landing seconds apart in an inbox with 880 unread items.
  const coveredByNodeDown = !entry.ready && entry.severity === 'critical';

  if (!coveredByNodeDown) {
    // Dispatched, not inserted.
    //
    // The raw insert this replaces had to set `severity` by hand because
    // nothing else would — it had defaulted to `info`, so a CRITICAL node
    // transition arrived in the bell looking routine. Going through the
    // dispatcher removes that whole class of hand-maintained field: severity
    // comes from the category, and so do the channels, the preference gate,
    // the rate limit and the delivery audit.
    const { notifyAdminOperationalEvent } = await import('../notifications/events.js');
    await notifyAdminOperationalEvent(db, 'node', {
      subsystem: 'Node health',
      objectLabel: entry.name,
      detail: conditions.length > 0 ? `${title}.` : `${title}. Node ${entry.name} OK.`,
      items: conditions,
      severityLabel: entry.severity,
      recommendedAction: entry.severity === 'critical'
        ? 'Check the node in Cluster → Nodes.'
        : '',
    }, `node-health:${entry.name}:${entry.severity}:${new Date().toISOString().slice(0, 13)}`)
      .catch((err) => console.error('[node-health-monitor] notification dispatch failed:', (err as Error).message));
  }

  // Phase 6A: route critical node-down transitions through the
  // categorised dispatcher. The going-down key is scoped to (node × boot ×
  // day) and shared with the fast down-watch and the shutdown notice, so one
  // outage is announced once — as "shutting down" when the kubelet said so,
  // as "down" otherwise — whichever detector sees it first. We only fire for
  // ready=false transitions (not warnings).
  if (coveredByNodeDown && !goingDown.shutdownNoticeNow) {
    await notifyAdminNodeDown(db, { nodeName: entry.name }, goingDown.goingDownKey);
  }
}

function titleFor(entry: NodeHealthEntry, prev: NodeHealthSeverity): string {
  if (entry.severity === 'normal') return `Node ${entry.name} recovered to normal`;
  const verb = prev === 'normal' ? 'flagged' : 'still';
  if (entry.severity === 'critical') return `Node ${entry.name} ${verb} CRITICAL`;
  return `Node ${entry.name} ${verb} at warning level`;
}

/** Each condition of the node, one list item apiece (rendered as a list on every channel). */
export function conditionsFor(entry: NodeHealthEntry): string[] {
  const items: string[] = [];
  if (!entry.ready) items.push('NotReady');
  for (const p of entry.pressures) items.push(`Pressure: ${p}`);
  for (const d of entry.csiDriversMissing) items.push(`CSI driver missing: ${d}`);
  if (entry.evictionsLastHour > 0) items.push(`${entry.evictionsLastHour} pod eviction(s) in the last hour`);
  if (entry.diskUsedPct !== null) items.push(`Disk ${entry.diskUsedPct.toFixed(0)}% used`);
  return items;
}

function pickEventTimestamp(e: RawEvent): Date | null {
  const candidates = [e.eventTime, e.lastTimestamp, e.firstTimestamp, e.metadata?.creationTimestamp];
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Read-side helper for the API route + UI. Returns the latest
 * persisted snapshot in api-contracts shape, sorted by severity then
 * name. Falls back to live computation if no rows exist (first tick
 * hasn't fired yet on a fresh boot).
 */
export async function readNodeHealthSummary(db: Database): Promise<{
  readonly nodes: ReadonlyArray<NodeHealthEntry>;
  readonly overallSeverity: NodeHealthSeverity;
  readonly lastTickAt: string | null;
}> {
  const rows = await db.select().from(nodeHealthState);
  const entries: NodeHealthEntry[] = rows.map((r) => ({
    name: r.nodeName,
    ready: r.ready,
    pressures: (r.pressures as string[]).filter(
      (p): p is 'disk' | 'memory' | 'pid' => p === 'disk' || p === 'memory' || p === 'pid',
    ),
    csiDriversPresent: r.csiDriversPresent,
    csiDriversExpected: r.csiDriversExpected,
    csiDriversMissing: [...(r.csiDriversMissing as string[])],
    evictionsLastHour: r.evictionsLastHour,
    diskUsedPct: r.diskUsedPct === null ? null : Number(r.diskUsedPct),
    severity: r.severity as NodeHealthSeverity,
    observedAt: r.observedAt.toISOString(),
  }));
  // Sort: critical → warning → normal, then by name.
  const order: Record<NodeHealthSeverity, number> = { critical: 0, warning: 1, normal: 2 };
  entries.sort((a, b) => order[a.severity] - order[b.severity] || a.name.localeCompare(b.name));

  let lastTickAt: string | null = null;
  if (rows.length > 0) {
    const latest = rows.reduce<Date | null>((acc, r) => {
      if (!acc || r.observedAt.getTime() > acc.getTime()) return r.observedAt;
      return acc;
    }, null);
    lastTickAt = latest?.toISOString() ?? null;
  }

  return {
    nodes: entries,
    overallSeverity: overallSeverity(entries),
    lastTickAt,
  };
}

export function startNodeHealthScheduler(
  db: Database,
  k8s: K8sClients,
): { readonly stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  console.log('[node-health-monitor] starting (5min cadence)');

  const tick = async () => {
    if (stopped) return;
    try {
      // One replica writes the node-health rows (lease); every replica serves them.
      // The run lock keeps the tick off a check an operator has started: both
      // would see the same change of severity and each send its notice.
      const leased = await withSchedulerLease(db, 'node-health-monitor', TICK_MS * 1.5,
        () => runExclusive(db, 'node-health-monitor', () => reconcileNodeHealth(db, k8s)));
      const notified = leased.ran && leased.value.ran ? leased.value.value.notified : [];
      if (notified.length > 0) {
        console.log(`[node-health-monitor] notified ${notified.length} severity transition(s): ${notified.join(', ')}`);
      }
    } catch (err) {
      console.error('[node-health-monitor] tick failed:', (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, TICK_MS);
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// Exported for SQL audits + drizzle relations if needed elsewhere.
export const _nodeHealthStateForRelations = nodeHealthState;
// `sql` is imported because some downstream callers want to count rows;
// keep the import alive via this re-export.
export { sql, eq };
