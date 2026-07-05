/**
 * Restore executor: `mailboxes-by-address` (restic-native rewrite,
 * 2026-07-05).
 *
 * The `mailboxes` capture component (ADR-047, see
 * tenant-bundles/components/mailboxes.ts) writes ONE whole-tenant restic
 * stream per bundle: it `tar cf - .` over `/tmp/maildir-out` (which holds
 * `<address>/<mailbox>/cur/<...>` for ALL of the tenant's addresses) and
 * pipes it to platform-api's restic-stream endpoint with stdin-filename
 * `maildir.tar`, landing a single snapshot in the per-tenant restic repo
 * for component `mailboxes`. There is NO per-address `<addr>.mbox.tar.gz`
 * artifact any more — the legacy download-token + curl path that this
 * executor used to drive always 404'd against the current capture.
 *
 * This executor now mirrors the `files-paths` restic pattern exactly:
 *
 *   1. Resolve the mailboxes restic snapshot id from
 *      `backup_components.sha256` (component='mailboxes'). 404 if missing.
 *   2. Derive the per-tenant restic password, build the repo URI for
 *      component `mailboxes`, resolve the shim S3 target, and mount a
 *      per-Job creds Secret at /var/run/restic-creds (mode 0400).
 *   3. Resolve the target address list — `addresses` selector uses the
 *      requested list; `all` enumerates the tenant's mailbox addresses
 *      from the platform DB (listTenantMailboxAddresses).
 *   4. Spawn a Job in the `mail` namespace using tenant-backup-tools that:
 *        a. `restic -r "$REPO" restore <snap> --target /tmp/restic-out
 *           --no-lock` → produces `/tmp/restic-out/maildir.tar`.
 *        b. `tar xf /tmp/restic-out/maildir.tar -C /tmp/maildir-all`
 *           → yields `/tmp/maildir-all/<address>/<mailbox>/cur/...`.
 *        c. loops the target addresses; per ADDR runs
 *             python3 /usr/local/bin/jmap-restore.py
 *               --endpoint <jmapEndpoint>
 *               --target-address "$ADDR" --source-address "$ADDR"
 *               --master-user <master>
 *               --auth-pass-env STALWART_MASTER_PASSWORD
 *               --maildir-root /tmp/maildir-all
 *               --mode "$MODE" --workers "$WORKERS"
 *           `--maildir-root` is the SHARED extraction root; `--source-
 *           address $ADDR` selects that address's subtree (jmap-restore.py
 *           expects `<root>/<source-address>/<mailbox>/cur/...`, which is
 *           exactly the extracted layout).
 *        d. best-effort aux restore (jmap-aux-restore.py) against
 *           `/tmp/maildir-all/$ADDR/.aux`.
 *
 * Per-address shell loop uses POSIX `case "$i"` dispatch (same security
 * pattern as the capture executor — see tenant-bundles/components/
 * mailboxes.ts) so an attacker cannot inject through the address list
 * even if the upstream isSafeAddress() check were bypassed. The Stalwart
 * master password reaches jmap-restore.py only via --auth-pass-env (never
 * argv); the restic + shim S3 creds reach restic only via the mounted
 * Secret (never argv / env-in-spec).
 *
 * Mode plumbing (unchanged):
 *   The restore mode lives in the selector (mailboxRestoreModeSchema):
 *     - merge-skip-duplicates (default)        — JMAP dedup by Message-ID
 *     - merge-overwrite                        — JMAP import, no dedup
 *     - replace (requires confirmDestructive)  — JMAP pre-purge then import
 *   The schema's superRefine enforces the typed-confirmation pattern;
 *   the executor reads selector.mode (defaulting to merge-skip).
 *
 * Stalwart account existence: jmap-restore.py REQUIRES the target
 * principal to exist (otherwise auth fails). ensureStalwartPrincipals()
 * runs BEFORE the Job and recreates missing principals from the platform
 * DB `mailboxes` row when necessary.
 *
 * Rollback: set `MAILBOX_RESTORE_METHOD=imap` in the platform-api env to
 * drive imap-restore.py instead of jmap-restore.py (both consume the same
 * extracted Maildir tree). The engine also follows
 * platform_settings.mailbox_backup_engine.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import type { BackupStore } from '../../tenant-bundles/bundle-store.js';
import { restoreItems, restoreJobs, backupComponents, type RestoreItem } from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';
import { tailJobLog } from '../../storage-lifecycle/job-log-tail.js';
import { createK8sClients, type K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { ensureStalwartPrincipals } from './ensure-stalwart-principals.js';
import { listTenantMailboxAddresses } from '../../tenant-bundles/components/mailboxes.js';
import { resolveShimBackupTarget } from '../../tenant-bundles/resolve-backup-target.js';
import {
  buildResticRepoUri,
  buildResticEnv,
  deriveResticPassword,
} from '../../tenant-bundles/restic-driver.js';
import {
  buildResticCredsStringData,
  createResticCredsSecret,
  wireSecretOwnerRef,
} from '../../tenant-bundles/components/files.js';
import {
  getMailboxBackupEngine,
  getMailboxBackupMaxConcurrent,
} from '../../tenant-bundles/mailbox-backup-engine.js';
import { acquireGlobalSlot, ClusterGateError, type SlotHandle } from '../../tenant-bundles/cluster-concurrency.js';
import {
  ensureImapMaxConcurrentAtLeast,
  IMAP_MAX_CONCURRENT_MIGRATION,
} from '../../mail-admin/imap-concurrency.js';
import { mailLogger } from '../../../shared/mail-logger.js';

const mlog = mailLogger().child({ module: 'mailboxes-by-address-restore' });
import {
  type MailboxRestoreMode,
  MAILBOX_RESTORE_MODE_DEFAULT,
} from '@insula/api-contracts';

interface Selector {
  kind: 'all' | 'addresses';
  addresses?: readonly string[];
  mode?: MailboxRestoreMode;
  confirmDestructive?: boolean;
}

const MAIL_NAMESPACE = 'mail';
// JMAP capture and restore share the same in-cluster mgmt endpoint —
// see tenant-bundles/components/mailboxes.ts for the rationale on
// preferring the HTTP mgmt service over the public HTTPS ingress
// (cert verification + cluster-local routing).
const JMAP_ENDPOINT_DEFAULT = 'http://stalwart-mgmt.mail.svc.cluster.local:8080';
// MASTER_USER_DEFAULT intentionally removed 2026-05-23 — the executor
// now resolves the master FQDN at runtime via readStalwartMasterUser
// (see ../../mail-admin/stalwart-master-user.ts) so it can never silently
// fall back to the test-only 'master@master.local' value on a real
// cluster. Bootstrap.sh provisions the actual FQDN in
// `mail/mail-secrets.STALWART_MASTER_USER`.
const MASTER_SECRET_NAME_DEFAULT = 'mail-secrets';
const MASTER_SECRET_KEY_DEFAULT = 'STALWART_MASTER_PASSWORD';
const TOOLS_IMAGE_DEFAULT = 'ghcr.io/insulahq/insula/tenant-backup-tools:latest';
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
// Parallelism for Blob/upload from a single jmap-restore.py invocation.
// Stalwart's bumped maxConcurrentUploads=32 caps the upper bound;
// 16 leaves headroom for backup-and-restore-at-the-same-time.
const RESTORE_WORKERS_DEFAULT = 16;
// Per-Job creds Secret mount — mirrors files-paths.ts / files.ts.
const CREDS_MOUNT_PATH = '/var/run/restic-creds';
// Full restic snapshot ids are 64 hex; accept a short id too (restic
// resolves prefixes) — same shape files-paths.ts validates.
const RESTIC_SNAPSHOT_ID_RE = /^[0-9a-f]{8,64}$/;
// restic lands the restore tree here; the stdin capture is a single file
// at `<target>/maildir.tar`.
const RESTORE_TMP = '/tmp/restic-out';
// Shared extraction root for the whole-tenant Maildir tarball.
const MAILDIR_ALL = '/tmp/maildir-all';
// stdin-filename used by the capture (mailboxes.ts STDIN_FILENAME).
const STDIN_TARBALL = 'maildir.tar';

const VALID_MODES: ReadonlySet<MailboxRestoreMode> = new Set([
  'merge-skip-duplicates',
  'merge-overwrite',
  'replace',
]);

function isSafeAddress(address: string): boolean {
  return /^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+$/.test(address);
}

function isSafeJmapEndpoint(url: string): boolean {
  // http://host[.port][/path] or https://… — no shell-meaningful chars.
  // We embed this verbatim into a JMAP --endpoint argv; jmap-restore.py
  // will resolve the /.well-known/jmap path itself.
  return /^https?:\/\/[A-Za-z0-9.\-]+(:\d+)?(\/[A-Za-z0-9._~:/?#@!$&'()*+,;=\-]*)?$/.test(url);
}

function isSafeMasterUser(user: string): boolean {
  // Stalwart needs `<local>@<domain>`; bare alphanumeric form is
  // tolerated for legacy / non-Stalwart servers.
  return /^[A-Za-z0-9._\-]+(@[A-Za-z0-9.\-]+)?$/.test(user);
}

/**
 * POSIX shell quoting — mirror of the helper in
 * tenant-bundles/components/mailboxes.ts. Kept inline (rather than
 * exported from a shared util) to make this file's shell-injection
 * surface self-contained.
 */
function shQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function execMailboxesByAddressItem(args: {
  app: FastifyInstance;
  item: RestoreItem;
  store: BackupStore;
}): Promise<void> {
  const { app, item } = args;
  const selector = item.selector as unknown as Selector;

  // Mode: default merge-skip-duplicates. Replace requires explicit
  // confirmDestructive flag (defence-in-depth — the contract
  // superRefine enforces this at API boundary too).
  const mode: MailboxRestoreMode = selector.mode ?? MAILBOX_RESTORE_MODE_DEFAULT;
  if (!VALID_MODES.has(mode)) {
    throw new ApiError('VALIDATION_ERROR', `mailboxes-by-address: invalid mode '${mode}'`, 400);
  }
  if (mode === 'replace' && selector.confirmDestructive !== true) {
    throw new ApiError(
      'CONFIRMATION_REQUIRED',
      `mailbox restore mode 'replace' is destructive — set confirmDestructive: true to proceed`,
      400,
    );
  }

  const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, item.restoreJobId)).limit(1);
  if (!job) throw new ApiError('NOT_FOUND', `Restore job ${item.restoreJobId} not found`, 404);

  // ── Resolve the mailboxes restic snapshot id ──────────────────────
  // Persisted on backup_components.sha256 (component='mailboxes') by the
  // orchestrator — the same source + column the files component uses.
  const [comp] = await app.db.select()
    .from(backupComponents)
    .where(and(
      eq(backupComponents.backupJobId, item.bundleId),
      eq(backupComponents.component, 'mailboxes'),
    ))
    .limit(1);
  if (!comp?.sha256 || !RESTIC_SNAPSHOT_ID_RE.test(comp.sha256)) {
    throw new ApiError('NOT_FOUND', `Bundle ${item.bundleId} has no mailboxes restic snapshot`, 404);
  }
  const snapshotId = comp.sha256;

  // ── Resolve target addresses ──────────────────────────────────────
  let addresses: readonly string[];
  if (selector.kind === 'all') {
    // Enumerate the tenant's mailbox addresses from the platform DB —
    // the same query the capture side uses to decide what to snapshot.
    addresses = await listTenantMailboxAddresses(app.db, job.tenantId);
    if (addresses.length === 0) {
      await app.db.update(restoreItems)
        .set({ progressMessage: 'mailboxes-by-address: tenant has no mailboxes' })
        .where(eq(restoreItems.id, item.id));
      return;
    }
  } else if (selector.kind === 'addresses' && Array.isArray(selector.addresses) && selector.addresses.length > 0) {
    for (const a of selector.addresses) {
      if (!isSafeAddress(a)) {
        throw new ApiError('VALIDATION_ERROR', `mailboxes-by-address: invalid address '${a}'`, 400);
      }
    }
    addresses = selector.addresses;
  } else {
    throw new Error(`mailboxes-by-address: unsupported selector ${JSON.stringify(selector)}`);
  }

  // ── Resolve PLATFORM_ENCRYPTION_KEY (per-tenant restic password) ───
  const secretsKeyHex = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!secretsKeyHex) {
    throw new ApiError('CONFIG_INVALID', 'PLATFORM_ENCRYPTION_KEY not configured', 500);
  }

  // Ensure each target principal exists in Stalwart BEFORE shipping
  // the restore Job — otherwise jmap-restore.py would fail per address
  // with `unauthorized` and we'd waste the Job's setup cost. The
  // helper:
  //   - leaves existing principals untouched
  //   - recreates missing principals using metadata from the platform
  //     mailboxes DB row (run a `config-tables(mailboxes)` cart item
  //     FIRST when restoring a fully-deleted account so the DB row
  //     is recreated before this executor runs)
  //   - surfaces MAILBOX_ROW_MISSING if BOTH Stalwart and the DB are
  //     missing this address — operators get a clear remediation path
  const ensure = await ensureStalwartPrincipals({ app, addresses });
  const failedEnsures = ensure.outcomes.filter((o) => o.status === 'failed');
  if (failedEnsures.length > 0) {
    const detail = failedEnsures
      .map((o) => `${o.address}: ${o.reason}`)
      .join('; ');
    throw new ApiError(
      'PRINCIPAL_ENSURE_FAILED',
      `Could not ensure Stalwart principals before restore: ${detail}`,
      409,
    );
  }
  if (ensure.recreated > 0) {
    app.log.info(
      { module: 'mailboxes-by-address-restore', recreated: ensure.recreated, addresses: addresses.length },
      'recreated Stalwart principals for restore — placeholder secrets are random; operator should rotate user-facing passwords',
    );
  }

  const jobName = `rs-mbox-${item.id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 50)}`;
  const credsSecretName = `rs-mbox-creds-${item.id.replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 63);

  // Engine + concurrency cap from platform_settings.
  const engine = await getMailboxBackupEngine(app.db);
  const maxConcurrent = await getMailboxBackupMaxConcurrent(app.db);

  const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined
    ?? process.env.KUBECONFIG;
  const k8s: K8sClients = createK8sClients(kc);

  // ── Resolve the shim target + per-tenant password + repo URI ──────
  // The mailboxes component snapshot lives in the per-tenant restic repo
  // under the `tenant` shim bucket (same target the capture-side restic-
  // stream endpoint uses); the repo URI component is `mailboxes`.
  const target = await resolveShimBackupTarget(k8s.core, 'tenant', app.log);
  const passwordHex = deriveResticPassword(secretsKeyHex, job.tenantId);
  const repoUri = buildResticRepoUri(target, job.tenantId, 'mailboxes');
  const env = buildResticEnv(target);

  // Resolve the Stalwart master-user FQDN from mail-secrets — the
  // compiled-in default (`master@master.local`) only matches unit-
  // test fixtures; real clusters provision `master@<PLATFORM_DOMAIN>`
  // and the bundle Job hits AUTHENTICATIONFAILED without this lookup.
  const { readStalwartMasterUser } = await import('../../mail-admin/stalwart-master-user.js');
  const stalwartMasterUser = await readStalwartMasterUser(k8s.core);

  const spec = buildMailboxesByAddressJobSpec({
    jobName,
    mailNamespace: MAIL_NAMESPACE,
    tenantId: job.tenantId,
    cartId: item.restoreJobId,
    itemId: item.id,
    toolsImage: TOOLS_IMAGE_DEFAULT,
    engine,
    jmapEndpoint: JMAP_ENDPOINT_DEFAULT,
    stalwartMasterUser,
    masterSecretName: MASTER_SECRET_NAME_DEFAULT,
    masterSecretKey: MASTER_SECRET_KEY_DEFAULT,
    mode,
    credsSecretName,
    snapshotId,
    addresses,
    workers: RESTORE_WORKERS_DEFAULT,
  });

  // Cluster-wide cap on concurrent mailbox-worker Jobs. Same gate the
  // capture side uses; serializes restore Jobs with capture Jobs across
  // all platform-api replicas.
  let slot: SlotHandle | null = null;
  let credsCreated = false;
  let ownerRefWired = false;
  try {
    try {
      slot = await acquireGlobalSlot(app.db, {
        bundleId: item.bundleId,
        component: 'mailbox-worker',
        podName: process.env.HOSTNAME ?? undefined,
        globalMaxInFlight: maxConcurrent,
      });
    } catch (err) {
      if (err instanceof ClusterGateError) {
        throw new Error(
          `mailbox-worker cluster gate refused (${err.code}): ${err.message}`,
        );
      }
      throw err;
    }

    // Elevate Stalwart's x:Imap.maxConcurrent before the restore Job
    // starts so imap-restore.py --workers 4 isn't throttled. Idempotent;
    // best-effort. Only fires for the IMAP engine — the JMAP path
    // doesn't open IMAP connections at all so the global mutation
    // would just delay the reverter. See backend/src/modules/mail-admin/
    // imap-concurrency.ts.
    if (engine === 'imap') {
      try {
        await ensureImapMaxConcurrentAtLeast(IMAP_MAX_CONCURRENT_MIGRATION);
      } catch (err) {
        mlog.warn(
          { err: err instanceof Error ? err.message : String(err), target: IMAP_MAX_CONCURRENT_MIGRATION },
          'failed to elevate x:Imap.maxConcurrent — continuing with current setting; throughput may be degraded',
        );
      }
    }

    // Per-Job creds Secret (restic password + shim S3 keys + repo URI),
    // mounted read-only at /var/run/restic-creds. Reuses the files
    // component's helpers so capture + restore share one code path.
    await createResticCredsSecret(
      k8s,
      MAIL_NAMESPACE,
      credsSecretName,
      buildResticCredsStringData({ passwordHex, repoUri, env }),
      'restore-files',
    );
    credsCreated = true;

    const createdJob = await (k8s.batch as unknown as {
      createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<{ metadata?: { uid?: string } }>;
    }).createNamespacedJob({ namespace: MAIL_NAMESPACE, body: spec });

    // ownerRef the creds Secret to the Job so it GCs with the Job.
    const jobUid = createdJob.metadata?.uid;
    if (jobUid) {
      try {
        await wireSecretOwnerRef(k8s, MAIL_NAMESPACE, credsSecretName, jobName, jobUid);
        ownerRefWired = true;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[mailboxes-by-address] could not wire ownerRef on creds Secret '${credsSecretName}': ${(err as Error).message}`);
      }
    }

    await waitForJob(k8s, MAIL_NAMESPACE, jobName, DEFAULT_TIMEOUT_MS, async (msg) => {
      await app.db.update(restoreItems)
        .set({ progressMessage: msg })
        .where(eq(restoreItems.id, item.id));
    });

    let log = '';
    // jmap-restore.py emits one JSON summary line per address to stdout.
    // The script's `echo "MAILBOX_RESTORED addr=$ADDR ..."` lines and
    // python stderr can interleave, so we don't require a fixed tail
    // length — grab the last 200 lines and JSON-parse any that look like
    // our summary shape.
    try { log = (await tailJobLog(k8s, MAIL_NAMESPACE, jobName, { tailLines: 200, maxLineLength: 5000 })) ?? ''; } catch { /* ignore */ }
    let imported = 0;
    let skippedTotal = 0;
    let failed = 0;
    let mailboxesCreated = 0;
    let prePurged = 0;
    let elapsedMs = 0;
    for (const line of log.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{') || !t.endsWith('}')) continue;
      try {
        const j = JSON.parse(t) as Partial<{
          imported: number;
          skipped: number;
          failed: number;
          prePurged: number;
          mailboxesCreated: string[];
          elapsedSeconds: number;
        }>;
        if (typeof j.imported === 'number') {
          imported += j.imported;
          skippedTotal += j.skipped ?? 0;
          failed += j.failed ?? 0;
          prePurged += j.prePurged ?? 0;
          mailboxesCreated += (j.mailboxesCreated ?? []).length;
          elapsedMs = Math.max(elapsedMs, Math.round((j.elapsedSeconds ?? 0) * 1000));
        }
      } catch {
        // Not a jmap-restore summary line; ignore.
      }
    }
    await app.db.update(restoreItems)
      .set({
        progressMessage:
          `restored ${addresses.length} mailbox(es) (mode=${mode}, imported=${imported}, ` +
          `skipped=${skippedTotal}, failed=${failed}, mailboxesCreated=${mailboxesCreated}, ` +
          `prePurged=${prePurged}, elapsedMs=${elapsedMs})`,
      })
      .where(eq(restoreItems.id, item.id));
  } finally {
    if (slot) await slot.release();
    // If the creds Secret was created but the Job's ownerRef never got
    // wired (Job create failed, or the ownerRef patch failed), kube won't
    // GC it — delete it ourselves so the per-tenant creds don't linger.
    if (credsCreated && !ownerRefWired) {
      try {
        await (k8s.core as unknown as {
          deleteNamespacedSecret: (a: { name: string; namespace: string }) => Promise<unknown>;
        }).deleteNamespacedSecret({ name: credsSecretName, namespace: MAIL_NAMESPACE });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[mailboxes-by-address] best-effort delete of creds Secret '${credsSecretName}' failed: ${(err as Error).message}`);
      }
    }
  }
}

export function buildMailboxesByAddressJobSpec(input: {
  jobName: string;
  mailNamespace: string;
  tenantId: string;
  cartId: string;
  itemId: string;
  toolsImage: string;
  /**
   * Active engine. `jmap` (default — legacy) runs `jmap-restore.py`;
   * `imap` runs the new `imap-restore.py`. Both consume the SAME shared
   * extraction root (/tmp/maildir-all) selected per address via
   * `--source-address`. See platform_settings.mailbox_backup_engine.
   */
  engine?: 'jmap' | 'imap';
  jmapEndpoint: string;
  /** IMAPS host (used when engine='imap'). */
  imapHost?: string;
  imapPort?: number;
  stalwartMasterUser: string;
  masterSecretName: string;
  masterSecretKey: string;
  mode: MailboxRestoreMode;
  /** Name of the per-Job creds Secret (restic_password, aws_*, repo_uri). */
  credsSecretName: string;
  /** Mailboxes restic snapshot id (from backup_components.sha256). */
  snapshotId: string;
  /** Target mailbox addresses (validated, whitelisted). */
  addresses: ReadonlyArray<string>;
  workers: number;
}): Record<string, unknown> {
  for (const a of input.addresses) {
    if (!isSafeAddress(a)) {
      throw new Error(`buildMailboxesByAddressJobSpec: invalid address '${a}'`);
    }
  }
  if (input.addresses.length === 0) {
    throw new Error('buildMailboxesByAddressJobSpec: no addresses to restore');
  }
  if (!isSafeJmapEndpoint(input.jmapEndpoint)) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid jmapEndpoint '${input.jmapEndpoint}'`);
  }
  if (!isSafeMasterUser(input.stalwartMasterUser)) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid stalwartMasterUser '${input.stalwartMasterUser}'`);
  }
  if (!Number.isInteger(input.workers) || input.workers < 1 || input.workers > 64) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid workers '${input.workers}'`);
  }
  if (!VALID_MODES.has(input.mode)) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid mode '${input.mode}'`);
  }
  if (!RESTIC_SNAPSHOT_ID_RE.test(input.snapshotId)) {
    throw new Error(`buildMailboxesByAddressJobSpec: invalid snapshotId '${input.snapshotId}'`);
  }
  const engine = input.engine ?? 'jmap';
  const imapHost = input.imapHost ?? 'stalwart-mail.mail.svc.cluster.local';
  const imapPort = input.imapPort ?? 993;
  if (engine === 'imap') {
    if (!/^[A-Za-z0-9.\-]+$/.test(imapHost)) {
      throw new Error(`buildMailboxesByAddressJobSpec: invalid imapHost '${imapHost}'`);
    }
    if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) {
      throw new Error(`buildMailboxesByAddressJobSpec: invalid imapPort ${imapPort}`);
    }
  }
  // The master password is the only secret-mounted env; restic + shim S3
  // creds arrive via the mounted creds Secret (never argv / env-in-spec).
  const masterPasswordEnv = {
    name: 'STALWART_MASTER_PASSWORD',
    valueFrom: {
      secretKeyRef: {
        name: input.masterSecretName,
        key: input.masterSecretKey,
        optional: false,
      },
    },
  };

  // Per-address loop dispatches the address via a POSIX `case "$i"` block
  // keyed on the integer index, with the whitelisted string literal
  // embedded at TS-build time. No `eval`, no per-address env vars — same
  // shell-injection posture as the capture executor
  // (tenant-bundles/components/mailboxes.ts).
  //
  // STALWART_MASTER_PASSWORD is read by jmap-restore.py via
  // --auth-pass-env (the password value never appears in argv, keeping
  // it out of /proc/<pid>/cmdline and `kubectl get pod -o yaml`).
  const caseBlock = input.addresses.map((address, i) =>
    `    ${i}) ADDR="${address}";;`,
  ).join('\n');

  const mailRestoreLine = engine === 'imap'
    // shQuote `imapHost` for parity with the capture-side script — even
    // though the imap-branch validator restricts imapHost to
    // `/^[A-Za-z0-9.\-]+$/`, this keeps the two scripts symmetric.
    ? `  python3 /usr/local/bin/imap-restore.py \\
       --imap-host ${shQuote(imapHost)} \\
       --imap-port ${imapPort} \\
       --target-address "$ADDR" \\
       --source-address "$ADDR" \\
       --master-user "${input.stalwartMasterUser}" \\
       --auth-pass-env STALWART_MASTER_PASSWORD \\
       --maildir-root ${MAILDIR_ALL} \\
       --mode "$MODE"`
    : `  python3 /usr/local/bin/jmap-restore.py \\
       --endpoint "${input.jmapEndpoint}" \\
       --target-address "$ADDR" \\
       --source-address "$ADDR" \\
       --master-user "${input.stalwartMasterUser}" \\
       --auth-pass-env STALWART_MASTER_PASSWORD \\
       --maildir-root ${MAILDIR_ALL} \\
       --mode "$MODE" \\
       --workers "$WORKERS"`;

  const script = [
    'set -e',
    // ── restic creds from the mounted Secret (never argv / env-in-spec) ──
    `export RESTIC_PASSWORD="$(cat ${CREDS_MOUNT_PATH}/restic_password)"`,
    `[ -n "$RESTIC_PASSWORD" ] || { echo "ERROR: restic password missing"; exit 1; }`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_access_key_id ]; then export AWS_ACCESS_KEY_ID="$(cat ${CREDS_MOUNT_PATH}/aws_access_key_id)"; fi`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_secret_access_key ]; then export AWS_SECRET_ACCESS_KEY="$(cat ${CREDS_MOUNT_PATH}/aws_secret_access_key)"; fi`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_region ]; then export AWS_DEFAULT_REGION="$(cat ${CREDS_MOUNT_PATH}/aws_region)"; fi`,
    `REPO="$(cat ${CREDS_MOUNT_PATH}/repo_uri)"`,
    `[ -n "$REPO" ] || { echo "ERROR: repo uri missing"; exit 1; }`,
    `COUNT=${input.addresses.length}`,
    `MODE=${input.mode}`,
    `WORKERS=${input.workers}`,
    `mkdir -p ${RESTORE_TMP} ${MAILDIR_ALL}`,
    // ── Restore the ONE whole-tenant Maildir tarball via restic ──────────
    `echo "Restoring maildir snapshot ${input.snapshotId} from restic..." >&2`,
    `restic -r "$REPO" restore ${input.snapshotId} --target ${RESTORE_TMP} --no-lock || { echo "ERROR: restic restore failed"; exit 1; }`,
    // The stdin capture lands as a single file `<target>/maildir.tar`.
    // Fall back to a defensive `find` in case restic nests it under a
    // sub-path for the stdin-filename layout.
    `TARBALL=${RESTORE_TMP}/${STDIN_TARBALL}`,
    `[ -f "$TARBALL" ] || TARBALL=$(find ${RESTORE_TMP} -type f -name ${STDIN_TARBALL} 2>/dev/null | head -n1)`,
    `{ [ -n "$TARBALL" ] && [ -f "$TARBALL" ]; } || { echo "ERROR: ${STDIN_TARBALL} not found in restored snapshot"; ls -laR ${RESTORE_TMP} >&2 || true; exit 1; }`,
    // Extract → /tmp/maildir-all/<address>/<mailbox>/cur/... (capture
    // tarred `.` over /tmp/maildir-out, so entries are ./<address>/...).
    `tar xf "$TARBALL" -C ${MAILDIR_ALL}`,
    `rm -f "$TARBALL"`,
    // ── Per-address restore loop ─────────────────────────────────────────
    'for i in $(seq 0 $((COUNT - 1))); do',
    '  ADDR=',
    '  case "$i" in',
    caseBlock,
    '    *) echo "BUG: address index $i out of bounds" >&2; exit 1;;',
    '  esac',
    '  [ -n "$ADDR" ] || { echo "BUG: empty address at $i" >&2; exit 1; }',
    `  echo "Restoring $ADDR via ${engine.toUpperCase()} (mode=$MODE workers=$WORKERS)..." >&2`,
    mailRestoreLine,
    // Auxiliary surfaces — Sieve scripts, Contacts, Calendars, Vacation
    // responses, FileNodes. Restore mirrors the capture wiring
    // (mailboxes.ts) — always JMAP, best-effort. A non-zero exit logs a
    // WARN and the per-address loop continues so a partially-failed aux
    // restore doesn't fail the mail restore. --confirm-destructive is
    // conditionally appended only in replace mode (jmap-aux-restore.py
    // refuses replace without the flag). The aux subtree extracted for
    // this address is `/tmp/maildir-all/$ADDR/.aux`.
    `  if [ -d "${MAILDIR_ALL}/$ADDR/.aux" ]; then`,
    `    AUX_FLAGS=""; [ "$MODE" = "replace" ] && AUX_FLAGS="--confirm-destructive"`,
    `    python3 /usr/local/bin/jmap-aux-restore.py \\
       --endpoint "${input.jmapEndpoint}" \\
       --target-address "$ADDR" \\
       --source-address "$ADDR" \\
       --master-user "${input.stalwartMasterUser}" \\
       --auth-pass-env STALWART_MASTER_PASSWORD \\
       --maildir-root ${MAILDIR_ALL} \\
       --mode "$MODE" $AUX_FLAGS || echo "AUX_WARN address=$ADDR jmap-aux-restore.py exited non-zero — mail restore is unaffected"`,
    '    echo "AUX_RESTORED addr=$ADDR mode=$MODE"',
    '  else',
    '    echo "AUX_SKIP addr=$ADDR no .aux dir in snapshot"',
    '  fi',
    '  echo "MAILBOX_RESTORED addr=$ADDR mode=$MODE"',
    'done',
    `rm -rf ${RESTORE_TMP} ${MAILDIR_ALL} 2>/dev/null || true`,
    'echo "MAILBOXES_RESTORED total=$COUNT"',
  ].join('\n');

  return {
    metadata: {
      name: input.jobName,
      namespace: input.mailNamespace,
      labels: {
        // Reuse restore-files label so the existing NetworkPolicy
        // covers this Job too (it allows Job → shim S3 +
        // Job → in-cluster Stalwart svc).
        'platform.io/component': 'restore-files',
        'platform.io/tenant-id': input.tenantId,
        'platform.io/restore-cart': input.cartId,
        'platform.io/restore-item': input.itemId,
        'platform.io/sub-component': 'restore-mailboxes',
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            'platform.io/component': 'restore-files',
            'platform.io/tenant-id': input.tenantId,
            'platform.io/restore-cart': input.cartId,
            'platform.io/restore-item': input.itemId,
            'platform.io/sub-component': 'restore-mailboxes',
          },
        },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'mailboxes-restore',
            image: input.toolsImage,
            // Same `Always` pull policy as the capture path
            // (tenant-bundles/components/mailboxes.ts) — keeps the
            // tag-floating `:latest` workflow honest until we pin
            // to a SHA via build-deploy. Worth ~50 ms of cold-start
            // image-list lookup per Job.
            imagePullPolicy: 'Always',
            command: ['sh', '-c', script],
            env: [
              masterPasswordEnv,
            ],
            resources: {
              // restic restore streams pack files + jmap-restore.py streams
              // blobs one at a time; memory stays bounded. Limit set higher
              // than peak to leave a GC-time cushion.
              requests: { cpu: '200m', memory: '512Mi' },
              limits: { cpu: '2000m', memory: '2Gi' },
            },
            volumeMounts: [
              { name: 'scratch', mountPath: '/tmp' },
              { name: 'restic-creds', mountPath: CREDS_MOUNT_PATH, readOnly: true },
            ],
          }],
          volumes: [
            { name: 'scratch', emptyDir: { sizeLimit: '50Gi' } },
            {
              name: 'restic-creds',
              secret: {
                secretName: input.credsSecretName,
                defaultMode: 0o400,
              },
            },
          ],
        },
      },
    },
  };
}

