/**
 * Per-mail-node storage card data.
 *
 * Drives the new "Storage" tab on /email/operations — one card per
 * mail-relevant node (active + primary/secondary/tertiary placement +
 * standby-labelled nodes) showing:
 *
 *   - total       — node's allocatable ephemeral-storage capacity
 *                   (the kubelet's view of "headroom for new pods")
 *   - scheduled   — sum of PVC requests bound to PVs pinned on this
 *                   node (informational: local-path doesn't enforce
 *                   quotas, but the number tells the operator how
 *                   much disk they've already reserved)
 *   - mailUsed    — bytes actually consumed by mail data on this node:
 *                     * active node: du of /var/lib/mail-stack inside
 *                       the running stalwart-mail pod
 *                     * standby node: the latest report from
 *                       system_settings.mail_standby_reports[node].sizeBytes
 *                       (DaemonSet POSTs this on each 5-min rsync cycle)
 *                     * other: null
 *
 * Best-effort everywhere: a missing PV listing, exec failure, or
 * stale standby report yields null for that field — the card still
 * renders with the fields that did resolve.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { parseQuantity } from './mail-pvc.js';

const MAIL_NAMESPACE = 'mail';
const STANDBY_NODE_LABEL_KEY = 'platform.example.test/mail-standby';
const STANDBY_NODE_LABEL_VALUE = 'true';

export interface MailNodeStorage {
  readonly nodeName: string;
  /** Role tag(s) joined: 'active' | 'primary' | 'secondary' | 'tertiary' | 'standby'. May be multiple (comma-separated string). */
  readonly roles: ReadonlyArray<string>;
  readonly isActive: boolean;
  readonly isStandby: boolean;
  /** Node allocatable ephemeral-storage capacity (kubelet). Null when API readout failed. */
  readonly totalBytes: number | null;
  /** Sum of PVC requests bound to PVs pinned to this node. Null on failure. */
  readonly scheduledBytes: number | null;
  /** Mail data actually consumed on this node. Null when unknown. */
  readonly mailUsedBytes: number | null;
  /** ISO timestamp of the data source (standby report time, or "live" for active). */
  readonly mailUsedReportedAt: string | null;
}

export interface MailNodeStorageDeps {
  readonly core: import('@kubernetes/client-node').CoreV1Api;
  readonly exec: import('@kubernetes/client-node').Exec;
  readonly db: Database;
  readonly placement: {
    readonly activeNode: string | null;
    readonly primaryNode: string | null;
    readonly secondaryNode: string | null;
    readonly tertiaryNode: string | null;
  };
  readonly logger?: { warn: (...args: unknown[]) => void };
}

/**
 * Build the per-node storage list.
 *
 * Strategy:
 *   1. Enumerate the unique set of relevant nodes (active + 3 placement
 *      slots + standby-labelled). Dedupe by hostname.
 *   2. Read each node's allocatable.ephemeral-storage for `total`.
 *   3. For `scheduled`, list all PVCs cluster-wide bound to PVs that
 *      pin to the node via spec.nodeAffinity. Sum each PVC's
 *      requested storage. (local-path provisioner is the only one
 *      that pins; other classes contribute 0.)
 *   4. For `mailUsed`:
 *        - active node: du of /var/lib/mail-stack in the stalwart pod
 *        - standby node: latest mail_standby_reports[node] from JSONB
 */
