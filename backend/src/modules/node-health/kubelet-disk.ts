/**
 * Kubelet `/stats/summary` readers — host root-disk fill for node-health,
 * per-PVC filesystem fill for the dashboard's volume alert, and each node's
 * memory split (process / cache) for the dashboard's node figures. All come
 * from the same document, so they share one fetch, one HTTPS context and one
 * set of best-effort rules.
 *
 * Root-disk usage for node-health:
 *
 * node-health/scheduler.ts previously hard-coded `diskUsedPct: null`, leaving
 * the already-written 75/90 % thresholds (service.ts) as dead code — only the
 * kubelet-reported DiskPressure boolean fired. This reader fills that gap by
 * reading each node's kubelet `/stats/summary` and returning the root-filesystem
 * fill percentage.
 *
 * We take the MAX of byte-fill % and inode-fill %: inode exhaustion causes the
 * same DiskPressure eviction as running out of bytes, so folding both into the
 * one `diskUsedPct` signal lights the existing thresholds for either condition
 * without an api-contracts change.
 *
 * Path choice: the apiserver-proxy (`/api/v1/nodes/<node>/proxy/stats/summary`)
 * is always reachable from platform-api (no :10250 host-firewall dependency),
 * at ~250 ms/node. node-health ticks every 5 min over a handful of nodes, so the
 * cost is immaterial — unlike the tenant per-PVC volume reader (tenants/service.ts)
 * which is latency-sensitive and keeps a direct-:10250-first fast path.
 */

interface KubeletNodeFs {
  readonly usedBytes?: number;
  readonly capacityBytes?: number;
  readonly inodesUsed?: number;
  readonly inodes?: number;
}
/**
 * One entry per volume mounted by a pod. `pvcRef` is present only for volumes
 * backed by a PersistentVolumeClaim — configMap, secret and emptyDir mounts
 * appear here too and carry none.
 */
interface KubeletPodVolume {
  readonly usedBytes?: number;
  readonly capacityBytes?: number;
  readonly inodesUsed?: number;
  readonly inodes?: number;
  readonly pvcRef?: { readonly name?: string; readonly namespace?: string };
}
/** The node's memory as the kubelet reports it (bytes). */
interface KubeletNodeMemory {
  /** Usage less inactive file cache — what the kubelet evicts on. */
  readonly workingSetBytes?: number;
  /** Anonymous (process) memory. */
  readonly rssBytes?: number;
  readonly usageBytes?: number;
}
interface KubeletSummary {
  readonly node?: { readonly fs?: KubeletNodeFs; readonly memory?: KubeletNodeMemory };
  readonly pods?: ReadonlyArray<{ readonly volume?: readonly KubeletPodVolume[] }>;
}

/** Filesystem occupancy of one PVC, as the kubelet that mounted it sees it. */
export interface PvcFsStats {
  readonly namespace: string;
  readonly pvcName: string;
  readonly usedBytes: number;
  readonly capacityBytes: number;
  readonly inodesUsed: number | null;
  readonly inodes: number | null;
}

/** Map key for a PVC, which is only unique within its namespace. */
export const pvcStatsKey = (namespace: string, pvcName: string): string => `${namespace}/${pvcName}`;

interface KubeletHttpsContext {
  readonly server: string;
  readonly opts: { ca?: string; cert?: string; key?: string; headers?: Record<string, string> };
  readonly agent: import('node:https').Agent;
}

let _ctx: KubeletHttpsContext | null = null;
let _ctxInit: Promise<KubeletHttpsContext | null> | null = null;

async function getContext(): Promise<KubeletHttpsContext | null> {
  if (_ctx) return _ctx;
  if (_ctxInit) return _ctxInit;
  _ctxInit = (async () => {
    const k8sNode = await import('@kubernetes/client-node');
    const https = await import('node:https');
    const kc = new k8sNode.KubeConfig();
    try { kc.loadFromCluster(); } catch { return null; }
    const opts = {} as KubeletHttpsContext['opts'];
    await kc.applyToHTTPSOptions(opts);
    const cluster = kc.getCurrentCluster();
    if (!cluster?.server) return null;
    const agent = new https.Agent({
      keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 16, maxFreeSockets: 4,
      // CA from applyToHTTPSOptions covers the apiserver, so verification works.
    });
    _ctx = { server: cluster.server, opts, agent };
    return _ctx;
  })();
  const ctx = await _ctxInit;
  _ctxInit = null;
  return ctx;
}

