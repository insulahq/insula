/**
 * Runs a tenant cron job and reports what actually happened.
 *
 * Two job types share this path:
 *
 *   webcron     an HTTP request to a tenant-controlled URL, fired through the
 *               SSRF guard because it leaves from the platform-api pod.
 *   deployment  a shell command inside the tenant's own running container.
 *
 * The deployment type has existed in the API contract, the database enum and
 * the tenant panel since the module was written, and never ran: the scheduler
 * selected `type = 'webcron'` only, and "Run now" hit a branch that wrote
 * "not yet implemented" into the output while leaving the status at its
 * initial 'success'. A tenant could create "Moodle cron, * * * * *", watch it
 * report green, and have no cron at all. This module is the execution the
 * contract has been promising.
 */

import { Exec, KubeConfig } from '@kubernetes/client-node';
import { Writable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { catalogEntries, cronJobs, deployments, tenants } from '../../db/schema.js';
import {
  CRON_TIMEOUT_MAX_SECONDS,
  CRON_TIMEOUT_MIN_SECONDS,
  DEFAULT_CRON_TIMEOUT_SECONDS,
} from '@insula/api-contracts';
import { guardedFetch } from '../../shared/ssrf-guard.js';
import type { Database } from '../../db/index.js';

export type CronJobRow = typeof cronJobs.$inferSelect;

export interface CronRunResult {
  readonly status: 'success' | 'failed';
  /** HTTP status for webcron, process exit code for deployment. */
  readonly responseCode: number | null;
  readonly output: string | null;
  readonly durationMs: number;
  /** Where a deployment command ran — so a failure can be checked for a platform interruption. */
  readonly ranIn?: RanIn;
  /**
   * Set when the run failed because the platform could not reach its own
   * cluster API — not the tenant's failure. The detail is for the operator's
   * log; the tenant-visible output says it without addresses.
   */
  readonly platformFault?: string;
  /**
   * With platformFault: the command was certainly never sent — the failure
   * came before the request left (listing pods, or connecting for the exec).
   * Only then can a retry not run it twice. A connection reset during the
   * exec handshake is a platform fault too, but the API server may already
   * have started the command.
   */
  readonly notStarted?: boolean;
}

export interface RanIn {
  readonly namespace: string;
  /** The pod the command ran in; '' when it never got one (the deployment was not running). */
  readonly pod: string;
  /** The pod's node — or, for a run that never started, the tenant's pinned node. */
  readonly node: string | null;
}

export interface PodSummary {
  readonly name: string;
  readonly phase: string;
  readonly component: string | null;
  readonly containers: readonly string[];
  readonly nodeName?: string | null;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * The cluster seam. Both methods are injected in tests so the executor's
 * decisions — which pod, which container, what counts as failure — are testable
 * without a cluster.
 */
export interface ClusterTransport {
  listPods(namespace: string, labelSelector: string): Promise<readonly PodSummary[]>;
  exec(
    namespace: string,
    pod: string,
    container: string,
    command: readonly string[],
    timeoutMs: number,
  ): Promise<ExecResult>;
  /**
   * Why the platform stopped the pod a command ran in — or null when it did
   * not (or that cannot be told). See platformInterruption().
   */
  podDisruption?(ranIn: RanIn): Promise<string | null>;
}

export interface DisruptionPod {
  readonly metadata?: { readonly deletionTimestamp?: string | Date };
  readonly status?: {
    readonly phase?: string;
    readonly reason?: string;
    readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string; readonly reason?: string }>;
  };
}

/**
 * Pure: the platform's own marks on a pod it stopped — or null. A command
 * killed with its pod is not a failure of the command. On production
 * a node was powered off, its kubelet stopped every pod, Moodle's cron exited 1
 * mid-run, and the tenant was emailed that THEIR scheduled task had failed.
 */
export function podDisruptionReason(pod: DisruptionPod): string | null {
  const disruption = (pod.status?.conditions ?? []).find((c) => c.type === 'DisruptionTarget' && c.status === 'True');
  if (disruption?.reason === 'TerminationByKubelet' || pod.status?.reason === 'Terminated' || pod.status?.reason === 'NodeShutdown') {
    return 'the server it ran on was shutting down';
  }
  if (disruption) return `the platform stopped the pod it ran in (${disruption.reason ?? 'disruption'})`;
  if (pod.metadata?.deletionTimestamp) return 'the pod it ran in was being replaced';
  return null;
}

/**
 * Socket errors that mean no connection was made or kept — Node's own
 * (`connect ETIMEDOUT`) and undici's (fetch's connect timeout). Never an
 * answer from the API server: that was reached, and what it said stands.
 */
const CLUSTER_UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

/** Codes that only ever come from opening a connection: no request was sent. */
const CONNECT_ONLY_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

export interface ClusterUnreachable {
  readonly code: string;
  readonly message: string;
  /** The connection was never made (`syscall: 'connect'`, a lookup, a connect timeout). */
  readonly whileConnecting: boolean;
}

/**
 * The socket error behind `err` when it says the platform could not reach its
 * cluster API, or null. Walks the wrappers the libraries put around it: fetch's
 * "fetch failed" (`cause`) and the exec WebSocket's ErrorEvent (`error`).
 */
export function clusterUnreachable(err: unknown): ClusterUnreachable | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && typeof cur === 'object' && cur !== null; depth++) {
    const { code, message, syscall, cause, error } = cur as {
      code?: unknown; message?: unknown; syscall?: unknown; cause?: unknown; error?: unknown;
    };
    if (typeof code === 'string' && CLUSTER_UNREACHABLE_CODES.has(code)) {
      return {
        code,
        message: typeof message === 'string' && message !== '' ? message : code,
        whileConnecting: syscall === 'connect' || syscall === 'getaddrinfo' || CONNECT_ONLY_CODES.has(code),
      };
    }
    cur = cause ?? error;
  }
  return null;
}

