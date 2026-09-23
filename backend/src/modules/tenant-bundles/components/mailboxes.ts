/**
 * `mailboxes` component capture(Phase 2 rewrite,, ADR-047).
 *
 * Replaces the mbsync-based capture path with a JMAP-driven flow. Per
 * tenant tenant:
 *
 *   1. Resolve every mailbox address belonging to the tenant from the
 *      platform DB.
 *   2. Look up any prior `tenant_jmap_state.last_jmap_state` per
 *      (tenant_id, mailbox_address) — feeds incremental Email/changes.
 *   3. Sign ONE HMAC upload token bound to (bundleId, 'mailboxes',
 *      'restic-stream') for the entire tenant's Maildir tarball.
 *   4. Spawn one Job in the `mail` namespace using the
 *      `tenant-backup-tools` image. The Job loops every address and runs
 *      `jmap-sync.py` for each:
 *         a. Reads optional state-in file with prior Email/changes state.
 *         b. Authenticates against the Stalwart JMAP endpoint as
 *            `<addr>%<masterFQ>` (master-user proxy auth — same as the
 *            old mbsync path; one Secret to manage).
 *         c. Pulls created/updated message bodies via Email/get +
 *            Blob/get, writes them into a Maildir-shaped tree at
 *            /tmp/maildir-out/<addr>/<mailbox>/cur/<unix>.<unique>:2,<flags>.
 *         d. Emits a single-line JSON summary on stdout with the new
 *            state token (orchestrator reads from Job log).
 *      After every address finishes, the Job tars /tmp/maildir-out and
 *      streams it to platform-api's restic-stream endpoint — one
 *      snapshot per backup, NOT one per mailbox. Matches the files
 *      component model exactly.
 *
 *   5. Orchestrator parses Job log for JMAP_DONE lines, persists new
 *      state per (tenant_id, mailbox_jmap_id) AFTER the restic snapshot
 *      is acked. At-least-once: if persistence fails the next run does
 *      a no-op delta (same state token); restic content-dedups.
 *
 * Why JMAP and not IMAP:
 *   - Stalwart 0.16's IMAP MAY return less data than JMAP (some flags +
 *     keywords don't round-trip cleanly via IMAP STORE).
 *   - Email/changes is a server-side delta primitive; mbsync had to
 *     compare UIDVALIDITY + UID per-folder tenant-side.
 *   - Mailbox renames are stable via Mailbox/changes; IMAP doesn't have
 *     a server-side rename primitive.
 *
 * Auth pattern unchanged from the mbsync era — master-user proxy with
 * `<addr>%<master>` username + master password from `mail-secrets`.
 * Same Secret, same rotation flow.
 *
 * Failure modes:
 *   - JMAP auth fails for one address → script exits non-zero, Job
 *     fails (`set -e`), orchestrator marks component failed.
 *   - `cannotCalculateChanges`: jmap-sync.py automatically falls back
 *     to a full pull and writes a fresh state. Reported in stderr;
 *     orchestrator stores it in `tenant_jmap_state.last_error`.
 *   - Blob fetch fails for one message: jmap-sync.py logs + skips;
 *     the message is re-fetched next run (state not advanced for it).
 *   - Empty mailbox: empty Maildir under that address; tar still
 *     proceeds (restic dedups to ~0 bytes for unchanged inputs).
 *
 * Ephemeral storage:
 *   `/tmp/maildir-out` holds the in-flight Maildir for ALL the
 *   tenant's mailboxes. `emptyDir.sizeLimit: 50Gi` covers the common
 *   case (typical tenant < 5 GiB mail). For tenants with >50 GiB mail,
 *   the platform should be sharding the tenant before reaching that
 *   tier anyway.
 */