/**
 * Pure: kubelet node.fs → fill percentage (0–100, rounded to 1 dp), taking the
 * worse of byte-fill and inode-fill. Returns null when neither is measurable.
 */
export function computeNodeDiskPct(fs: KubeletNodeFs | undefined): number | null {
  if (!fs) return null;
  const pcts: number[] = [];
  if (typeof fs.usedBytes === 'number' && typeof fs.capacityBytes === 'number' && fs.capacityBytes > 0) {
    pcts.push((fs.usedBytes / fs.capacityBytes) * 100);
  }
  if (typeof fs.inodesUsed === 'number' && typeof fs.inodes === 'number' && fs.inodes > 0) {
    pcts.push((fs.inodesUsed / fs.inodes) * 100);
  }
  if (pcts.length === 0) return null;
  return Math.round(Math.max(...pcts) * 10) / 10;
}

/** A node's memory split: what processes hold, and the cache the working set also counts. */
export interface NodeMemoryStats {
  readonly processBytes: number;
  readonly cacheBytes: number;
}

/**
 * Pure: kubelet node.memory → process memory (rss) and the rest of the working
 * set — mostly active page cache, but also shared memory (database buffers,
 * memory-backed volumes) and kernel memory, which the kubelet does not report
 * apart and the kernel cannot hand back. null unless
 * both are present; cache is clamped at zero, since the two are sampled from
 * different cgroup files and can disagree by a sample.
 */
export function computeNodeMemory(m: KubeletNodeMemory | undefined): NodeMemoryStats | null {
  if (typeof m?.workingSetBytes !== 'number' || typeof m.rssBytes !== 'number') return null;
  return { processBytes: m.rssBytes, cacheBytes: Math.max(0, m.workingSetBytes - m.rssBytes) };
}

function fetchSummary(ctx: KubeletHttpsContext, node: string, timeoutMs = 6_000): Promise<KubeletSummary | null> {
  return new Promise((resolve) => {
    void (async () => {
      const https = await import('node:https');
      const u = new URL(`${ctx.server}/api/v1/nodes/${encodeURIComponent(node)}/proxy/stats/summary`);
      const req = https.request({
        method: 'GET',
        host: u.hostname,
        port: u.port || 443,
        path: u.pathname,
        ca: ctx.opts.ca,
        cert: ctx.opts.cert,
        key: ctx.opts.key,
        headers: ctx.opts.headers ?? {},
        agent: ctx.agent,
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data) as KubeletSummary); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    })().catch(() => resolve(null)); // a synchronous throw must not leave the caller waiting forever
  });
}

/**
 * Read root-fs fill % for each node via kubelet /stats/summary. Best-effort:
 * unreachable nodes are simply absent from the returned map (caller treats a
 * missing entry as `diskUsedPct: null`, i.e. "unknown", never a false alert).
 */
export async function readNodeDiskStats(nodeNames: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (nodeNames.length === 0) return out;
  const ctx = await getContext();
  if (!ctx) return out;
  await Promise.all(nodeNames.map(async (node) => {
    const summary = await fetchSummary(ctx, node);
    const pct = computeNodeDiskPct(summary?.node?.fs);
    if (pct !== null) out.set(node, pct);
  }));
  return out;
}

/**
 * Each node's memory split (process / cache) via kubelet /stats/summary, for
 * the dashboard's node figures. Best-effort like the others: a node that does
 * not answer within `timeoutMs` is absent, and the caller falls back to the
 * metrics API's working set. The timeout is the caller's because the dashboard
 * reads nodes under its own deadline.
 */