/**
 * A run the platform could not start because it could not reach its cluster —
 * production, a server being shut down: `connect ETIMEDOUT` to the API, and
 * the tenant was emailed that THEIR task "did not run". `notStarted` says the
 * command was certainly never sent (see CronRunResult).
 */
function unreachableRun(found: ClusterUnreachable, notStarted: boolean) {
  return {
    status: 'failed' as const,
    responseCode: null,
    output: notStarted
      ? `Not run: the platform could not reach its cluster API (${found.code}). `
        + 'The command was not started — a platform problem, not a failure of this task.'
      : `Not confirmed: the platform lost its connection to its cluster API (${found.code}) while starting the command, `
        + 'so whether it started is unknown — a platform problem, not a failure of this task.',
    platformFault: `${notStarted ? 'could not reach' : 'lost its connection to'} the cluster API: ${found.message}`,
    notStarted,
  };
}

export interface CronExecutorDeps {
  readonly kubeconfigPath?: string;
  readonly timeoutMs?: number;
  readonly transport?: ClusterTransport;
  readonly fetchUrl?: typeof guardedFetch;
}

/** Output kept per run. The column is text, but the UI shows one cell. */
const MAX_OUTPUT_CHARS = 2000;

/**
 * How long ONE run may take, in milliseconds.
 *
 * Per job when it says so, per type otherwise. The two defaults are far apart
 * on purpose: a webcron ping that needs 30 seconds is broken, while Moodle's
 * `admin/cli/cron.php` took 182 s on a freshly installed site (measured on DEV)
 * and a course backup or search reindex takes longer still. A job that needs
 * more says so — the old hard-coded ceiling abandoned the run mid-flight and
 * recorded a failure while the process carried on inside the pod.
 */
