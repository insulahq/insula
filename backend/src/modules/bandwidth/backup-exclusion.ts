/**
 * Keep platform-scheduled backup traffic out of the tenant's bandwidth meter.
 *
 * A tenant's files backup runs as a Job IN THE TENANT'S OWN NAMESPACE, so
 * `container_network_transmit_bytes_total{namespace="tenant-…"}` counts the
 * bytes it ships to off-site storage exactly like the bytes a visitor
 * downloads. The meter's query filters on `namespace` alone, so until now the
 * tenant was billed for a backup the platform scheduled on their behalf —
 * measured on production, that was 78% and 80% of the two busiest tenants'
 * recorded egress in a single day.
 *
 * Only a backup the TENANT asked for is theirs to pay for. `backup_jobs`
 * already records that in `initiator` ('tenant' | 'admin' | 'system' |
 * 'cluster'), so nothing new has to be collected — the bytes just have to be
 * attributed to the row that explains them.
 *
 * ── Why the join is on the Job name and not on a name pattern ──────────────
 * cAdvisor labels carry `namespace`, `pod` and `interface` — no pod LABELS, so
 * "is this pod a platform backup?" cannot be asked of the metric directly. The
 * obvious shortcut, excluding every pod matching /^bk-/, would hand any tenant
 * a way to stop paying for traffic: name a deployment `bk-files-anything` and
 * its egress vanishes from the meter.
 *
 * So the direction is reversed. Rather than parse a pod name and hope it
 * denotes a backup, this derives the exact Job name the platform WOULD have
 * created for each non-tenant-initiated backup (`bk-files-<id>`, the same
 * expression `components/files.ts` uses) and excludes only pods that are that
 * Job's pod, in that job's own tenant's namespace. Three things must line up:
 *
 *   1. the pod is `<jobName>-<5 chars>` — the shape Kubernetes gives a Job's
 *      pod;
 *   2. that Job name belongs to a real `backup_jobs` row whose initiator is
 *      not 'tenant';
 *   3. that row's tenant is the tenant whose namespace the pod ran in — so one
 *      tenant cannot borrow another's backup id.
 *
 * Condition 1 is NOT self-enforcing, and it is worth being precise about why.
 * A Deployment's pod carries a ReplicaSet hash as well
 * (`<name>-<9-10 chars>-<5 chars>`), so it cannot take the Job-pod shape — but
 * a tenant is not limited to Deployments. A single-component catalog entry of
 * type `job` takes the tenant's chosen deployment name VERBATIM as its Job
 * name (`deployments/k8s-deployer.ts:k8sResourceName`), and its pod is then
 * shaped exactly like this. Condition 3 does not help there either: the
 * attacker would be reusing one of their OWN past backup ids, so the job row
 * really is theirs.
 *
 * What closes it is that `bk-files-` and `bk-mbox-` are RESERVED from every
 * tenant-chosen workload name (`@insula/api-contracts`
 * `reserved-workload-names.ts`), so a tenant cannot mint the name in the first
 * place. That reservation is load-bearing for billing integrity, not cosmetic:
 * `backup-exclusion.test.ts` asserts every Job name this module trusts starts
 * with a reserved prefix, so adding a platform Job prefix without reserving it
 * fails the build.
 *
 * Anything unrecognised is COUNTED, never excluded. An unknown pod is either a
 * tenant's own workload or something new, and the failure that over-bills by a
 * few megabytes is visible and refundable, where the one that under-bills is
 * neither.
 */

import { and, inArray, isNull, lte, or, gte, ne, sql } from 'drizzle-orm';
import { backupJobs } from '../../db/schema.js';
import { queryInstant } from '../monitoring/vm-client.js';
import type { Database } from '../../db/index.js';

/** Kubernetes truncates a Job name at 63 characters; `components/files.ts`
 *  slices to the same bound, so the expected name must be built identically. */
const K8S_NAME_MAX = 63;

/** A Job's pod is `<job-name>-<5 lowercase alphanumerics>`. */
const JOB_POD_SUFFIX_RE = /^(.+)-[a-z0-9]{5}$/;

/**
 * Scrapes land after the Job has finished, so a backup that ended just before
 * the window opened can still contribute bytes inside it.
 */
const OVERLAP_SLACK_MS = 15 * 60 * 1000;

/** The Job name `components/files.ts` gives a tenant files backup. */
export function filesJobName(backupId: string): string {
  return `bk-files-${backupId}`.slice(0, K8S_NAME_MAX);
}

