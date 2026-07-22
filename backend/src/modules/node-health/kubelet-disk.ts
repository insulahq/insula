/**
 * Phase 1b — host root-disk usage for node-health (resource monitoring, 2026-07).
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
interface KubeletSummary {
  readonly node?: { readonly fs?: KubeletNodeFs };
}

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

function fetchSummary(ctx: KubeletHttpsContext, node: string): Promise<KubeletSummary | null> {
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
        timeout: 6_000,
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
    })();
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