export function runTimeoutMs(
  job: Pick<CronJobRow, 'type' | 'timeoutSeconds'>,
  override?: number,
): number {
  if (override !== undefined) return override;
  if (job.timeoutSeconds != null) {
    const clamped = Math.min(
      Math.max(job.timeoutSeconds, CRON_TIMEOUT_MIN_SECONDS),
      CRON_TIMEOUT_MAX_SECONDS,
    );
    return clamped * 1000;
  }
  const byType = job.type === 'deployment'
    ? DEFAULT_CRON_TIMEOUT_SECONDS.deployment
    : DEFAULT_CRON_TIMEOUT_SECONDS.webcron;
  return byType * 1000;
}

/** What clip() puts in front of output it shortened. */
const TRUNCATED_PREFIX = '…(truncated)\n';

export function clip(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
  // Keep the TAIL: a failing command says why on its last lines, and a
  // head-truncated log of a chatty cron is the part nobody needs.
  return `${TRUNCATED_PREFIX}${trimmed.slice(-MAX_OUTPUT_CHARS)}`;
}

/** How much of a run's output a failure notice carries. */
const NOTICE_OUTPUT_CHARS = 300;

/**
 * The end of a run's output, short enough for a notice. Pure.
 *
 * The notice used to take the first 200 characters of what clip() had kept —
 * the START of the last 2000 — so a long Moodle run was reported as
 * "exit 1: …Cron run completed correctly / Cron c", cut off before the lines
 * that said why it failed. Starts on a whole line when one begins in the
 * first half of the tail.
 */
export function outputTail(output: string): string {
  const shortened = output.startsWith(TRUNCATED_PREFIX);
  const text = (shortened ? output.slice(TRUNCATED_PREFIX.length) : output).trim();
  if (!shortened && text.length <= NOTICE_OUTPUT_CHARS) return text;
  const tail = text.slice(-NOTICE_OUTPUT_CHARS);
  const lineBreak = tail.indexOf('\n');
  const fromLine = lineBreak >= 0 && lineBreak < NOTICE_OUTPUT_CHARS / 2 ? tail.slice(lineBreak + 1) : tail;
  return `…${fromLine}`;
}

// ─── Kubernetes transport ────────────────────────────────────────────────────

function loadKubeConfig(kubeconfigPath?: string): KubeConfig {
  const kc = new KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return kc;
}

/**
 * Pull the process exit code out of the V1Status the exec channel returns.
 * A non-zero exit arrives as `reason: NonZeroExitCode` with the number in a
 * cause — without reading it, every command that fails looks identical to one
 * that succeeded.
 */
