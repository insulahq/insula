/**
 * Reap Traefik's orphaned response-buffer spool files.
 *
 * `waf-body-limit` is a Traefik `buffering` middleware, and buffering is not
 * request-only: it spools the whole RESPONSE to a temp file before releasing a
 * byte to the client. The file is oxy's `/tmp/temp-multibuf-<n>` and it is NOT
 * removed when the client disconnects mid-transfer.
 *
 * Measured on the reference cluster: four abandoned downloads left 2.68 GB of
 * orphaned spool files (the largest 1.54 GB). Traefik's `/tmp` is an emptyDir,
 * which lives on the NODE ROOT filesystem — the same disk as k3s, etcd,
 * containerd and Longhorn — so the leak is a path to DiskPressure eviction on a
 * single-node cluster, not merely wasted space.
 *
 * The GET carve-out in `system-settings/ingress-reconciler.ts` stops the large
 * downloads that made this obvious, but it does NOT stop the leak: every
 * response over `memResponseBodyBytes` (1 MiB) on any still-buffered route
 * spools the same way, and an admin who closes the tab still orphans it. So the
 * reaper is the durable half of the fix and the carve-out is the loud half.
 *
 * ★ Why exec rather than a sidecar or a DaemonSet: the spool lives inside
 * Traefik's own emptyDir, which no other pod can mount. A sidecar would mean
 * changing the Traefik Helm values, which needs a host-migration and reaches
 * fresh installs only. platform-api already holds a k8s client, already has
 * `pods/exec` in the `traefik` namespace, and already runs a dozen of these
 * sweepers — so this reuses all of it and adds no cluster surface.
 */
import type { CoreV1Api, Exec } from '@kubernetes/client-node';

/** Spool files younger than this are left alone — they may still be in flight. */
export const DEFAULT_MIN_AGE_MINUTES = 60;

/** Filename prefix oxy gives its multi-buffer spool files. */
export const SPOOL_GLOB = 'temp-multibuf-*';

const TRAEFIK_NAMESPACE = 'traefik';
const TRAEFIK_SELECTOR = 'app.kubernetes.io/name=traefik';
const EXEC_TIMEOUT_MS = 15_000;

export interface SpoolReaperLogger {
  readonly info: (msg: string, ctx?: object) => void;
  readonly warn: (msg: string, err?: unknown) => void;
}

export interface SpoolReaperDeps {
  readonly core: CoreV1Api;
  readonly exec: Exec;
  readonly logger: SpoolReaperLogger;
  /**
   * Files must be older than this to be deleted. 60 min, not 5: with the GET
   * carve-out in place the only responses still buffered are small and fast, so
   * anything an hour old is orphaned. A shorter window risks deleting the spool
   * of a large in-flight transfer on a route that is still buffered — which
   * would abort a download that was going to succeed.
   */
  readonly minAgeMinutes?: number;
  /** Injected for tests. */
  readonly execOnce?: ExecOnce;
}

export type ExecOnce = (
  namespace: string,
  pod: string,
  container: string,
  argv: string[],
) => Promise<string>;

export interface PodReapResult {
  readonly pod: string;
  readonly deleted: number;
  /** Spool bytes still present AFTER the sweep — what the gauge reports. */
  readonly remainingBytes: number;
  readonly reclaimedBytes: number;
  readonly error?: string;
}

export interface SpoolReapResult {
  readonly podsScanned: number;
  readonly deleted: number;
  readonly reclaimedBytes: number;
  /** Max remaining spool across pods — a single node's exposure. */
  readonly remainingBytes: number;
  readonly perPod: ReadonlyArray<PodReapResult>;
}

/**
 * One shell round-trip per pod, not three.
 *
 * @kubernetes/client-node builds a fresh https.Agent per request with
 * keepAlive:false, so request COUNT is the cost that matters, not payload size.
 * Measure, sweep and re-measure in a single `sh -c` and parse one line.
 *
 * `-mmin +N` is the whole safety story: `find` deletes nothing younger. The
 * glob is single-quoted so `find` expands it, not the shell — unquoted, a
 * shell that happened to match one file would pass only that one and silently
 * under-reap.
 */
export function buildSweepScript(minAgeMinutes: number): string {
  return [
    `before=$(du -sk /tmp 2>/dev/null | cut -f1)`,
    `n=$(find /tmp -maxdepth 1 -name '${SPOOL_GLOB}' -mmin +${minAgeMinutes} -print -delete 2>/dev/null | wc -l)`,
    `rem=$(find /tmp -maxdepth 1 -name '${SPOOL_GLOB}' -exec du -k {} + 2>/dev/null | awk '{s+=$1} END {print s+0}')`,
    `after=$(du -sk /tmp 2>/dev/null | cut -f1)`,
    `echo "REAP $\{n:-0} $\{before:-0} $\{after:-0} $\{rem:-0}"`,
  ].join('; ');
}

