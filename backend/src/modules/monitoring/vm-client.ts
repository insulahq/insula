/**
 * Minimal VictoriaMetrics query client (ADR-051 phase 3).
 *
 * Talks to vmsingle's Prometheus-compatible HTTP API over the in-cluster
 * Service (NetworkPolicy allow-ingress-to-vmsingle admits platform-api).
 * Plain fetch + AbortController timeout — same shape as
 * backup-config/longhorn-backups.ts. No retries here: the evaluator owns
 * failure accounting (consecutive-failure → monitoring-unreachable).
 */

// vmsingle serves under -http.pathPrefix=/metrics (so its UI/API can
// ride the admin host as a path route) — the prefix applies to the
// in-cluster API surface too.
export const DEFAULT_VM_BASE_URL = 'http://vmsingle.monitoring:8428/metrics';

const QUERY_TIMEOUT_MS = 5_000;

export interface VmSample {
  readonly labels: Record<string, string>;
  readonly value: number;
  readonly timestamp: number;
}

export interface VmRangeSeries {
  readonly labels: Record<string, string>;
  readonly points: ReadonlyArray<readonly [number, number]>;
}

export interface VmClientOptions {
  readonly baseUrl?: string;
  readonly fetchFn?: typeof globalThis.fetch;
}

function resolveBase(opts: VmClientOptions): string {
  return opts.baseUrl ?? process.env.VM_BASE_URL ?? DEFAULT_VM_BASE_URL;
}

async function vmFetch(url: string, opts: VmClientOptions): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`vmsingle returned HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Instant query — returns every sample of the result vector. */
export async function queryInstant(
  expr: string,
  opts: VmClientOptions = {},
): Promise<VmSample[]> {
  const url = `${resolveBase(opts)}/api/v1/query?query=${encodeURIComponent(expr)}`;
  const body = await vmFetch(url, opts) as {
    status?: string;
    data?: { resultType?: string; result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> };
  };
  if (body.status !== 'success') {
    throw new Error(`vmsingle query failed: ${JSON.stringify(body).slice(0, 200)}`);
  }
  const out: VmSample[] = [];
  for (const r of body.data?.result ?? []) {
    const v = r.value;
    if (!v) continue;
    const num = Number(v[1]);
    if (Number.isNaN(num)) continue;
    out.push({ labels: r.metric ?? {}, value: num, timestamp: v[0] });
  }
  return out;
}

/** Range query for the panel series proxy. */
export async function queryRange(
  expr: string,
  startEpoch: number,
  endEpoch: number,
  stepSeconds: number,
  opts: VmClientOptions = {},
): Promise<VmRangeSeries[]> {
  const url = `${resolveBase(opts)}/api/v1/query_range`
    + `?query=${encodeURIComponent(expr)}&start=${startEpoch}&end=${endEpoch}&step=${stepSeconds}`;
  const body = await vmFetch(url, opts) as {
    status?: string;
    data?: { result?: Array<{ metric?: Record<string, string>; values?: Array<[number, string]> }> };
  };
  if (body.status !== 'success') {
    throw new Error(`vmsingle range query failed: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return (body.data?.result ?? []).map((r) => ({
    labels: r.metric ?? {},
    points: (r.values ?? [])
      .map(([t, v]) => [t, Number(v)] as const)
      .filter(([, v]) => !Number.isNaN(v)),
  }));
}