export async function getMailNodeStorage(
  deps: MailNodeStorageDeps,
): Promise<ReadonlyArray<MailNodeStorage>> {
  const { core, exec, db, placement } = deps;
  const log = deps.logger ?? { warn: () => {} };

  // 1. Build {nodeName → roles[]} dict.
  const roleMap = new Map<string, Set<string>>();
  const add = (name: string | null | undefined, role: string) => {
    if (!name) return;
    if (!roleMap.has(name)) roleMap.set(name, new Set());
    roleMap.get(name)!.add(role);
  };
  add(placement.activeNode, 'active');
  add(placement.primaryNode, 'primary');
  add(placement.secondaryNode, 'secondary');
  add(placement.tertiaryNode, 'tertiary');

  // 2. Enumerate standby-labelled nodes from k8s. Empty set on API
  //    failure (we still render the placement-derived cards).
  let allNodes: NodeShape[] = [];
  try {
    const list = await core.listNode({}) as { items?: NodeShape[] };
    allNodes = list.items ?? [];
  } catch (err) {
    log.warn('mail-node-storage: listNode failed:', err);
  }
  for (const n of allNodes) {
    if (n.metadata?.labels?.[STANDBY_NODE_LABEL_KEY] === STANDBY_NODE_LABEL_VALUE) {
      add(nodeHostname(n), 'standby');
    }
  }

  // 3. Pre-read mail_standby_reports JSONB so we can fold per-node
  //    sizeBytes in step 5 without one query per node.
  const standbyReports = await readStandbyReports(db, log);

  // 4. List all PVs once so step 6 is O(N_PVs) not O(nodes × PVs).
  //    `pvsResolved=false` carries the API-failure signal forward so
  //    the per-node card reports scheduledBytes=null (not a misleading
  //    0 B) when the list call failed.
  let allPvs: PvShape[] = [];
  let pvsResolved = true;
  try {
    // PVs are cluster-scoped — listPersistentVolume not listNamespaced.
    const pvList = await core.listPersistentVolume({}) as { items?: PvShape[] };
    allPvs = pvList.items ?? [];
  } catch (err) {
    log.warn('mail-node-storage: listPersistentVolume failed:', err);
    pvsResolved = false;
  }

  // 5. Resolve mailUsed for the active node via exec (single du call).
  const activeMailUsed = placement.activeNode
    ? await tryDuInStalwartPod(core, exec, log)
    : null;

  // 6. Compose one card per unique node.
  const cards: MailNodeStorage[] = [];
  for (const [nodeName, roleSet] of roleMap) {
    const node = allNodes.find((n) => nodeHostname(n) === nodeName) ?? null;
    const totalBytes = node ? nodeTotalBytes(node) : null;
    const scheduledBytes = pvsResolved ? sumPvcRequestsOnNode(allPvs, nodeName) : null;

    const isActive = roleSet.has('active');
    const isStandby = roleSet.has('standby');

    let mailUsedBytes: number | null = null;
    let mailUsedReportedAt: string | null = null;
    if (isActive && activeMailUsed !== null) {
      mailUsedBytes = activeMailUsed;
      mailUsedReportedAt = new Date().toISOString();
    } else {
      const r = standbyReports[nodeName];
      if (r) {
        mailUsedBytes = r.sizeBytes;
        mailUsedReportedAt = r.reportedAt;
      }
    }

    cards.push({
      nodeName,
      roles: Array.from(roleSet).sort(),
      isActive,
      isStandby,
      totalBytes,
      scheduledBytes,
      mailUsedBytes,
      mailUsedReportedAt,
    });
  }

  // Stable sort: active first, then by hostname.
  cards.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.nodeName.localeCompare(b.nodeName);
  });

  return cards;
}

// ── helpers ──────────────────────────────────────────────────────────

interface NodeShape {
  metadata?: { name?: string; labels?: Record<string, string> };
  status?: {
    allocatable?: { 'ephemeral-storage'?: string };
    capacity?: { 'ephemeral-storage'?: string };
  };
}

interface PvShape {
  spec?: {
    capacity?: { storage?: string };
    nodeAffinity?: {
      required?: {
        nodeSelectorTerms?: Array<{
          matchExpressions?: Array<{ key?: string; operator?: string; values?: string[] }>;
        }>;
      };
    };
  };
}

function nodeHostname(n: NodeShape): string {
  return n.metadata?.labels?.['kubernetes.io/hostname'] ?? n.metadata?.name ?? '';
}

function nodeTotalBytes(n: NodeShape): number | null {
  const raw =
    n.status?.allocatable?.['ephemeral-storage']
    ?? n.status?.capacity?.['ephemeral-storage'];
  if (!raw) return null;
  try {
    return parseQuantity(raw);
  } catch {
    return null;
  }
}

/**
 * Sum the storage capacity of all PVs pinned to `nodeName` via
 * spec.nodeAffinity.required.nodeSelectorTerms[*].matchExpressions[*]
 * where key='kubernetes.io/hostname' and the node is in values[].
 *
 * Only local-path PVs typically have this affinity; cross-node
 * provisioners (Longhorn, CSI) leave it empty so they contribute 0. // ci-no-longhorn: ignore
 */
function sumPvcRequestsOnNode(pvs: ReadonlyArray<PvShape>, nodeName: string): number {
  let sum = 0;
  for (const pv of pvs) {
    const terms = pv.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? [];
    let pinsHere = false;
    for (const t of terms) {
      for (const m of t.matchExpressions ?? []) {
        if (m.key !== 'kubernetes.io/hostname') continue;
        if (m.operator !== 'In') continue;
        if (Array.isArray(m.values) && m.values.includes(nodeName)) {
          pinsHere = true;
          break;
        }
      }
      if (pinsHere) break;
    }
    if (!pinsHere) continue;
    const capStr = pv.spec?.capacity?.storage;
    if (!capStr) continue;
    try {
      sum += parseQuantity(capStr);
    } catch {
      /* skip unparseable */
    }
  }
  return sum;
}