/**
 * Parse the sweep line.
 *
 * Returns null for anything that is not the exact shape. A pod whose shell
 * differs, or whose `du` is missing, must read as "could not measure" — never
 * as a successful zero, or the gauge would report an all-clear for a pod that
 * was never swept. Cf. a measured zero vs an unmeasured one.
 */
export function parseSweepOutput(stdout: string): {
  deleted: number; reclaimedBytes: number; remainingBytes: number;
} | null {
  const line = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('REAP '));
  if (!line) return null;
  const parts = line.split(/\s+/);
  if (parts.length !== 5) return null;
  const [, nRaw, beforeRaw, afterRaw, remRaw] = parts;
  const n = Number(nRaw);
  const before = Number(beforeRaw);
  const after = Number(afterRaw);
  const rem = Number(remRaw);
  if (![n, before, after, rem].every((v) => Number.isFinite(v) && v >= 0)) return null;
  // du reports kB. Clamp: `after` can exceed `before` if traffic landed
  // between the two measurements, and a negative reclaim is nonsense.
  const reclaimedKb = Math.max(0, before - after);
  return {
    deleted: n,
    reclaimedBytes: reclaimedKb * 1024,
    remainingBytes: rem * 1024,
  };
}

/** Real exec: capture stdout from `sh -c <script>` in a pod. */
export function makeExecOnce(exec: Exec): ExecOnce {
  return async (namespace, pod, container, argv) => {
    const { PassThrough, Writable } = await import('node:stream');
    const chunks: Buffer[] = [];
    const stdout = new PassThrough();
    stdout.on('data', (c: Buffer) => chunks.push(c));
    const stderr = new Writable({ write(_c, _e, cb) { cb(); } });

    let settled = false;
    let ws: { close: () => void } | undefined;
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws?.close(); } catch { /* already gone */ }
        reject(new Error('spool-reaper: exec timed out'));
      }, EXEC_TIMEOUT_MS);
      void exec.exec(
        namespace, pod, container, argv, stdout, stderr, null, false,
        (status) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const failure = status && (status as { status?: string }).status === 'Failure';
          if (failure) {
            reject(new Error(`spool-reaper: exec failed: ${(status as { message?: string }).message ?? 'unknown'}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString('utf8'));
        },
      ).then((s) => { ws = s as unknown as { close: () => void }; })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  };
}

/**
 * Sweep every running Traefik pod once.
 *
 * Never throws: a Traefik that cannot be reached must not take down the
 * scheduler that also has to run next tick. Per-pod failures are recorded and
 * logged, and the aggregate still reports what the reachable pods returned.
 */
export async function reapIngressSpool(deps: SpoolReaperDeps): Promise<SpoolReapResult> {
  const minAge = deps.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES;
  const execOnce = deps.execOnce ?? makeExecOnce(deps.exec);
  const script = buildSweepScript(minAge);

  let pods: Array<{ metadata?: { name?: string }; status?: { phase?: string } }> = [];
  try {
    const res = await deps.core.listNamespacedPod({
      namespace: TRAEFIK_NAMESPACE,
      labelSelector: TRAEFIK_SELECTOR,
    } as unknown as Parameters<typeof deps.core.listNamespacedPod>[0]) as {
      items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }>;
    };
    pods = res.items ?? [];
  } catch (err) {
    deps.logger.warn('spool-reaper: listing Traefik pods failed', err);
    return { podsScanned: 0, deleted: 0, reclaimedBytes: 0, remainingBytes: 0, perPod: [] };
  }

  const running = pods.filter((p) => p.status?.phase === 'Running' && p.metadata?.name);
  const perPod: PodReapResult[] = [];

  for (const p of running) {
    const name = p.metadata!.name!;
    try {
      const out = await execOnce(TRAEFIK_NAMESPACE, name, 'traefik', ['sh', '-c', script]);
      const parsed = parseSweepOutput(out);
      if (!parsed) {
        perPod.push({ pod: name, deleted: 0, remainingBytes: 0, reclaimedBytes: 0, error: 'unparseable sweep output' });
        deps.logger.warn('spool-reaper: unparseable sweep output', { pod: name, out: out.slice(0, 200) });
        continue;
      }
      perPod.push({ pod: name, ...parsed });
    } catch (err) {
      perPod.push({
        pod: name, deleted: 0, remainingBytes: 0, reclaimedBytes: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      deps.logger.warn('spool-reaper: sweep failed', { pod: name, err });
    }
  }

  const ok = perPod.filter((r) => !r.error);
  return {
    podsScanned: running.length,
    deleted: ok.reduce((a, r) => a + r.deleted, 0),
    reclaimedBytes: ok.reduce((a, r) => a + r.reclaimedBytes, 0),
    remainingBytes: ok.reduce((a, r) => Math.max(a, r.remainingBytes), 0),
    perPod,
  };
}
