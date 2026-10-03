/**
 * Announcing node memory events — each to the category that matches what it
 * IS, worded from what is actually known.
 *
 * WHY THIS EXISTS
 * ---------------
 * One 32 MiB tenant nginx OOM kill on production reached the admins twice: as
 * "Tenant evictions (memory pressure)" — nothing was evicted and the node had
 * no memory pressure; container OOMs had been bolted onto the eviction
 * category — and again 23 minutes later from a second, hourly OOM scan. On DEV
 * the same eviction-titled alert listed a container that merely exited 137 as
 * a possible OOM and advised raising the tenant's memory limit.
 *
 * Routing now:
 *   kubelet evictions, kernel SystemOOM  → admin.node_memory_event_{warning,critical}
 *                                          grouped per node per hour, headline
 *                                          naming what it was (memory / disk /
 *                                          PID pressure, storage limit, node OOM)
 *   tenant container kill                → admin.tenant_pod_oom, one per kill
 *   platform container kill              → admin.system_pod_oom, one per kill
 *
 * and this is the ONLY sender of any of them (the hourly metrics-scheduler
 * scan is gone). The tenant dedupe key is the one that scan used, so a kill it
 * already announced before an upgrade is not announced again.
 */

import type { Database } from '../../db/index.js';
import type { NodeMemoryEventCause } from '@insula/api-contracts';
import {
  notifyAdminNodeMemoryEvents,
  notifyAdminSystemPodOom,
  notifyAdminTenantOom,
} from '../notifications/events.js';
import type { NormalizedMemoryEvent, ReportedKillCause, TenantRef } from './memory-events.js';

export interface NotifyContext {
  readonly now: Date;
  readonly tenantFor: (namespace: string) => TenantRef | undefined;
  /** Nodes in their join grace window — recorded, not announced. */
  readonly isNotificationSuppressed: (nodeName: string) => boolean;
}

export async function notifyMemoryEvents(
  db: Database,
  inserted: ReadonlyArray<NormalizedMemoryEvent>,
  ctx: NotifyContext,
): Promise<void> {
  const hour = ctx.now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const nodeLevel = inserted.filter((e) => e.kind !== 'container-oom');
  for (const n of summarizeNodeEvents(nodeLevel, (ns) => ctx.tenantFor(ns)?.name)) {
    if (ctx.isNotificationSuppressed(n.nodeName)) {
      console.log(`[node-health-monitor] ${n.nodeName} is joining — ${n.severity} memory-event notification suppressed (${n.headline})`);
      continue;
    }
    // Hourly per node, severity AND kind of event: a repeat of the same kind
    // within the hour is the designed rate limit, but a different kind (disk
    // pressure after a storage-limit eviction) is news and must get through.
    await notifyAdminNodeMemoryEvents(db, n.severity,
      { nodeName: n.nodeName, headline: n.headline, summary: n.summary, advice: n.advice },
      `node-memory:${n.severity}:${n.nodeName}:${n.kinds.join('+')}:${hour}`);
  }

  for (const e of inserted) {
    if (e.kind !== 'container-oom') continue;
    if (ctx.isNotificationSuppressed(e.nodeName)) {
      console.log(`[node-health-monitor] ${e.nodeName} is joining — container kill notification suppressed (${e.podName}/${e.containerName})`);
      continue;
    }
    const cause = e.cause as ReportedKillCause;
    const restartCount = e.restartCount ?? 0;
    const containerName = e.containerName ?? '?';
    const podName = e.podName ?? '?';
    const tenant = e.namespace ? ctx.tenantFor(e.namespace) : undefined;
    if (e.systemWorkload) {
      const { killSummary, killDetail } = describeContainerKill(cause, e.nodeName, 'platform');
      await notifyAdminSystemPodOom(db, {
        component: platformComponentLabel(e, tenant),
        podName,
        containerName,
        nodeName: e.nodeName,
        restartCount: String(restartCount),
        killSummary,
        killDetail,
      }, `platform-oom:${e.podUid ?? podName}:${containerName}:${restartCount}:${e.occurredAt.getTime()}`);
    } else {
      const { killSummary, killDetail } = describeContainerKill(cause, e.nodeName, 'tenant');
      // tenantId tags the row so the admin notification deep-links to the tenant.
      await notifyAdminTenantOom(db, tenant?.id, {
        tenantLabel: tenant?.name ?? e.namespace ?? 'unknown tenant',
        podName,
        containerName,
        restartCount: String(restartCount),
        killSummary,
        killDetail,
      }, `oom:${tenant?.id ?? e.namespace ?? 'unknown'}:${podName}:${containerName}:${restartCount}`);
    }
  }
}