import { sql, eq } from 'drizzle-orm';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { Database } from '../../../db/index.js';
import { tailJobLog, readJobLogTail } from '../../storage-lifecycle/job-log-tail.js';
import { readJobToleratingEarlyAbsence, type JobReader } from '../../../shared/k8s-job-wait.js';
import {
  getMailboxBackupEngine,
  getMailboxBackupMaxConcurrent,
  type MailboxBackupEngine,
} from '../mailbox-backup-engine.js';
import { acquireGlobalSlot, ClusterGateError, type SlotHandle } from '../cluster-concurrency.js';
import {
  ensureImapMaxConcurrentAtLeast,
  IMAP_MAX_CONCURRENT_MIGRATION,
} from '../../mail-admin/imap-concurrency.js';
import { mailLogger } from '../../../shared/mail-logger.js';
import { resolvePlatformImage } from '../../../shared/platform-images.js';
import { tenants, tenantBackupV2Settings } from '../../../db/schema.js';
import { resolveBaseDomain } from '../../../config/domains.js';
import { resolveShimBackupTarget } from '../resolve-backup-target.js';
import {
  buildResticRepoUri,
  buildResticEnv,
  buildSnapshotTags,
  deriveResticPassword,
  deriveRegionId,
  ensureResticRepoInitialised,
  type BackupTarget,
} from '../restic-driver.js';
import { notifyResticFailure } from '../restic-failure-notify.js';
import { resolveBundleRepoLayout } from '../repo-layout.js';
import { makeRepoInitSerialiser } from '../repo-init-lock.js';
import {
  buildResticCredsStringData,
  createResticCredsSecret,
  deleteSecretBestEffort,
  wireSecretOwnerRef,
} from './files.js';
import {
  buildMailboxesResticJobSpec,
  parseMailboxDoneLines,
  type MailboxCaptureResult,
} from './mailboxes-restic.js';

const mlog = mailLogger().child({ module: 'tenant-bundles-mailboxes' });

export interface MailboxesComponentResult {
  readonly mailboxCount: number;
  readonly addresses: ReadonlyArray<string>;
  /** Total bytes the restic snapshot reported for this component. */
  readonly sizeBytes: number;
  /**
   * One entry per captured mailbox (ADR-061). Each carries its own restic
   * snapshot, which is what the per-address restore resolves against.
   */
  readonly perMailbox: ReadonlyArray<MailboxCaptureResult>;
  /**
   * DEPRECATED by `perMailbox` — there is no longer a single whole-tenant
   * snapshot. Always '' for captures taken after ADR-061; retained so
   * meta.json and the restore executor keep reading pre-ADR-061 bundles. The orchestrator persists this to
   * `backup_components.sha256` (component='mailboxes') so the
   * `mailboxes-by-address` restore executor can resolve the snapshot to
   * `restic restore` — same source + column the files component uses.
   */
  readonly snapshotId: string;
  /**
   * Bytes this snapshot added to the restic repository (`data_added_packed`),
   * relayed by the upload route. NULL when unknown — never 0, which a
   * mailbox set with no new mail legitimately reports.
   */
  readonly dataAddedPacked: number | null;
  /** Per-mailbox new state, for the orchestrator to persist AFTER the
   *  restic snapshot is acknowledged. */
  readonly newStates: ReadonlyArray<{
    address: string;
    jmapId: string;
    newState: string;
    fetched: number;
    skipped: number;
    fullPull: boolean;
  }>;
}

