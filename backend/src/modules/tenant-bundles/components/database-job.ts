/**
 * What the per-database backup and restore Jobs share
 * (database-snapshots.ts, backup-restore/executors/database-snapshot-restore.ts):
 * their secrets, the restic environment, where they run, waiting for them and
 * reading their results.
 */
import { randomBytes } from 'node:crypto';
import type { Database } from '../../../db/index.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { DbManagerContext } from '../../deployments/db-manager.js';
import { readJobToleratingEarlyAbsence, type JobReader } from '../../../shared/k8s-job-wait.js';
import { readJobLogTail } from '../../storage-lifecycle/job-log-tail.js';
import { loadTenantPodPlacement, platformPodPlacement } from '../../tenant-placement/pod-placement.js';
import { wireSecretOwnerRef } from './files.js';

export const CREDS_MOUNT_PATH = '/var/run/restic-creds';
export const LOGIN_MOUNT_PATH = '/var/run/db-login';
/** A database Job's ceiling; a database too big for it fails visibly rather than hanging the run. */
export const JOB_DEADLINE_SECONDS = 6 * 60 * 60;

/** Every container: no privilege, nothing written outside its volumes. */
export const NARROW_CONTAINER = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
/** The database images' own unprivileged user; the secrets are readable through the group. */
export const UNPRIVILEGED_POD = { runAsNonRoot: true, runAsUser: 999, runAsGroup: 999, fsGroup: 999 };

/** Exports the restic repository and its credentials from the mounted secret. */
export const RESTIC_ENV_SH = [
  `C=${CREDS_MOUNT_PATH}`,
  'export RESTIC_PASSWORD="$(cat $C/restic_password)"',
  '[ -n "$RESTIC_PASSWORD" ] || { printf "DB_SETUP_FAILED nonce=%s restic password missing\\n" "$NONCE"; exit 1; }',
  'export RESTIC_REPOSITORY="$(cat $C/repo_uri)"',
  'if [ -f $C/aws_access_key_id ]; then export AWS_ACCESS_KEY_ID="$(cat $C/aws_access_key_id)"; fi',
  'if [ -f $C/aws_secret_access_key ]; then export AWS_SECRET_ACCESS_KEY="$(cat $C/aws_secret_access_key)"; fi',
  'if [ -f $C/aws_region ]; then export AWS_DEFAULT_REGION="$(cat $C/aws_region)"; fi',
].join('\n');

/** Clears what a program the restic environment starts must not hold. */
export const WITHOUT_RESTIC_ENV = 'env -u RESTIC_PASSWORD -u RESTIC_REPOSITORY -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_DEFAULT_REGION -u NONCE';

/**
 * Makes an error line printable on one result line: no newline, nothing
 * unprintable, at most 400 characters. A shell fragment reading `$why`.
 */
export const ONE_LINE_WHY = `$(printf '%s' "$why" | tr '\\n' ' ' | tr -c '[:print:]' ' ' | cut -c1-400)`;

/** A run's result lines carry it, so text in a database's output cannot pass for one. */
export function newRunNonce(): string {
  return randomBytes(8).toString('hex');
}

/**
 * The backup store's address has no place in a message a tenant reads: the
 * repository, its URL, host, path, and any network address an error names.
 */