/** Who a platform kill hit, in words: the namespace, or the tenant it serves. */
function platformComponentLabel(e: NormalizedMemoryEvent, tenant: TenantRef | undefined): string {
  if (e.platformManaged && e.namespace && tenant) return `platform component in tenant "${tenant.name}"`;
  if (e.platformManaged && e.namespace) return `platform component in ${e.namespace}`;
  return e.namespace ?? 'node';
}

/** Wording for one container kill, split so the subject can stay short. */
export interface KillPhrasing {
  /** Subject fragment: "<container> {{killSummary}}". */
  readonly killSummary: string;
  /** Body sentence after "<container> in <pod>", including what to do. */
  readonly killDetail: string;
}

/**
 * The words follow the evidence. Only a kernel-confirmed limit kill blames
 * the limit; a node-level OOM says the limit is innocent; the kubelet's bare
 * OOMKilled says what it cannot tell; an unconfirmed SIGKILL claims nothing.
 */
export function describeContainerKill(
  cause: ReportedKillCause,
  nodeName: string,
  audience: 'tenant' | 'platform',
): KillPhrasing {
  const sizing = audience === 'tenant'
    ? 'raise its memory limit/plan'
    : "raise this component's memory limit in its manifest (platform workloads are sized by the platform, not a tenant plan)";
  switch (cause) {
    case 'memory-limit':
      return {
        killSummary: 'OOM-killed at its memory limit',
        killDetail: `was OOM-killed at its memory limit on node ${nodeName} - the kernel's own counters confirm it. `
          + `Repeated kills mean it needs more memory than its limit allows (${sizing}) or it has a leak.`,
      };
    case 'node-oom':
      return {
        killSummary: "killed by the node's out-of-memory killer",
        killDetail: `was killed by the kernel out-of-memory killer because node ${nodeName} ran out of memory - `
          + 'not because of its own limit, so raising that will not help. Check the node\'s memory headroom.',
      };
    case 'oom':
      return {
        killSummary: 'OOM-killed',
        killDetail: `was OOM-killed on node ${nodeName}, as reported by the kubelet; whether at its own limit or by a `
          + `node-wide out-of-memory kill could not be determined. Repeated kills usually mean it needs more memory (${sizing}) or has a leak.`,
      };
    case 'unconfirmed':
      return {
        killSummary: 'SIGKILLed (cause unconfirmed)',
        killDetail: `was SIGKILLed (exit 137) on node ${nodeName}. The cause is UNCONFIRMED - exit 137 is 128+SIGKILL from any `
          + 'source, including a cgroup OOM group-kill, a failed liveness probe or a node drain, and no kernel OOM counters '
          + 'were available for it. '
          + (audience === 'platform' ? 'Check whether it handles SIGTERM, and ' : 'Check ')
          + "the container's memory.peak against its limit before changing anything.",
      };
  }
}

const EVICTION_LABEL: Readonly<Record<string, string>> = {
  'node-memory-pressure': 'node memory pressure',
  'node-disk-pressure': 'node disk pressure',
  'node-pid-pressure': 'node PID pressure',
  'pod-storage-limit': 'pod ephemeral-storage limit exceeded',
  other: 'kubelet eviction',
};

/** Order in which eviction causes are listed and advised on. */
const EVICTION_ORDER: readonly NodeMemoryEventCause[] = [
  'node-memory-pressure', 'node-disk-pressure', 'node-pid-pressure', 'pod-storage-limit', 'other',
];

function evictionAdvice(cause: NodeMemoryEventCause, system: boolean): string {
  switch (cause) {
    case 'node-memory-pressure':
      return system
        ? 'SYSTEM pods should never lose this fight - the eviction design takes tenant pods first; investigate node memory now.'
        : 'Memory evictions are the designed backpressure - review node headroom / tenant sizing if they repeat.';
    case 'node-disk-pressure':
      return 'The node is low on disk - free space (images, logs, volumes) or grow the disk.';
    case 'node-pid-pressure':
      return 'The node is running out of process IDs - look for a process leak.';
    case 'pod-storage-limit':
      return "The pod wrote more local (ephemeral) storage than its own limit allows - the node itself is fine; raise the pod's ephemeral-storage limit or move the data to a volume.";
    default:
      return 'The kubelet message (Node health -> Memory events) says why.';
  }
}