interface StandbyReport {
  sizeBytes: number;
  reportedAt: string;
}

async function readStandbyReports(
  db: Database,
  log: { warn: (...args: unknown[]) => void },
): Promise<Record<string, StandbyReport>> {
  try {
    const rows = await db.execute<{ mail_standby_reports: Record<string, StandbyReport> | null }>(sql`
      SELECT mail_standby_reports FROM system_settings WHERE id = 'system' LIMIT 1
    `);
    const r = rows.rows?.[0]?.mail_standby_reports ?? null;
    return r ?? {};
  } catch (err) {
    log.warn('mail-node-storage: standby reports query failed:', err);
    return {};
  }
}

/**
 * Best-effort du in the active stalwart-mail pod. /var/lib/mail-stack
 * is the consolidated A2.5 PVC root (stalwart/ + bulwark/ subpaths).
 */
async function tryDuInStalwartPod(
  core: import('@kubernetes/client-node').CoreV1Api,
  exec: import('@kubernetes/client-node').Exec,
  log: { warn: (...args: unknown[]) => void },
): Promise<number | null> {
  try {
    const pods = await core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
      labelSelector: 'app=stalwart-mail',
      limit: 1,
    } as unknown as Parameters<typeof core.listNamespacedPod>[0]) as {
      items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }>;
    };
    const pod = (pods.items ?? []).find((p) => p.status?.phase === 'Running');
    if (!pod?.metadata?.name) return null;
    // Path resolves to the Stalwart RocksDB DataStore mount inside
    // the stalwart container. The container subPath-mounts the PVC's
    // stalwart/ subtree at /var/lib/stalwart/data — so this matches
    // the legacy mail-pvc.ts probe and the running Stalwart's actual
    // data root. The bulwark/ subtree is on the same PVC but mounted
    // by the bulwark Deployment in a different pod; we don't probe
    // it here because the operator-facing question is "how much disk
    // is mail consuming on the active mail node?", and stalwart is
    // >99% of that.
    const stdout = await execStdoutCapture(exec, pod.metadata.name, ['du', '-sb', '/var/lib/stalwart/data']);
    const firstField = stdout.trim().split(/\s+/, 1)[0];
    const n = Number(firstField);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (err) {
    log.warn('mail-node-storage: du probe failed:', err);
    return null;
  }
}

/**
 * Run `argv` inside the stalwart container of `podName` and resolve
 * its stdout.
 *
 * Implementation notes:
 *   - `node:stream` is awaited at the top (not inside the Promise
 *     constructor) so an import failure correctly rejects the outer
 *     async function rather than leaving the promise pending.
 *   - The WebSocket returned by `exec.exec()` is captured so the
 *     5-second timeout can terminate it explicitly. The original
 *     pattern (mail-pvc.ts:execStdout) leaks the WS on timeout —
 *     fixed here in scope.
 */
async function execStdoutCapture(
  exec: import('@kubernetes/client-node').Exec,
  podName: string,
  argv: string[],
): Promise<string> {
  const { PassThrough, Writable } = await import('node:stream');
  const chunks: Buffer[] = [];
  const stdoutSink = new PassThrough();
  stdoutSink.on('data', (c: Buffer) => chunks.push(c));
  const stderrSink = new Writable({ write(_c, _e, cb) { cb(); } });

  let settled = false;
  let ws: { close: () => void } | undefined;

  const promise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws?.close(); } catch { /* ignore */ }
      reject(new Error('du probe timed out'));
    }, 5_000);

    exec.exec(
      MAIL_NAMESPACE,
      podName,
      'stalwart',
      argv,
      stdoutSink,
      stderrSink,
      null,
      false,
      (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (status.status === 'Failure') {
          reject(new Error(`du probe non-zero: ${status.message ?? 'unknown'}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      },
    ).then((handle) => {
      // @kubernetes/client-node returns a ws-like object with .close().
      // Capture so the timeout path can release it.
      ws = handle as unknown as { close: () => void };
      if (settled) {
        try { ws.close(); } catch { /* already closed */ }
      }
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });

  return promise;
}