export function redactRepository(text: string, repoUri: string | undefined): string {
  const parts = new Set<string>();
  if (repoUri) {
    parts.add(repoUri);
    const url = /^[a-z0-9]+:(.*)$/i.exec(repoUri)?.[1] ?? repoUri;
    try {
      const u = new URL(url);
      parts.add(u.origin);
      parts.add(u.host);
      if (u.hostname) parts.add(u.hostname);
      const path = u.pathname.replace(/^\/+|\/+$/g, '');
      if (path) { parts.add(path); parts.add(`/${path}`); }
    } catch { /* not a URL: the whole string is enough */ }
  }
  let out = text;
  for (const p of [...parts].filter((p) => p.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(p).join('<backup store>');
  return out
    .replace(/\b(s3|rest|sftp|swift|b2|azure|gs|rclone):\S+/g, '<backup store>')
    .replace(/\bhttps?:\/\/\S+/g, '<backup store>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<address>')
    // What followed a redacted address (a bucket, a key) goes with it.
    .replace(/<backup store>[^\s"':]*/g, '<backup store>');
}

/** Where the Job runs and at which priority: the tenant's node, outside the tenant's quota. */
export async function databaseJobPlacement(db: Database, tenantId: string, k8s: K8sClients): Promise<Record<string, unknown>> {
  return platformPodPlacement(await loadTenantPodPlacement(db, tenantId, k8s)) as unknown as Record<string, unknown>;
}

export interface RunSecret {
  readonly name: string;
  readonly data: Readonly<Record<string, string>>;
}

/**
 * Creates the secrets, the Job, and hands the secrets to the Job (a Job that
 * goes takes them along, even when the API stops before its own clean-up),
 * then waits for it and returns the named container's log. The caller deletes
 * the secrets when it is done. Throws when the Job cannot be created or never
 * finishes.
 */
export async function runDatabaseJob(args: {
  readonly k8s: K8sClients;
  readonly namespace: string;
  readonly jobName: string;
  readonly spec: Record<string, unknown>;
  readonly secrets: readonly RunSecret[];
  readonly labels: Readonly<Record<string, string>>;
  readonly container: string;
  readonly tailLines: number;
}): Promise<{ readonly outcome: 'complete' | 'failed'; readonly log: string }> {
  for (const s of args.secrets) {
    // backup-coverage: excluded:transient-job-credentials
    await args.k8s.core.createNamespacedSecret({
      namespace: args.namespace,
      body: { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name: s.name, namespace: args.namespace, labels: { ...args.labels } }, stringData: { ...s.data } },
    } as never);
  }
  const createdAt = Date.now();
  const created = await (args.k8s.batch as unknown as { createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<{ metadata?: { uid?: string } } | undefined> })
    .createNamespacedJob({ namespace: args.namespace, body: args.spec });
  const uid = created?.metadata?.uid;
  if (uid) {
    for (const s of args.secrets) await wireSecretOwnerRef(args.k8s, args.namespace, s.name, args.jobName, uid).catch(() => undefined);
  }
  const outcome = await waitForJob(args.k8s, args.namespace, args.jobName, createdAt, (JOB_DEADLINE_SECONDS + 600) * 1000);
  const log = (await readJobLogTail(args.k8s, args.namespace, args.jobName, { tailLines: args.tailLines, container: args.container })) ?? '';
  return { outcome, log };
}

/** Waits for the Job to finish (either way); throws only when it never shows up or runs past its deadline. */
export async function waitForJob(k8s: K8sClients, namespace: string, jobName: string, createdAtMs: number, timeoutMs: number): Promise<'complete' | 'failed'> {
  const start = Date.now();
  for (;;) {
    const job = await readJobToleratingEarlyAbsence(k8s.batch as unknown as JobReader, jobName, namespace, createdAtMs);
    if (job) {
      const conditions = job.status?.conditions ?? [];
      if (conditions.some((c) => c.type === 'Complete' && c.status === 'True') || (job.status?.succeeded ?? 0) > 0) return 'complete';
      if (conditions.some((c) => c.type === 'Failed' && c.status === 'True') || (job.status?.failed ?? 0) > 0) return 'failed';
    }
    if (Date.now() - start > timeoutMs) throw new Error(`the database Job ${jobName} did not finish in ${Math.round(timeoutMs / 60000)} minutes`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/** The image the instance's database container runs — by digest when the pod reports one. */
export async function databaseImage(k8s: K8sClients, ctx: DbManagerContext): Promise<string> {
  const pod = await k8s.core.readNamespacedPod({ name: ctx.podName, namespace: ctx.namespace }) as {
    spec?: { containers?: Array<{ name?: string; image?: string }> };
    status?: { containerStatuses?: Array<{ name?: string; imageID?: string }> };
  };
  const spec = pod.spec?.containers?.find((c) => c.name === ctx.containerName)?.image;
  const id = pod.status?.containerStatuses?.find((c) => c.name === ctx.containerName)?.imageID ?? '';
  const digest = /^(?:docker-pullable:\/\/)?(.+@sha256:[0-9a-f]{64})$/.exec(id)?.[1];
  if (digest) return digest;
  if (!spec) throw new Error('the database container has no image');
  return spec;
}

/** The Service in front of the instance's database pod (its selector matches the pod's labels). */
export async function databaseServiceHost(k8s: K8sClients, ctx: DbManagerContext): Promise<string> {
  const pod = await k8s.core.readNamespacedPod({ name: ctx.podName, namespace: ctx.namespace }) as { metadata?: { labels?: Record<string, string> } };
  const labels = pod.metadata?.labels ?? {};
  const services = await k8s.core.listNamespacedService({ namespace: ctx.namespace }) as { items?: Array<{ metadata?: { name?: string }; spec?: { selector?: Record<string, string> } }> };
  const match = (services.items ?? []).find((s) => {
    const sel = s.spec?.selector ?? {};
    return Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels[k] === v);
  });
  if (!match?.metadata?.name) throw new Error('the database has no Service to connect to');
  return `${match.metadata.name}.${ctx.namespace}.svc`;
}

export async function deleteSecret(k8s: K8sClients, namespace: string, name: string): Promise<void> {
  try {
    await k8s.core.deleteNamespacedSecret({ name, namespace });
  } catch (err) {
    // Gone already, or taken along with its Job: fine. Anything else leaves
    // the run's restic or database credentials behind, so it is said.
    const e = err as { code?: unknown; statusCode?: unknown; message?: unknown };
    if (e.code === 404 || e.statusCode === 404) return;
    console.warn(`[databases] the run's Secret ${namespace}/${name} could not be deleted: ${String(e.message ?? err)}`);
  }
}