export interface CaptureMailboxesComponentOpts {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly tenantId: string;
  readonly backupId: string;
  readonly platformApiUrl: string;
  readonly secretsKeyHex: string;
  readonly mailNamespace?: string;       // defaults to 'mail'
  readonly jmapEndpoint?: string;        // defaults to http://stalwart-mgmt.mail.svc.cluster.local:8080
  readonly imapHost?: string;            // defaults to stalwart-mail.mail.svc.cluster.local
  readonly imapPort?: number;            // defaults to 993
  /**
   * Stalwart master-user FQDN. REQUIRED — must be passed by the
   * caller (resolved from `mail/mail-secrets.STALWART_MASTER_USER` via
   * `readStalwartMasterUser` in `mail-admin/stalwart-master-user.ts`).
   * The historical optional + `MASTER_USER_DEFAULT` fallback silently
   * downgraded to `master@master.local` and broke every non-test
   * cluster — making this required forces the caller to think about
   * which value Stalwart actually has provisioned.
   */
  readonly stalwartMasterUser: string;
  /** Apex resolution for the snapshot's region tag (mirrors files.ts). */
  readonly platformBaseDomain?: string;
  readonly ingressBaseDomain?: string;
  /** Stamped onto every snapshot tag so a restore can tell what wrote it. */
  readonly platformVersion?: string;
  readonly masterSecretName?: string;    // defaults to 'mail-secrets'
  readonly masterSecretKey?: string;     // defaults to 'STALWART_MASTER_PASSWORD'
  readonly toolsImage?: string;          // defaults to ghcr.io/.../tenant-backup-tools:latest
  readonly timeoutMs?: number;
  readonly onProgress?: (msg: string) => Promise<void> | void;
  /**
   * Override the active engine from platform_settings. Tests can pin
   * 'jmap' or 'imap'; production reads platform_settings and only
   * uses this override when present.
   */
  readonly engineOverride?: MailboxBackupEngine;
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
// K8s `activeDeadlineSeconds` is the orchestrator timeout minus this
// buffer so K8s force-kills first and the orchestrator's next poll
// sees `DeadlineExceeded` rather than its own generic timeout.
const JOB_DEADLINE_BUFFER_SEC = 60;
const MAIL_NAMESPACE_DEFAULT = 'mail';
const JMAP_ENDPOINT_DEFAULT = 'http://stalwart-mgmt.mail.svc.cluster.local:8080';
const IMAP_HOST_DEFAULT = 'stalwart-mail.mail.svc.cluster.local';
const IMAP_PORT_DEFAULT = 993;
// MASTER_USER_DEFAULT intentionally removed — see
// CaptureMailboxesComponentOpts.stalwartMasterUser doc + the
// readStalwartMasterUser helper. The orchestrator is now the single
// source-of-truth for the master FQDN.
const MASTER_SECRET_NAME_DEFAULT = 'mail-secrets';
const MASTER_SECRET_KEY_DEFAULT = 'STALWART_MASTER_PASSWORD';
// Resolved through the shared table so an operator CAN repoint it — this was
// a bare literal with no env read in six modules (see shared/platform-images.ts).
const TOOLS_IMAGE_DEFAULT = resolvePlatformImage('tenant-backup-tools');

export async function listTenantMailboxAddresses(db: Database, tenantId: string): Promise<string[]> {
  // `mailboxes.full_address` (camelCase = `fullAddress` per Drizzle
  // convention) is the canonical address column. Audited.
  // Send-only accounts are excluded: they have no mail store to capture,
  // and the per-address JMAP capture treats an auth/enumeration failure
  // as fatal for the WHOLE tenant bundle — one no-reply@ would fail every
  // backup. Their config (forwarding targets) lives in the mailboxes
  // table, which the config-tables component already captures.
  // NOTE: the type column is camelCase "mailboxType" (created from the
  // Drizzle property name in migration 0000), unlike the snake_case
  // columns around it — a bare mailbox_type here is a 42703 at runtime.
  const rawDb = db as unknown as { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: { full_address: string }[] }> };
  const r = await rawDb.execute(sql`SELECT full_address FROM mailboxes WHERE tenant_id = ${tenantId} AND "mailboxType" != 'send_only' ORDER BY full_address`);
  return r.rows.map((row) => row.full_address);
}









