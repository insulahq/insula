/**
 * Apply the mail-snapshot retention NOW, when the operator changes it.
 *
 * The snapshot Job forgets on every run (snapshot-upload.sh), so a new limit
 * used to wait for the next snapshot — and on a cluster that snapshots daily,
 * a day. This runs the Job's own forget passes from platform-api, with the
 * same restic flags (`runResticForgetByPolicy`), against the repo the Job
 * writes (read from the Secret the Job mounts, as the daily prune does). When
 * the forget removed anything it prunes straight away, so the space comes back
 * now rather than in the next daily slot.
 *
 * Raising a limit needs no work here: nothing is forgotten, and the Job keeps
 * more from its next run on.
 *
 * The same gates as the prune, before anything touches the repo: a bound mail
 * target, a WRITABLE one (a DR-restored cluster must never forget snapshots in
 * the repo it restored from), and a repo behind the in-cluster shim.
 */
import type { Logger } from 'pino';
import type * as k8s from '@kubernetes/client-node';
import type { Database } from '../../db/index.js';
import { TargetFrozenError } from '../backup-config/writable-guard.js';
import { SHIM_S3_ENDPOINT_URL, MAIL_SHIM_BUCKET } from '../backup-rclone-shim/mail-restic.js';
import type { RetentionPolicy } from '../backup-schedules/retention-policy.js';
import type {
  ListResticSnapshotsArgs,
  ResticSnapshotMeta,
  RunResticForgetByPolicyArgs,
} from '../tenant-bundles/restic-driver.js';
import type { MailPruneResult, RepoEnv } from './snapshot-prune.js';

/** The tag every mail snapshot carries (snapshot-upload.sh `--tag`). */
export const MAIL_SNAPSHOT_TAG = 'stalwart-snapshot';
/** The Job holds the repo lock for a snapshot run; wait it out rather than fail. */
const FORGET_RETRY_LOCK = '5m';
const FORGET_TIMEOUT_MS = 15 * 60 * 1000;

export type MailRetentionNowResult =
  | { readonly outcome: 'applied'; readonly before: number; readonly after: number; readonly prune: MailPruneResult | null }
  | { readonly outcome: 'skipped'; readonly reason: 'no-target' | 'frozen' | 'unsupported-repo' | 'incomplete-credentials' };

export interface MailRetentionNowDeps {
  readonly loadPolicy: () => Promise<RetentionPolicy>;
  readonly findMailTargetId: () => Promise<string | null>;
  /** Throws TargetFrozenError for a read-only target. */
  readonly requireWritable: (targetId: string) => Promise<unknown>;
  readonly readRepoEnv: () => Promise<RepoEnv | null>;
  readonly listSnapshots: (args: ListResticSnapshotsArgs) => Promise<ResticSnapshotMeta[]>;
  readonly forget: (args: RunResticForgetByPolicyArgs) => Promise<void>;
  readonly pruneNow: () => Promise<MailPruneResult>;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export async function applyMailRetentionNow(deps: MailRetentionNowDeps): Promise<MailRetentionNowResult> {
  const targetId = await deps.findMailTargetId();
  if (!targetId) return { outcome: 'skipped', reason: 'no-target' };
  try {
    await deps.requireWritable(targetId);
  } catch (err) {
    if (err instanceof TargetFrozenError) return { outcome: 'skipped', reason: 'frozen' };
    throw err;
  }

  const env = await deps.readRepoEnv();
  const repoUri = env?.RESTIC_REPOSITORY ?? '';
  if (!repoUri) return { outcome: 'skipped', reason: 'no-target' };
  if (!repoUri.startsWith(`s3:${SHIM_S3_ENDPOINT_URL}/`)) return { outcome: 'skipped', reason: 'unsupported-repo' };
  const passwordHex = env?.RESTIC_PASSWORD ?? '';
  const accessKey = env?.AWS_ACCESS_KEY_ID ?? '';
  const secretKey = env?.AWS_SECRET_ACCESS_KEY ?? '';
  if (!passwordHex || !accessKey || !secretKey) return { outcome: 'skipped', reason: 'incomplete-credentials' };

  const target = { kind: 'shim' as const, endpoint: SHIM_S3_ENDPOINT_URL, bucket: MAIL_SHIM_BUCKET, accessKey, secretKey };
  const policy = await deps.loadPolicy();
  const count = async (): Promise<number> => (await deps.listSnapshots({
    target, passwordHex, repoUri, readOnly: true, tagFilters: [MAIL_SNAPSHOT_TAG],
  })).length;

  const before = await count();
  await deps.forget({
    target,
    passwordHex,
    repoUri,
    keepWithinDays: policy.days,
    keepLast: policy.count,
    tag: MAIL_SNAPSHOT_TAG,
    retryLock: FORGET_RETRY_LOCK,
    timeoutMs: FORGET_TIMEOUT_MS,
    log: deps.log,
  });
  const after = await count();
  deps.log.info({ before, after, days: policy.days, count: policy.count }, 'mail-snapshot retention: applied the new limits now');

  // Nothing forgotten → nothing to reclaim; a prune would only re-read the repo.
  const prune = after < before ? await deps.pruneNow() : null;
  return { outcome: 'applied', before, after, prune };
}

/** Real dependencies. Imported lazily by the schedule route, like the CronJob patch. */
export async function createMailRetentionNowDeps(
  db: Database,
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<MailRetentionNowDeps> {
  const [{ loadRetention }, prune, writable, driver] = await Promise.all([
    import('../backup-schedules/retention-policy.js'),
    import('./snapshot-prune.js'),
    import('../backup-config/writable-guard.js'),
    import('../tenant-bundles/restic-driver.js'),
  ]);
  const pruneDeps = prune.createMailSnapshotPruneDeps(db, core, log);
  return {
    loadPolicy: () => loadRetention(db, 'mail'),
    findMailTargetId: () => prune.findMailTargetId(db),
    requireWritable: (targetId) => writable.requireWritableTarget(db, targetId),
    readRepoEnv: () => prune.readRepoEnv(core),
    listSnapshots: driver.listResticSnapshots,
    forget: driver.runResticForgetByPolicy,
    pruneNow: () => prune.pruneMailSnapshotsNow(pruneDeps),
    log,
  };
}