export async function readNodeMemoryStats(
  nodeNames: readonly string[],
  opts: { readonly timeoutMs: number },
): Promise<Map<string, NodeMemoryStats>> {
  const out = new Map<string, NodeMemoryStats>();
  if (nodeNames.length === 0) return out;
  const ctx = await getContext();
  if (!ctx) return out;
  await Promise.all(nodeNames.map(async (node) => {
    // fetchSummary's own timeout is an idle-socket one; this is the total.
    const summary = await settleWithin(fetchSummary(ctx, node, opts.timeoutMs), opts.timeoutMs, null);
    const mem = computeNodeMemory(summary?.node?.memory);
    if (mem) out.set(node, mem);
  }));
  return out;
}

/** `p`, or `fallback` once `ms` have passed — whichever comes first. */
export function settleWithin<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * Pure: PVC filesystem stats → fill fraction (0–1), taking the worse of
 * byte-fill and inode-fill for the same reason `computeNodeDiskPct` does —
 * a volume out of inodes refuses writes exactly as hard as one out of bytes,
 * and `df` alone would show it comfortably empty.
 *
 * Returns null when neither is measurable, which the caller must treat as
 * "unknown" and never as "fine".
 */
export function computePvcFillFraction(s: PvcFsStats | undefined): number | null {
  if (!s) return null;
  const fractions: number[] = [];
  if (s.capacityBytes > 0) fractions.push(s.usedBytes / s.capacityBytes);
  if (s.inodes !== null && s.inodes > 0 && s.inodesUsed !== null) {
    fractions.push(s.inodesUsed / s.inodes);
  }
  if (fractions.length === 0) return null;
  return Math.max(...fractions);
}

/**
 * Merge two readings of the same PVC. A ReadWriteMany volume is reported once
 * per mounting pod, and the copies can disagree by a sample interval; keep the
 * fuller one so a merge can only ever round toward the alert, never away.
 */
function worseOf(a: PvcFsStats, b: PvcFsStats): PvcFsStats {
  return (computePvcFillFraction(b) ?? -1) > (computePvcFillFraction(a) ?? -1) ? b : a;
}

/**
 * Per-PVC filesystem occupancy across the given nodes, keyed `namespace/name`.
 *
 * This is the number that answers "will this workload stop writing" — the
 * filesystem's own used/capacity, the same pair `df` prints inside the pod.
 * Longhorn's `status.actualSize` does NOT answer it: that counts the blocks
 * the replica occupies on the host INCLUDING every snapshot in the chain, so
 * a volume with hourly snapshots and heavy rewrite churn reports far more
 * than the filesystem holds — and, having no relation to the volume's
 * capacity, can exceed it outright.
 *
 * Best-effort, like `readNodeDiskStats`: a node that does not answer is simply
 * absent from the map. Callers must distinguish "absent" from "empty".
 */
export async function readPvcVolumeStats(
  nodeNames: readonly string[],
): Promise<Map<string, PvcFsStats>> {
  const out = new Map<string, PvcFsStats>();
  if (nodeNames.length === 0) return out;
  const ctx = await getContext();
  if (!ctx) return out;
  await Promise.all(nodeNames.map(async (node) => {
    const summary = await fetchSummary(ctx, node);
    for (const pod of summary?.pods ?? []) {
      for (const vol of pod.volume ?? []) {
        const namespace = vol.pvcRef?.namespace;
        const pvcName = vol.pvcRef?.name;
        if (!namespace || !pvcName) continue;
        if (typeof vol.usedBytes !== 'number' || typeof vol.capacityBytes !== 'number') continue;
        const stats: PvcFsStats = {
          namespace,
          pvcName,
          usedBytes: vol.usedBytes,
          capacityBytes: vol.capacityBytes,
          inodesUsed: typeof vol.inodesUsed === 'number' ? vol.inodesUsed : null,
          inodes: typeof vol.inodes === 'number' ? vol.inodes : null,
        };
        const key = pvcStatsKey(namespace, pvcName);
        const seen = out.get(key);
        out.set(key, seen ? worseOf(seen, stats) : stats);
      }
    }
  }));
  return out;
}
