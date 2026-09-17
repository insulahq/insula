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
}

export interface PodSummary {
  readonly name: string;
  readonly phase: string;
  readonly component: string | null;
  readonly containers: readonly string[];
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

function clip(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
  // Keep the TAIL: a failing command says why on its last lines, and a
  // head-truncated log of a chatty cron is the part nobody needs.
  return `…(truncated)\n${trimmed.slice(-MAX_OUTPUT_CHARS)}`;
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
      }));
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
            const msg = (err as { message?: string })?.message
              ?? (typeof err === 'string' ? err : 'exec failed');
            reject(err instanceof Error ? err : new Error(msg));
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
): Promise<{ status: 'success' | 'failed'; responseCode: number | null; output: string | null }> {
  if (!job.command || job.command.trim() === '') {
    return { status: 'failed', responseCode: null, output: 'no command configured for this cron job' };
  }

  const target = await resolveDeployment(db, job);
  if ('error' in target) return { status: 'failed', responseCode: null, output: target.error };
  if (target.status !== 'running') {
    return {
      status: 'failed',
      responseCode: null,
      output: `the deployment is ${target.status}, not running — the command was not executed`,
    };
  }

  const transport = deps.transport ?? k8sTransport(deps.kubeconfigPath);
  const timeoutMs = runTimeoutMs(job, deps.timeoutMs);

  let pods: readonly PodSummary[];
  try {
    pods = await transport.listPods(target.namespace, `app=${target.deploymentName}`);
  } catch (err) {
    return {
      status: 'failed',
      responseCode: null,
      output: `could not list pods for this deployment: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const chosen = selectPod(pods, target.entryCode);
  if ('error' in chosen) return { status: 'failed', responseCode: null, output: chosen.error };

  const container = selectContainer(chosen.pod, target.entryCode);

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
    };
  } catch (err) {
    return {
      status: 'failed',
      responseCode: null,
      output: clip(err instanceof Error ? err.message : String(err)) ?? 'command execution failed',
    };
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
  const detail = result.output ? `: ${result.output.slice(0, 200)}` : '';
  return `${prefix}${detail}`;
}