/** How many affected objects to name individually before switching to "+N more". */
const MAX_NAMED = 3;

/**
 * Group NEW evictions and SystemOOM events into per-(node × severity)
 * notifications. Container kills are never passed here — they are not node
 * events and get their own per-kill alerts. Pure — unit tested directly.
 */
export function summarizeNodeEvents(
  events: ReadonlyArray<NormalizedMemoryEvent>,
  labelForNamespace: (ns: string) => string | undefined = () => undefined,
): Array<{
  nodeName: string;
  severity: 'critical' | 'warning';
  headline: string;
  /** One list item per affected pod (and the node's own OOM). */
  summary: string[];
  /** What to do about it. */
  advice: string;
  /** What the group contains ('system-oom', eviction causes), sorted — the dedupe dimension. */
  kinds: string[];
}> {
  interface Group {
    nodeName: string;
    severity: 'critical' | 'warning';
    systemOom: number;
    evictions: Map<NodeMemoryEventCause, NormalizedMemoryEvent[]>;
  }
  const groups = new Map<string, Group>();
  for (const e of events) {
    if (e.kind === 'container-oom') continue;
    const severity: 'critical' | 'warning' = e.systemWorkload ? 'critical' : 'warning';
    const key = `${e.nodeName} ${severity}`;
    const g = groups.get(key) ?? { nodeName: e.nodeName, severity, systemOom: 0, evictions: new Map() };
    if (e.kind === 'system-oom') {
      g.systemOom += 1;
    } else {
      const list = g.evictions.get(e.cause) ?? [];
      list.push(e);
      g.evictions.set(e.cause, list);
    }
    groups.set(key, g);
  }

  return [...groups.values()].map((g) => {
    const system = g.severity === 'critical';
    const who = system ? 'SYSTEM' : 'tenant';
    const causes = EVICTION_ORDER.filter((c) => g.evictions.has(c));

    const headlines: string[] = [];
    if (g.systemOom > 0) headlines.push('Node ran out of memory (kernel OOM killer)');
    if (causes.length > 0) {
      headlines.push(`${system ? 'SYSTEM' : 'Tenant'} pods evicted (${causes.map((c) => EVICTION_LABEL[c]).join(', ')})`);
    }

    // One list item per thing that happened: the node's own OOM, then each
    // evicted pod by name — rendered as a list on every channel.
    const items: string[] = [];
    if (g.systemOom > 0) {
      items.push(`Kernel SystemOOM (${g.systemOom} event${g.systemOom === 1 ? '' : 's'}) — the node itself ran out of memory`);
    }
    for (const c of causes) {
      const evs = g.evictions.get(c) ?? [];
      for (const e of evs.slice(0, MAX_NAMED)) items.push(`${describeEvicted(e, labelForNamespace)} — evicted (${EVICTION_LABEL[c]})`);
      if (evs.length > MAX_NAMED) items.push(`+${evs.length - MAX_NAMED} more ${who} pod(s) evicted (${EVICTION_LABEL[c]})`);
    }

    const advice: string[] = [];
    if (g.systemOom > 0) advice.push('Check the node\'s memory headroom; container OOM kills are reported separately.');
    for (const c of causes) advice.push(evictionAdvice(c, system));
    advice.push('Details: Monitoring -> Node health -> Memory events.');

    return {
      nodeName: g.nodeName,
      severity: g.severity,
      headline: headlines.join('; '),
      summary: items,
      advice: advice.join(' '),
      kinds: [...(g.systemOom > 0 ? ['system-oom'] : []), ...causes].sort(),
    };
  });
}

/** Tenant NAME (or namespace for SYSTEM pods) plus the pod name. */
function describeEvicted(
  e: NormalizedMemoryEvent,
  labelForNamespace: (ns: string) => string | undefined,
): string {
  const who = e.systemWorkload
    ? (e.namespace ?? 'node')
    : `tenant "${e.namespace ? (labelForNamespace(e.namespace) ?? e.namespace) : 'unknown tenant'}"`;
  return e.podName ? `${who} (pod ${e.podName})` : who;
}