export async function captureMailboxesComponent(
  opts: CaptureMailboxesComponentOpts,
): Promise<MailboxesComponentResult> {
  const addresses = await listTenantMailboxAddresses(opts.db, opts.tenantId);
  if (addresses.length === 0) {
    // No mailboxes to capture: no snapshot ran, so 0 bytes were added.
    // A genuine zero, not an unknown.
    return { mailboxCount: 0, addresses: [], sizeBytes: 0, snapshotId: '', dataAddedPacked: 0, newStates: [], perMailbox: [] };
  }

  // Engine selection: explicit override > platform_settings > default ('imap').
  const engine: MailboxBackupEngine =
    opts.engineOverride ?? (await getMailboxBackupEngine(opts.db));


  // ── Restic target, password, repo, tags (mirrors files.ts) ────────
  let target: BackupTarget;
  try {
    target = await resolveShimBackupTarget(opts.k8s.core, 'tenant');
  } catch (err) {
    throw new Error(`mailboxes-component: shim backup target unavailable: ${(err as Error).message}`);
  }
  const passwordHex = deriveResticPassword(opts.secretsKeyHex, opts.tenantId);
  // The bundle's OWN layout, not the current default: a re-run or retry of an
  // older bundle must write where that bundle's other components went.
  const repoLayout = await resolveBundleRepoLayout(opts.db, opts.backupId);
  const repoUri = buildResticRepoUri(target, opts.tenantId, 'mailboxes', repoLayout);
  const env = buildResticEnv(target);

  const [tenant] = await opts.db.select().from(tenants).where(eq(tenants.id, opts.tenantId)).limit(1);
  if (!tenant) throw new Error(`mailboxes-component: tenant ${opts.tenantId} not found`);
  const [settings] = await opts.db.select().from(tenantBackupV2Settings).limit(1);
  const apex = resolveBaseDomain({
    PLATFORM_BASE_DOMAIN: opts.platformBaseDomain ?? '',
    INGRESS_BASE_DOMAIN: opts.ingressBaseDomain ?? '',
  });
  const tags = buildSnapshotTags({
    bundleId: opts.backupId,
    tenantId: opts.tenantId,
    tenantSlug: tenant.kubernetesNamespace,
    component: 'mailboxes',
    regionId: deriveRegionId(apex, settings?.regionIdOverride ?? ''),
    platformVersion: opts.platformVersion ?? '',
  });

  const mailNamespace = opts.mailNamespace ?? MAIL_NAMESPACE_DEFAULT;
  const jobName = `bk-mbox-${opts.backupId}`.slice(0, 63);
  const credsSecretName = `bk-mbox-creds-${opts.backupId}`.slice(0, 63);
  const orchestratorTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Initialise the repo in-process, before any Job exists — `restic backup`
  // against an uninitialised repo just exits non-zero inside the Job, where
  // the reason is a log line rather than an operator-facing error.
  const lockLog = {
    warn: (msg: string): void => {
      if (opts.onProgress) void opts.onProgress(msg);
      else mlog.warn({}, msg);
    },
  };
  try {
    // `serialise`: `files` and `mailboxes` share ONE repository under the
    // per-tenant layout and run in parallel, so their inits must not
    // overlap — concurrent `restic init` corrupts the repo permanently
    // (repo-init-lock.ts).
    await ensureResticRepoInitialised({
      target,
      passwordHex,
      repoUri,
      serialise: makeRepoInitSerialiser(opts.db, lockLog),
      log: lockLog,
    });
  } catch (err) {
    await notifyResticFailure(opts.db, {
      operation: 'repo init',
      scope: `tenant ${opts.tenantId} / mailboxes`,
      dedupeScope: `${opts.tenantId}:mailboxes`,
    }, err);
    throw err;
  }

  // Cluster-wide cap on concurrent mailbox capture Jobs.
  const maxConcurrent = await getMailboxBackupMaxConcurrent(opts.db);
  let slot: SlotHandle | null = null;
  let credsCreated = false;
  try {
    try {
      slot = await acquireGlobalSlot(opts.db, {
        bundleId: opts.backupId,
        component: 'mailbox-worker',
        podName: process.env.HOSTNAME ?? undefined,
        globalMaxInFlight: maxConcurrent,
      });
    } catch (err) {
      if (err instanceof ClusterGateError) {
        throw new Error(`mailbox-worker cluster gate refused (${err.code}): ${err.message}`);
      }
      throw err;
    }

    // Elevate Stalwart's x:Imap.maxConcurrent so imap-sync.py's worker pool
    // isn't throttled to one effective connection per user. IMAP engine only
    // — JMAP opens no IMAP connections, so the elevation would be a pointless
    // global mutation. Best-effort: degraded throughput, never a failed
    // capture.
    if (engine === 'imap') {
      try {
        await ensureImapMaxConcurrentAtLeast(IMAP_MAX_CONCURRENT_MIGRATION);
      } catch (err) {
        mlog.warn(
          { err: err instanceof Error ? err.message : String(err), target: IMAP_MAX_CONCURRENT_MIGRATION },
          'failed to elevate x:Imap.maxConcurrent — continuing; throughput may be degraded',
        );
      }
    }

    await createResticCredsSecret(
      opts.k8s,
      mailNamespace,
      credsSecretName,
      buildResticCredsStringData({ passwordHex, repoUri, env }),
      'backup-mailboxes',
    );
    credsCreated = true;

    const spec = buildMailboxesResticJobSpec({
      jobName,
      mailNamespace,
      tenantId: opts.tenantId,
      backupId: opts.backupId,
      toolsImage: opts.toolsImage ?? TOOLS_IMAGE_DEFAULT,
      engine,
      jmapEndpoint: opts.jmapEndpoint ?? JMAP_ENDPOINT_DEFAULT,
      imapHost: opts.imapHost ?? IMAP_HOST_DEFAULT,
      imapPort: opts.imapPort ?? IMAP_PORT_DEFAULT,
      stalwartMasterUser: opts.stalwartMasterUser,
      masterSecretName: opts.masterSecretName ?? MASTER_SECRET_NAME_DEFAULT,
      masterSecretKey: opts.masterSecretKey ?? MASTER_SECRET_KEY_DEFAULT,
      credsSecretName,
      tags,
      addresses,
      activeDeadlineSeconds: Math.max(60, Math.ceil(orchestratorTimeoutMs / 1000) - JOB_DEADLINE_BUFFER_SEC),
    });

    const createdJob = await (opts.k8s.batch as unknown as {
      createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<{ metadata?: { uid?: string } }>;
    }).createNamespacedJob({ namespace: mailNamespace, body: spec });
    const jobCreatedAt = Date.now();

    // ownerRef the creds Secret to the Job so kube-controller GCs it with the
    // Job's ttlSecondsAfterFinished.
    const jobUid = createdJob.metadata?.uid;
    if (jobUid) {
      try {
        await wireSecretOwnerRef(opts.k8s, mailNamespace, credsSecretName, jobName, jobUid);
        credsCreated = false; // the Job owns it now
      } catch (err) {
        mlog.warn(
          { err: err instanceof Error ? err.message : String(err), secret: credsSecretName },
          'could not wire ownerRef on mailbox creds Secret — falling back to explicit delete',
        );
      }
    }

    await waitForJob(opts.k8s, mailNamespace, jobName, jobCreatedAt, orchestratorTimeoutMs, opts.onProgress);

    // One MAILBOX_DONE line per mailbox. tailLines must comfortably exceed
    // 2 lines per mailbox plus the per-address progress chatter.
    const log = await readJobLogTail(opts.k8s, mailNamespace, jobName, { tailLines: 2000 }).catch(() => null);
    const perMailbox = parseMailboxDoneLines(log ?? '', opts.backupId);

    if (perMailbox.length !== addresses.length) {
      // A short result means a mailbox produced no snapshot. Treating that as
      // success would ship a bundle that silently omits someone's mail.
      const captured = new Set(perMailbox.map((m) => m.address));
      const missing = addresses.filter((a) => !captured.has(a));
      throw new Error(
        `mailboxes-component: ${missing.length} of ${addresses.length} mailbox(es) produced no snapshot: ${missing.join(', ')}`,
      );
    }

    // Compression, per mailbox, in the bundle's own progress channel. restic
    // reports both numbers on every snapshot; until now only the packed one
    // was echoed, so the ratio could not be seen without a synthetic corpus.
    for (const m of perMailbox) {
      if (m.dataAddedRaw !== null && m.dataAddedPacked !== null && m.dataAddedPacked > 0) {
        mlog.info(
          {
            address: m.address,
            rawBytes: m.dataAddedRaw,
            packedBytes: m.dataAddedPacked,
            ratio: Number((m.dataAddedRaw / m.dataAddedPacked).toFixed(2)),
          },
          'mailbox capture: compression',
        );
      }
    }

    const sizeBytes = perMailbox.reduce((acc, m) => acc + m.sizeBytes, 0);
    const measured = perMailbox.filter((m) => m.dataAddedPacked !== null);
    return {
      mailboxCount: addresses.length,
      addresses,
      sizeBytes,
      perMailbox,
      // No single whole-tenant snapshot exists any more.
      snapshotId: '',
      // Null — not 0 — when nothing reported a measurement, so an unmeasured
      // run can never read as "measured zero".
      dataAddedPacked: measured.length > 0
        ? measured.reduce((acc, m) => acc + (m.dataAddedPacked ?? 0), 0)
        : null,
      newStates: [],
    };
  } finally {
    if (slot) await slot.release();
    if (credsCreated) await deleteSecretBestEffort(opts.k8s, mailNamespace, credsSecretName);
  }
}