function exitCodeFromStatus(status: unknown): number {
  const s = (status ?? {}) as Record<string, unknown>;
  if (s.status === 'Success') return 0;

  const details = s.details as { causes?: Array<{ reason?: string; message?: string }> } | undefined;
  const cause = details?.causes?.find((c) => c.reason === 'ExitCode');
  const parsed = cause?.message !== undefined ? Number.parseInt(cause.message, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 1;
}

function k8sTransport(kubeconfigPath?: string): ClusterTransport {
  return {
    async listPods(namespace, labelSelector) {
      const { CoreV1Api } = await import('@kubernetes/client-node');
      const core = loadKubeConfig(kubeconfigPath).makeApiClient(CoreV1Api);
      const list = (await core.listNamespacedPod({ namespace, labelSelector })) as {
        items?: Array<{
          metadata?: { name?: string; labels?: Record<string, string> };
          status?: { phase?: string };
          spec?: { containers?: Array<{ name?: string }> };
        }>;
      };
      return (list.items ?? []).map((p) => ({
        name: p.metadata?.name ?? '',
        phase: p.status?.phase ?? 'Unknown',
        component: p.metadata?.labels?.component ?? null,
        containers: (p.spec?.containers ?? []).map((c) => c.name ?? '').filter(Boolean),
        nodeName: (p.spec as { nodeName?: string } | undefined)?.nodeName ?? null,
      }));
    },

    async podDisruption(ranIn) {
      const { CoreV1Api } = await import('@kubernetes/client-node');
      const core = loadKubeConfig(kubeconfigPath).makeApiClient(CoreV1Api);
      if (ranIn.pod) {
        try {
          const why = podDisruptionReason(await core.readNamespacedPod({ name: ranIn.pod, namespace: ranIn.namespace }) as DisruptionPod);
          if (why) return why;
        } catch (err) {
          const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
          // Gone already: it was stopped and removed. Anything else: cannot tell — report as usual.
          return code === 404 ? 'the pod it ran in was stopped and removed' : null;
        }
      }
      if (!ranIn.node) return null;
      try {
        const node = await core.readNode({ name: ranIn.node }) as { status?: { conditions?: Array<{ type?: string; status?: string }> } };
        const ready = (node.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
        if (ready) return null;
        return ranIn.pod ? `the server it ran on (${ranIn.node}) went down` : `the server it runs on (${ranIn.node}) is down`;
      } catch {
        return null;
      }
    },

    async exec(namespace, pod, container, command, timeoutMs) {
      const exec = new Exec(loadKubeConfig(kubeconfigPath));

      let stdout = '';
      let stderr = '';
      const sink = (append: (chunk: string) => void) =>
        new Writable({
          write(chunk: Buffer, _enc: string, cb: () => void) {
            append(chunk.toString());
            cb();
          },
        });
      const stdoutStream = sink((c) => { stdout += c; });
      const stderrStream = sink((c) => { stderr += c; });

      const exitCode = await new Promise<number>((resolve, reject) => {
        // The timeout stops US waiting; it does not reach into the container
        // and kill the process. A command that hangs keeps its pod busy until
        // the pod restarts — say so in the output rather than implying we
        // stopped it.
        const timer = setTimeout(() => {
          reject(new Error(`command did not finish within ${Math.round(timeoutMs / 1000)}s (it may still be running in the pod)`));
        }, timeoutMs);

        exec
          .exec(
            namespace,
            pod,
            container,
            [...command],
            stdoutStream,
            stderrStream,
            null,
            false,
            (status) => {
              clearTimeout(timer);
              resolve(exitCodeFromStatus(status));
            },
          )
          .catch((err: unknown) => {
            clearTimeout(timer);
            // @kubernetes/client-node surfaces WebSocket ErrorEvents that
            // serialise to `{}`; the text only survives on .message.
            // The event keeps the socket error, whose code says whether the
            // API was reached at all (clusterUnreachable).
            const msg = (err as { message?: string })?.message
              ?? (typeof err === 'string' ? err : 'exec failed');
            reject(err instanceof Error ? err : new Error(msg, { cause: err }));
          });
      });

      return { stdout, stderr, exitCode };
    },
  };
}

// ─── Deployment jobs ─────────────────────────────────────────────────────────

interface DeploymentTarget {
  readonly namespace: string;
  readonly deploymentName: string;
  readonly entryCode: string | null;
  readonly status: string;
  /** The tenant's pinned node, if any. */
  readonly tenantNode: string | null;
}

async function resolveDeployment(
  db: Database,
  job: CronJobRow,
): Promise<DeploymentTarget | { readonly error: string }> {
  if (!job.deploymentId) return { error: 'no deployment is attached to this cron job' };

  const [row] = await db
    .select({
      name: deployments.name,
      status: deployments.status,
      namespace: tenants.kubernetesNamespace,
      entryCode: catalogEntries.code,
      tenantNode: tenants.nodeName,
    })
    .from(deployments)
    .innerJoin(tenants, eq(deployments.tenantId, tenants.id))
    .leftJoin(catalogEntries, eq(deployments.catalogEntryId, catalogEntries.id))
    // Scoped by tenant as well as id: a cron job must never be able to name a
    // deployment belonging to somebody else, whatever id it carries.
    .where(and(eq(deployments.id, job.deploymentId), eq(deployments.tenantId, job.tenantId)));

  if (!row) return { error: 'the deployment this cron job points at no longer exists' };
  if (!row.namespace) return { error: 'the tenant has no Kubernetes namespace yet' };

  return {
    namespace: row.namespace,
    deploymentName: row.name,
    entryCode: row.entryCode ?? null,
    status: row.status,
    tenantNode: row.tenantNode ?? null,
  };
}

/**
 * Pick the pod to run in.
 *
 * The deployer labels pods `app=<deployment>` and `component=<component>`. A
 * single-component deployment has exactly one candidate. A multi-component one
 * — an application that inlines its own database, say — has several, and
 * running a tenant's command in whichever pod the API happened to list first
 * is how "Moodle cron" ends up executing inside MariaDB. Single-component
 * deployments label the component with the catalog entry code, so that is the
 * tie-break; when it does not resolve, this refuses and names the candidates
 * instead of guessing.
 */
export function selectPod(
  pods: readonly PodSummary[],
  entryCode: string | null,
): { readonly pod: PodSummary } | { readonly error: string } {
  const running = pods.filter((p) => p.phase === 'Running' && p.name !== '');
  if (running.length === 0) {
    return { error: 'no running pod for this deployment — start it before the cron job can run' };
  }
  if (running.length === 1) return { pod: running[0] };

  if (entryCode) {
    const byComponent = running.filter((p) => p.component === entryCode);
    if (byComponent.length === 1) return { pod: byComponent[0] };
  }

  return {
    error:
      `this deployment has ${running.length} running pods (${running.map((p) => p.name).join(', ')}) ` +
      'and none is unambiguously the application container — cannot choose where to run the command',
  };
}

/** Prefer the container that carries the workload over any sidecar. */
export function selectContainer(pod: PodSummary, entryCode: string | null): string {
  if (pod.containers.length <= 1) return pod.containers[0] ?? '';
  const named = entryCode ? pod.containers.find((c) => c === entryCode) : undefined;
  return named ?? pod.containers[0];
}

async function runDeploymentJob(
  db: Database,
  job: CronJobRow,
  deps: CronExecutorDeps,
): Promise<{ status: 'success' | 'failed'; responseCode: number | null; output: string | null; ranIn?: RanIn; platformFault?: string; notStarted?: boolean }> {
  if (!job.command || job.command.trim() === '') {
    return { status: 'failed', responseCode: null, output: 'no command configured for this cron job' };
  }

  const target = await resolveDeployment(db, job);
  if ('error' in target) return { status: 'failed', responseCode: null, output: target.error };
  // A run that never got a pod: checked against the tenant's pinned node,
  // which is down when the platform is the reason (production: the server
  // was powered off, the deployment showed failed, and the client was told
  // THEIR task had failed).
  const notStarted: RanIn = { namespace: target.namespace, pod: '', node: target.tenantNode };
  if (target.status !== 'running') {
    return {
      status: 'failed',
      responseCode: null,
      output: `the deployment is ${target.status}, not running — the command was not executed`,
      ranIn: notStarted,
    };
  }

  const transport = deps.transport ?? k8sTransport(deps.kubeconfigPath);
  const timeoutMs = runTimeoutMs(job, deps.timeoutMs);

  let pods: readonly PodSummary[];
  try {
    pods = await transport.listPods(target.namespace, `app=${target.deploymentName}`);
  } catch (err) {
    // Listing pods comes before the exec: whatever broke, nothing was sent.
    const unreachable = clusterUnreachable(err);
    if (unreachable) return unreachableRun(unreachable, true);
    return {
      status: 'failed',
      responseCode: null,
      output: `could not list pods for this deployment: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const chosen = selectPod(pods, target.entryCode);
  if ('error' in chosen) return { status: 'failed', responseCode: null, output: chosen.error, ranIn: notStarted };

  const container = selectContainer(chosen.pod, target.entryCode);
  const ranIn: RanIn = { namespace: target.namespace, pod: chosen.pod.name, node: chosen.pod.nodeName ?? null };

  try {
    const result = await transport.exec(
      target.namespace,
      chosen.pod.name,
      container,
      // `sh -c` so the tenant can write what they would write in crontab —
      // pipes, redirects, `&&`. The command runs with the container's own user
      // and filesystem; it is their container.
      ['/bin/sh', '-c', job.command],
      timeoutMs,
    );
    const combined = [result.stdout, result.stderr].filter((s) => s.trim() !== '').join('\n');
    return {
      status: result.exitCode === 0 ? 'success' : 'failed',
      responseCode: result.exitCode,
      output: clip(combined) ?? (result.exitCode === 0 ? 'command completed with no output' : `command exited ${result.exitCode}`),
      ranIn,
    };
  } catch (err) {
    // The exec rejects only before its connection opens (client-node's
    // WebSocketHandler.connect). The command travels in the upgrade request:
    // it was certainly not sent only if the connection was never made.
    const unreachable = clusterUnreachable(err);
    if (unreachable) return unreachableRun(unreachable, unreachable.whileConnecting);
    return {
      status: 'failed',
      responseCode: null,
      output: clip(err instanceof Error ? err.message : String(err)) ?? 'command execution failed',
      ranIn,
    };
  }
}

/**
 * Was this failed run cut short by the platform rather than by the command?
 * Null when not, when the transport cannot tell, or when the check fails —
 * then the failure is reported as usual.
 */
export async function platformInterruption(
  ranIn: RanIn,
  deps: Pick<CronExecutorDeps, 'kubeconfigPath' | 'transport'> = {},
): Promise<string | null> {
  const transport = deps.transport ?? k8sTransport(deps.kubeconfigPath);
  if (!transport.podDisruption) return null;
  try {
    return await transport.podDisruption(ranIn);
  } catch {
    return null;
  }
}

// ─── Webcron jobs ────────────────────────────────────────────────────────────

async function runWebcronJob(
  job: CronJobRow,
  deps: CronExecutorDeps,
): Promise<{ status: 'success' | 'failed'; responseCode: number | null; output: string | null }> {
  if (!job.url) {
    return { status: 'failed', responseCode: null, output: 'no URL configured for this cron job' };
  }

  const fetchUrl = deps.fetchUrl ?? guardedFetch;
  try {
    // SSRF guard: the URL is tenant-controlled and this request leaves from the
    // broadly-connected platform-api pod, so internal and metadata destinations
    // are refused at connect time (rebind-safe).
    const res = await fetchUrl(job.url, {
      method: (job.httpMethod as string) ?? 'GET',
      timeoutMs: runTimeoutMs(job, deps.timeoutMs),
      maxBytes: 8 * 1024,
      headers: { 'User-Agent': 'K8s-Hosting-Webcron/1.0' },
    });
    return {
      status: res.status >= 200 && res.status < 300 ? 'success' : 'failed',
      responseCode: res.status,
      output: clip(res.body),
    };
  } catch (err) {
    return {
      status: 'failed',
      responseCode: null,
      output: clip(err instanceof Error ? err.message : 'Request failed') ?? 'Request failed',
    };
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Execute a job. Never throws — a run that could not happen is a failed run. */
export async function executeCronJob(
  db: Database,
  job: CronJobRow,
  deps: CronExecutorDeps = {},
): Promise<CronRunResult> {
  const startedAt = Date.now();

  const outcome =
    job.type === 'deployment'
      ? await runDeploymentJob(db, job, deps)
      : await runWebcronJob(job, deps);

  return { ...outcome, durationMs: Date.now() - startedAt };
}

/** Human-readable failure reason for a notification. */
export function describeFailure(result: CronRunResult, type: string): string {
  const prefix = type === 'deployment'
    ? (result.responseCode !== null ? `exit ${result.responseCode}` : 'did not run')
    : (result.responseCode !== null ? `HTTP ${result.responseCode}` : 'request failed');
  const detail = result.output ? `: ${outputTail(result.output)}` : '';
  return `${prefix}${detail}`;
}