/** The Job name `components/mailboxes.ts` gives a mailbox backup. Included for
 *  completeness — that Job runs in the MAIL namespace, which is not a tenant
 *  namespace and so never reaches a tenant's meter. */
export function mailboxJobName(backupId: string): string {
  return `bk-mbox-${backupId}`.slice(0, K8S_NAME_MAX);
}

/** `bk-files-<id>-abcde` → `bk-files-<id>`; anything else → null. */
export function jobNameFromPod(pod: string): string | null {
  const m = JOB_POD_SUFFIX_RE.exec(pod);
  return m ? m[1] : null;
}

export interface ExclusionLogger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

export interface NamespaceOwner {
  readonly tenantId: string;
  readonly namespace: string;
}

/**
 * Bytes to subtract per namespace for the window `[now - gapS, now]`.
 *
 * Throws if the metrics query fails — the caller must then skip the whole
 * tick rather than bill the unexcluded total, exactly as it already does when
 * the main query fails. Leaving `lastRun` unadvanced makes the next tick's
 * wider window recover the bytes.
 */
export async function platformBackupBytesByNamespace(
  db: Database,
  owners: readonly NamespaceOwner[],
  gapS: number,
  now: Date,
  logger: ExclusionLogger = {},
): Promise<Map<string, number>> {
  const excluded = new Map<string, number>();
  if (owners.length === 0) return excluded;

  // Which backups could have been running in this window, and were not the
  // tenant's own doing. Every current write path stamps `started_at` in the
  // same insert that creates the row, so the `created_at` fallback is only
  // defensive — it is not covering a real null today.
  const windowStart = new Date(now.getTime() - gapS * 1000 - OVERLAP_SLACK_MS);
  const jobs = await db
    .select({ id: backupJobs.id, tenantId: backupJobs.tenantId, initiator: backupJobs.initiator })
    .from(backupJobs)
    .where(and(
      ne(backupJobs.initiator, 'tenant'),
      lte(sql`COALESCE(${backupJobs.startedAt}, ${backupJobs.createdAt})`, now),
      or(isNull(backupJobs.finishedAt), gte(backupJobs.finishedAt, windowStart)),
      inArray(backupJobs.tenantId, owners.map((o) => o.tenantId)),
    ));
  if (jobs.length === 0) return excluded;

  // Job name → the tenant that backup belongs to. Both component Jobs are
  // registered: the files Job is the one that runs in a tenant namespace, and
  // naming the mailbox Job too costs nothing and documents the pair.
  //
  // `null` marks an AMBIGUOUS name. `backup_jobs.id` is varchar(64), so two
  // sufficiently long ids can truncate to the same 63-character Job name; if
  // they belong to different tenants, the name no longer identifies an owner
  // and nothing may be excluded on it. Today's ids are ~40 characters and
  // cannot collide — this keeps that from being load-bearing.
  const ownerOfJob = new Map<string, string | null>();
  const claim = (name: string, tenantId: string): void => {
    const prior = ownerOfJob.get(name);
    ownerOfJob.set(name, prior === undefined || prior === tenantId ? tenantId : null);
  };
  for (const j of jobs) {
    claim(filesJobName(j.id), j.tenantId);
    claim(mailboxJobName(j.id), j.tenantId);
  }
  const tenantOfNamespace = new Map(owners.map((o) => [o.namespace, o.tenantId]));

  // Only backup-shaped pods are fetched, so this adds a handful of series to
  // the tick rather than one per pod in the cluster.
  const samples = await queryInstant(
    `sum by (namespace, pod) (increase(container_network_transmit_bytes_total{pod=~"bk-.+"}[${gapS}s]))`,
  );

  let matched = 0;
  for (const s of samples) {
    const namespace = s.labels.namespace ?? '';
    const pod = s.labels.pod ?? '';
    const bytes = s.value;
    if (!namespace || !pod || !Number.isFinite(bytes) || bytes <= 0) continue;

    const jobName = jobNameFromPod(pod);
    if (!jobName) continue;
    const owner = ownerOfJob.get(jobName);
    // Unknown job, or a job belonging to somebody else: this is not a platform
    // backup of THIS tenant, so the tenant keeps paying for it.
    if (!owner || owner !== tenantOfNamespace.get(namespace)) continue;

    excluded.set(namespace, (excluded.get(namespace) ?? 0) + bytes);
    matched += 1;
  }

  if (matched > 0) {
    logger.info?.(
      { pods: matched, namespaces: excluded.size },
      'bandwidth-meter: excluding platform-scheduled backup egress',
    );
  }
  return excluded;
}