async function waitForJob(
  k8s: K8sClients,
  namespace: string,
  jobName: string,
  timeoutMs: number,
  onProgress?: (msg: string) => Promise<void> | void,
): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await (k8s.batch as unknown as {
      readNamespacedJob: (a: { name: string; namespace: string }) => Promise<{
        status?: {
          conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
          succeeded?: number;
          failed?: number;
        };
      }>;
    }).readNamespacedJob({ name: jobName, namespace });
    const status = job.status ?? {};
    const completed = (status.conditions ?? []).find((c) => c.type === 'Complete' && c.status === 'True');
    const failed = (status.conditions ?? []).find((c) => c.type === 'Failed' && c.status === 'True');
    if (completed || (status.succeeded ?? 0) > 0) return;
    if (failed || (status.failed ?? 0) > 0) {
      let logTail = '';
      try {
        const tail = await tailJobLog(k8s, namespace, jobName, { tailLines: 30, maxLineLength: 400 });
        if (tail) logTail = `; logs: ${tail.slice(-1200)}`;
      } catch { /* ignore */ }
      throw new Error(`mailboxes-by-address Job ${jobName} failed: ${failed?.message ?? 'unknown'}${logTail}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`mailboxes-by-address Job ${jobName} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (onProgress) {
      const tail = await tailJobLog(k8s, namespace, jobName, { tailLines: 5, maxLineLength: 200 }).catch(() => null);
      await onProgress(tail ? `mailboxes-restore: ${tail}` : 'Restoring mailboxes…');
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
}