async function waitForJob(
  k8s: K8sClients,
  namespace: string,
  jobName: string,
  jobCreatedAtMs: number,
  timeoutMs: number,
  onProgress?: (msg: string) => Promise<void> | void,
): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Tolerate the post-create read-after-write race on HA control
    // planes (see shared/k8s-job-wait.ts). `null` → not visible yet.
    const job = await readJobToleratingEarlyAbsence(
      k8s.batch as unknown as JobReader,
      jobName,
      namespace,
      jobCreatedAtMs,
    );
    if (!job) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`mailboxes-component Job ${jobName} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      await new Promise((res) => setTimeout(res, 3000));
      continue;
    }

    const status = job.status ?? {};
    const completed = (status.conditions ?? []).find((c) => c.type === 'Complete' && c.status === 'True');
    const failed = (status.conditions ?? []).find((c) => c.type === 'Failed' && c.status === 'True');
    if (completed || (status.succeeded ?? 0) > 0) return;
    if (failed || (status.failed ?? 0) > 0) {
      // Tail the pod logs so the eventual lastError surfaces the
      // real reason (e.g. Stalwart "no such user" drift) instead
      // of the opaque "backoff limit reached" the Job condition
      // reports. Best-effort — log fetch failure must not mask
      // the underlying Job failure.
      let logTail = '';
      try {
        const tail = await tailJobLog(k8s, namespace, jobName, { tailLines: 30, maxLineLength: 400 });
        if (tail) logTail = `; logs: ${tail.slice(-1200)}`;
      } catch { /* ignore */ }
      throw new Error(`mailboxes-component Job ${jobName} failed: ${failed?.message ?? 'unknown'}${logTail}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`mailboxes-component Job ${jobName} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (onProgress) {
      const tail = await tailJobLog(k8s, namespace, jobName, { tailLines: 5, maxLineLength: 200 }).catch(() => null);
      await onProgress(tail ? `mailboxes: ${tail}` : 'Capturing mailboxes…');
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
}
