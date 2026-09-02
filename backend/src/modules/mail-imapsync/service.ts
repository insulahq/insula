/**
 * Phase 3 T2.1 — IMAPSync job runner service.
 *
 * One-shot Kubernetes Jobs that migrate mail from an external IMAP
 * server INTO an existing platform mailbox. Standard onboarding
 * path for customers coming from Gmail / Outlook / legacy hosting.
 *
 * Key design decisions (see plan + 0015 migration):
 *   - Source password encrypted at rest with PLATFORM_ENCRYPTION_KEY.
 *   - Per-job Kubernetes Secret holds source + dest passwords as
 *     env vars (envFrom) so they never appear in `args` or in
 *     `kubectl describe pod` output.
 *   - Destination uses Stalwart's `master` SSO via the
 *     `<mailbox>%master` user convention with MASTER_SECRET, so
 *     we never need the mailbox cleartext password.
 *   - Concurrency: enforced by a partial unique DB index
 *     `(mailbox_id) WHERE status IN ('pending','running')`. The
 *     application catches the unique violation and surfaces a 409
 *     IMAPSYNC_ALREADY_RUNNING — no race window between read and
 *     insert.
 */

import crypto from 'crypto';
import { eq, and, desc, inArray, lt, sql } from 'drizzle-orm';
import type { V1Job, V1Secret } from '@kubernetes/client-node';
import {
  imapSyncJobs,
  mailboxes,
  type ImapSyncJob,
} from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encrypt } from '../oidc/crypto.js';
import { notifyTenantImapsyncTerminal } from '../notifications/events.js';
import type { Database } from '../../db/index.js';
import type { CreateImapSyncJobInput, UpdateImapSyncJobInput, ImapSyncJobResponse } from '@insula/api-contracts';
import {
  MAX_ACTIVE_IMAPSYNC_JOBS,
  MAX_TOTAL_IMAPSYNC_JOBS,
  IMAPSYNC_JOB_RETENTION_DAYS,
} from '@insula/api-contracts';

// Pinned image — operators can override via STALWART_IMAPSYNC_IMAGE
// env var if they need a different mirror or local image.
// Pinned to a version tag, NOT `latest`. The previous comment here claimed
// "the Docker Hub image only publishes `latest` — there is no version-tagged
// release"; that was simply untrue (the repo carries 2.288 / 2.295 / 2.306 /
// 2.319, …), and on the strength of it every mail migration ran whatever
// `latest` happened to be that day.
//
// 2.319 is what `latest` resolved to on 2026-08-07 (verified by comparing
// manifest digests), so this pin changed no behaviour — it only made the
// behaviour reproducible. Bump deliberately after checking upstream release
// notes; imapsync moves fast and talks to tenant mailboxes.
export const DEFAULT_IMAPSYNC_IMAGE = 'gilleslamiral/imapsync:2.319';

// Stalwart's master principal password, as stored by bootstrap.sh in the
// `mail` namespace. The imapsync Job runs in that same namespace, so it
// reads the Secret DIRECTLY via secretKeyRef rather than having
// platform-api pull the cleartext into its own environment and copy it
// into the per-job Secret.
//
// This is the same wiring every other master-password consumer uses —
// backup-restore/executors/mailboxes-by-address.ts, tenant-bundles/
// components/mailboxes.ts and plesk-migration/mail-sync.ts. mail-imapsync
// was the lone exception: it read `STALWART_MASTER_SECRET` from
// process.env, and that variable was only ever set in the DinD overlay,
// so every non-local cluster failed the migration with
// `IMAPSYNC_NOT_CONFIGURED`.
export const MASTER_SECRET_NAME_DEFAULT = 'mail-secrets';
export const MASTER_SECRET_KEY_DEFAULT = 'STALWART_MASTER_PASSWORD';

// The master principal's FULL address (`master@<apex>`), not the bare
// `master` short name.
//
// Stalwart 0.16 master-proxy auth is `LOGIN <mailbox>%<master-principal>`,
// and the master principal MUST be the FQDN form. This module used to
// hardcode the literal string `master`, which Stalwart resolves against its
// own default domain — on a 2026-09-01 DinD run that produced
//   NO [AUTHENTICATIONFAILED] localhost.local
// and every migration failed at the destination login (exit 162,
// EXIT_AUTHENTICATION_FAILURE_USER2) AFTER transferring nothing. The dev
// mail-secrets manifest has carried a comment warning about exactly this
// since 2026-05-16; plesk-migration/mail-sync.ts passes the FQDN correctly.
//
// The value is per-cluster, so it comes from the same Secret as the
// password and is composed into `--user2` by the entrypoint shim.
export const MASTER_USER_SECRET_KEY_DEFAULT = 'STALWART_MASTER_USER';

// imapsync supports --passfile1 / --passfile2 to read passwords from
// a file. SOURCE_PASSWORD arrives via the per-job Secret (envFrom),
// DEST_PASSWORD via a secretKeyRef straight to `mail-secrets`; the
// container's command reads both from env into temp files before
// invoking imapsync. This matches the security guarantees in the plan:
// no passwords in `args`, no passwords in `kubectl describe`, no
// passwords on the imapsync command line visible to ps.
//
// `--user2` is composed HERE rather than in args because it needs
// DEST_MASTER_USER, which the kubelet resolves from `mail-secrets` at pod
// start — the manifest builder cannot know it. See the note on
// MASTER_USER_SECRET_KEY_DEFAULT for why the bare `master` short name
// does not work.
const IMAPSYNC_ENTRYPOINT = `
set -e
umask 077
if [ -z "$DEST_MASTER_USER" ]; then
  echo "FATAL: DEST_MASTER_USER is empty — mail-secrets/STALWART_MASTER_USER is unset or blank." >&2
  echo "       Stalwart master-proxy auth needs the FQDN form (master@<apex>)." >&2
  exit 78
fi
mkdir -p /tmp/imapsync
printf '%s' "$SOURCE_PASSWORD" > /tmp/imapsync/p1
printf '%s' "$DEST_PASSWORD"   > /tmp/imapsync/p2
exec imapsync \\
  --passfile1 /tmp/imapsync/p1 \\
  --passfile2 /tmp/imapsync/p2 \\
  --user2 "$DEST_MAILBOX%$DEST_MASTER_USER" \\
  "$@"
`.trim();

// ─── Special-folder name mapping ─────────────────────────────────────────
//
// Source servers name their spam folder whatever they like — `Spam`, `spam`,
// `Junk`, `junk`, `Junk E-mail` (Exchange/Outlook), `Bulk Mail` (older
// Netscape/Zimbra) — and Stalwart has exactly one. Without an explicit rule
// those all arrive as NEW top-level folders next to the real one, so the
// mailbox owner ends up with `junk` sitting beside `Spam` and their filters,
// their client's junk button and Stalwart's own classifier all pointing at
// the wrong place.
//
// `--automap` does not close this. It maps via RFC 6154 SPECIAL-USE plus a
// fixed internal name list, so it only fires when the SOURCE advertises the
// attribute (many IMAP servers, and every Maildir-derived migration, do not)
// and the name is one it recognises. Reported on 2026-09-02 with automap ON:
// `spam`, `Spam`, `Junk` and `junk` all failed to reach Stalwart's `Spam`.
//
// `--regextrans2` is applied to the computed DESTINATION folder name, after
// automap, so an explicit rule here wins. Anchored, with an optional
// `INBOX.`/`INBOX/` prefix for servers that namespace everything under INBOX
// (Courier, older Dovecot). Anchoring matters: an unanchored rule would also
// rewrite `Spam/2024-archive` and collapse a whole subtree onto one folder.
//
// WHY ONLY SPAM BY DEFAULT: a rule here OVERRIDES automap. Spam is the case
// that is confirmed broken and whose destination name is known. Guessing the
// destination names for Sent/Trash/Drafts/Archive would override an automap
// that may well be doing the right thing today, turning a reported bug into
// a regression across every migration. Add a group below once its
// destination name is confirmed on a real Stalwart — the table is the only
// thing that needs to change.

interface FolderAliasGroup {
  /** Destination folder on Stalwart. */
  readonly dest: string;
  /** Source names, matched case-insensitively against the whole folder name. */
  readonly aliases: readonly string[];
}

// Includes `junk mail`, which equals the default destination — that maps the
// folder onto itself, a harmless no-op, and keeps the list correct if an
// operator points `spamFolder` somewhere else.
export const SPAM_ALIASES: readonly string[] = [
  'spam',
  'junk',
  'junk e-mail',   // Outlook / Exchange
  'junk email',
  'junkmail',
  'junk mail',
  'bulk mail',     // Netscape / older Zimbra
  'bulk',
];

/** Escape a literal for embedding in a Perl regex alternation. */
function escapeForPerlRegex(literal: string): string {
  return literal.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
}

/**
 * Build one `--regextrans2` substitution mapping every alias to `dest`.
 *
 * `{}` delimiters avoid escaping the `/` that appears in hierarchy
 * separators; `i` makes the whole match case-insensitive, which is the
 * entire point — `spam`, `Spam` and `SPAM` are one folder, not three.
 */
export function buildFolderRemapExpression(group: FolderAliasGroup): string {
  const alternation = group.aliases.map(escapeForPerlRegex).join('|');
  return `s{^(?:INBOX[./])?(?:${alternation})$}{${group.dest}}i`;
}

/**
 * Default spam destination: Stalwart's own default junk folder NAME.
 *
 * VERIFIED, not assumed — `Mailbox/get` against a live Stalwart 0.16 returns
 * the default set as `Inbox` / `Sent Items` / `Junk Mail` (role `junk`) /
 * `Deleted Items` / `Drafts`. It is NOT called `Spam`; targeting `Spam` would
 * CREATE a new, role-less folder and deliver spam into it while the real junk
 * folder — the one the classifier and every mail client's junk button use —
 * stayed empty. That is strictly worse than leaving the source names alone.
 *
 * These names are Stalwart configuration and can differ per server, which is
 * why `options.spamFolder` exists. Confirm with:
 *   Mailbox/get {"properties":["name","role"]}  → the entry with role `junk`
 */
export const DEFAULT_SPAM_FOLDER = 'Junk Mail';

// ─── Pure manifest builders ──────────────────────────────────────────────

export interface BuildJobManifestInput {
  readonly jobId: string;
  readonly secretName: string;
  readonly namespace: string;
  /** Secret holding Stalwart's master password. Defaults to `mail-secrets`. */
  readonly masterSecretName?: string;
  /** Key within that Secret. Defaults to `STALWART_MASTER_PASSWORD`. */
  readonly masterSecretKey?: string;
  /** Key holding the master principal FQDN. Defaults to `STALWART_MASTER_USER`. */
  readonly masterUserSecretKey?: string;
  readonly mailboxAddress: string;
  readonly sourceHost: string;
  readonly sourcePort: number;
  readonly sourceUsername: string;
  readonly sourceSsl: boolean;
  readonly destHost: string;
  readonly destPort: number;
  readonly options: {
    readonly automap?: boolean;
    readonly noFolderSizes?: boolean;
    readonly dryRun?: boolean;
    readonly excludeFolders?: readonly string[];
    /**
     * Destination folder that every spam alias is folded into. Defaults to
     * `Spam`. Set it when a Stalwart is configured with a different name
     * (`Junk` is the other common choice) — an empty string disables the
     * remap entirely for an operator who wants imapsync's raw behaviour.
     */
    readonly spamFolder?: string;
  };
  readonly image: string;
}

export function buildJobManifest(input: BuildJobManifestInput): V1Job {
  const args: string[] = [
    '--host1', input.sourceHost,
    '--port1', String(input.sourcePort),
    '--user1', input.sourceUsername,
    '--host2', input.destHost,
    '--port2', String(input.destPort),
    // NOTE: `--user2` is NOT set here. Stalwart master-proxy auth needs
    // `<mailbox>%<master-principal-FQDN>`, and the FQDN only exists in
    // `mail-secrets` — the entrypoint shim composes it from DEST_MAILBOX
    // and DEST_MASTER_USER once the kubelet has resolved them.
    // Always disable telemetry / pings against the imapsync home
    // server even though the privately-hosted image generally has
    // them off.
    '--noreleasecheck',
    '--nofoldersizesatend',
  ];
  if (input.sourceSsl) args.push('--ssl1');
  if (input.options.automap) args.push('--automap');
  if (input.options.noFolderSizes) args.push('--nofoldersizes');
  if (input.options.dryRun) args.push('--dry');

  // Fold the source's spam-folder aliases onto Stalwart's single spam folder.
  // Emitted AFTER --automap so it wins; see SPAM_ALIASES above for why
  // automap alone does not cover this.
  const spamFolder = input.options.spamFolder ?? DEFAULT_SPAM_FOLDER;
  if (spamFolder) {
    args.push('--regextrans2', buildFolderRemapExpression({
      dest: spamFolder,
      aliases: SPAM_ALIASES,
    }));
  }

  for (const folder of input.options.excludeFolders ?? []) {
    args.push('--exclude', folder);
  }

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: `imapsync-${input.jobId}`,
      namespace: input.namespace,
      labels: {
        'app.kubernetes.io/name': 'imapsync',
        'app.kubernetes.io/managed-by': 'platform-api',
        'platform.io/job-id': input.jobId,
      },
    },
    spec: {
      backoffLimit: 0,
      // Auto-clean up after 1 hour past terminal state. Operator
      // can still grab logs from the DB row's `log_tail`.
      ttlSecondsAfterFinished: 3600,
      // IMAP Phase 4: wall-clock timeout. Without this a pod
      // stuck Pending (failed scheduling, ImagePullBackOff,
      // CrashLoopBackOff, etc.) would sit forever until an
      // operator manually cleaned it up. 2 hours is generous
      // enough for large mailbox migrations (imapsync typically
      // moves ~500 msg/min over fast links) but short enough
      // that a stuck job doesn't hold resources indefinitely.
      // When this deadline is exceeded the pod transitions to
      // Failed with reason `DeadlineExceeded` — which the
      // reconciler observes via `status.failed >= 1` and flips
      // the DB row to `failed` with the log tail attached.
      activeDeadlineSeconds: 7200,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'imapsync',
            'platform.io/job-id': input.jobId,
          },
        },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'imapsync',
              image: input.image,
              imagePullPolicy: 'IfNotPresent',
              // Override the image's default entrypoint with our
              // password-from-env shim. This keeps the cleartext
              // password out of `args`, out of `ps`, and out of
              // `kubectl describe`.
              command: ['sh', '-c', IMAPSYNC_ENTRYPOINT, '--'],
              args,
              // SOURCE_PASSWORD only — the per-job Secret never holds the
              // Stalwart master password.
              envFrom: [{ secretRef: { name: input.secretName } }],
              // DEST_PASSWORD is resolved by the kubelet from the `mail`
              // namespace's own Secret. An explicit `env` entry takes
              // precedence over `envFrom`, so this is authoritative even
              // if a stale per-job Secret still carries the key.
              //
              // `optional: false` is deliberate: a missing Secret must fail
              // the pod loudly rather than run imapsync with an empty
              // destination password and report a confusing auth error.
              env: [
                {
                  name: 'DEST_PASSWORD',
                  valueFrom: {
                    secretKeyRef: {
                      name: input.masterSecretName ?? MASTER_SECRET_NAME_DEFAULT,
                      key: input.masterSecretKey ?? MASTER_SECRET_KEY_DEFAULT,
                      optional: false,
                    },
                  },
                },
                // The master principal's FQDN, same Secret. Composed with
                // DEST_MAILBOX into `--user2` by the entrypoint.
                {
                  name: 'DEST_MASTER_USER',
                  valueFrom: {
                    secretKeyRef: {
                      name: input.masterSecretName ?? MASTER_SECRET_NAME_DEFAULT,
                      key: input.masterUserSecretKey ?? MASTER_USER_SECRET_KEY_DEFAULT,
                      optional: false,
                    },
                  },
                },
                // Not a secret — the mailbox being migrated INTO.
                { name: 'DEST_MAILBOX', value: input.mailboxAddress },
              ],
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: '500m', memory: '512Mi' },
              },
            },
          ],
        },
      },
    },
  };
}

export interface BuildJobSecretInput {
  readonly jobId: string;
  readonly namespace: string;
  readonly sourcePassword: string;
}

export function buildJobSecret(input: BuildJobSecretInput): V1Secret {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: `imapsync-${input.jobId}`,
      namespace: input.namespace,
      labels: {
        'app.kubernetes.io/name': 'imapsync',
        'app.kubernetes.io/managed-by': 'platform-api',
        'platform.io/job-id': input.jobId,
      },
    },
    stringData: {
      // The user's password on the SOURCE (third-party) server only.
      // The Stalwart master password is never written here — the Job
      // reads it straight from `mail-secrets` via secretKeyRef.
      SOURCE_PASSWORD: input.sourcePassword,
    },
  };
}

// ─── DB-side service helpers ─────────────────────────────────────────────

function rowToResponse(row: ImapSyncJob): ImapSyncJobResponse {
  return {
    id: row.id,
    tenantId: row.tenantId,
    mailboxId: row.mailboxId,
    sourceHost: row.sourceHost,
    sourcePort: row.sourcePort,
    sourceUsername: row.sourceUsername,
    sourceSsl: row.sourceSsl === 1,
    options: (row.options ?? {}) as Record<string, unknown>,
    status: row.status as ImapSyncJobResponse['status'],
    k8sJobName: row.k8sJobName,
    k8sNamespace: row.k8sNamespace,
    logTail: row.logTail,
    errorMessage: row.errorMessage,
    // Round-4 Phase 3: progress columns from migration 0022.
    messagesTotal: row.messagesTotal ?? null,
    messagesTransferred: row.messagesTransferred ?? null,
    currentFolder: row.currentFolder ?? null,
    summary: row.summary ?? null,
    lastProgressAt: row.lastProgressAt ? row.lastProgressAt.toISOString() : null,
    // IMAP Phase 3: pod-level observability from migration 0023.
    podPhase: row.podPhase ?? null,
    podMessage: row.podMessage ?? null,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Create a new pending IMAPSync job for a tenant's mailbox.
 *
 * Validates that the mailbox actually belongs to the tenant to
 * prevent cross-tenant access. Encrypts the source password at
 * rest. Returns the new row (passwords stripped).
 */
export async function createImapSyncJob(
  db: Database,
  encryptionKey: string,
  tenantId: string,
  input: CreateImapSyncJobInput,
): Promise<ImapSyncJobResponse> {
  // Ownership check
  const [mb] = await db
    .select({
      id: mailboxes.id,
      tenantId: mailboxes.tenantId,
      fullAddress: mailboxes.fullAddress,
      mailboxType: mailboxes.mailboxType,
    })
    .from(mailboxes)
    .where(eq(mailboxes.id, input.mailbox_id));
  if (!mb || mb.tenantId !== tenantId) {
    throw new ApiError(
      'MAILBOX_NOT_FOUND',
      `Mailbox '${input.mailbox_id}' not found for tenant '${tenantId}'`,
      404,
    );
  }
  // A send-only account has no store and IMAP access is disabled — an
  // imapsync migration INTO it can never deliver.
  if (mb.mailboxType === 'send_only') {
    throw new ApiError(
      'SEND_ONLY_MAILBOX',
      'This is a send-only account — it cannot be the target of an IMAP migration',
      409,
      { mailbox_id: input.mailbox_id },
      'Create a normal mailbox as the migration target',
    );
  }

  const id = crypto.randomUUID();
  const now = new Date();
  try {
    const [row] = await db
      .insert(imapSyncJobs)
      .values({
        id,
        tenantId,
        mailboxId: input.mailbox_id,
        sourceHost: input.source_host,
        sourcePort: input.source_port,
        sourceUsername: input.source_username,
        sourcePasswordEncrypted: encrypt(input.source_password, encryptionKey),
        sourceSsl: input.source_ssl ? 1 : 0,
        options: input.options ?? {},
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToResponse(row as ImapSyncJob);
  } catch (err: unknown) {
    const pgErr = err as { code?: string; message?: string };
    if (pgErr.code === '23505') {
      throw new ApiError(
        'IMAPSYNC_ALREADY_RUNNING',
        'Another IMAPSync job is already pending or running for this mailbox',
        409,
      );
    }
    throw err;
  }
}

/**
 * List IMAPSync jobs for a tenant, newest first. Capped at 100.
 * Passwords stripped before returning.
 */
export async function listImapSyncJobs(
  db: Database,
  tenantId: string,
): Promise<readonly ImapSyncJobResponse[]> {
  const rows = await db
    .select()
    .from(imapSyncJobs)
    .where(eq(imapSyncJobs.tenantId, tenantId))
    .orderBy(desc(imapSyncJobs.createdAt))
    .limit(100);
  return rows.map(rowToResponse);
}

/**
 * Get a single IMAPSync job by id, scoped to a tenant. Returns null
 * if the job doesn't exist or belongs to a different tenant.
 */
export async function getImapSyncJob(
  db: Database,
  tenantId: string,
  jobId: string,
): Promise<ImapSyncJobResponse | null> {
  const [row] = await db
    .select()
    .from(imapSyncJobs)
    .where(and(eq(imapSyncJobs.id, jobId), eq(imapSyncJobs.tenantId, tenantId)));
  return row ? rowToResponse(row as ImapSyncJob) : null;
}

/**
 * Mark a job as cancelled in the DB. The K8s Job + Secret cleanup
 * happens in the routes layer (since it needs the K8s tenant
 * handle). Returns the updated row or null if the job is already
 * terminal.
 */
export async function markCancelled(
  db: Database,
  jobId: string,
): Promise<void> {
  // Look up tenantId first so we can notify after the DB write.
  const [row] = await db
    .select({ tenantId: imapSyncJobs.tenantId })
    .from(imapSyncJobs)
    .where(eq(imapSyncJobs.id, jobId));

  await db
    .update(imapSyncJobs)
    .set({
      status: 'cancelled',
      finishedAt: new Date(),
    })
    .where(eq(imapSyncJobs.id, jobId));

  if (row?.tenantId) {
    void notifyTenantImapsyncTerminal(db, row.tenantId, {
      jobId,
      status: 'cancelled',
    });
  }
}

/**
 * Mark a pending job as running and record the K8s Job name.
 */
export async function markRunning(
  db: Database,
  jobId: string,
  k8sJobName: string,
): Promise<void> {
  await db
    .update(imapSyncJobs)
    .set({
      status: 'running',
      k8sJobName,
      startedAt: new Date(),
    })
    .where(eq(imapSyncJobs.id, jobId));
}

/**
 * Round-4 Phase 1: delete a terminal IMAPSync job row.
 *
 * Only allowed for jobs in `succeeded`, `failed`, or `cancelled`
 * status. Active jobs must be cancelled first via the existing
 * DELETE cancel endpoint. Returns the deleted row's identifying
 * info (tenantId, status, k8sJobName, k8sNamespace) so the caller
 * can clean up any K8s residue without re-querying the DB. Returns
 * null if the row doesn't exist.
 *
 * Review HIGH-3 fix: previously the route called getImapSyncJob
 * THEN this function, both reading the same row. Returning the K8s
 * coordinates here lets the route skip the outer fetch and closes
 * the TOCTOU window between the two reads.
 */
export async function deleteTerminalJob(
  db: Database,
  tenantId: string,
  jobId: string,
): Promise<{
  tenantId: string;
  status: string;
  k8sJobName: string | null;
  k8sNamespace: string;
} | null> {
  const [row] = await db
    .select({
      tenantId: imapSyncJobs.tenantId,
      status: imapSyncJobs.status,
      k8sJobName: imapSyncJobs.k8sJobName,
      k8sNamespace: imapSyncJobs.k8sNamespace,
    })
    .from(imapSyncJobs)
    .where(and(eq(imapSyncJobs.id, jobId), eq(imapSyncJobs.tenantId, tenantId)));
  if (!row) return null;
  if (row.status !== 'succeeded' && row.status !== 'failed' && row.status !== 'cancelled') {
    throw new ApiError(
      'INVALID_STATE',
      `Cannot delete IMAPSync job in '${row.status}' state — cancel it first`,
      409,
      { status: row.status },
    );
  }
  await db.delete(imapSyncJobs).where(eq(imapSyncJobs.id, jobId));
  return {
    tenantId: row.tenantId,
    status: row.status,
    k8sJobName: row.k8sJobName,
    k8sNamespace: row.k8sNamespace,
  };
}

/**
 * Re-sync a terminal IMAPSync job by resetting it in-place. Clears
 * all progress/log/error fields and sets status back to 'pending'.
 * Reuses the same row ID. Returns the raw row for K8s Job creation.
 *
 * Concurrency check: the partial unique index on mailbox_id WHERE
 * status IN ('pending','running') prevents a resync if another job
 * is already active for the same mailbox.
 */
export async function resyncImapSyncJob(
  db: Database,
  tenantId: string,
  jobId: string,
): Promise<ImapSyncJob> {
  const [original] = await db
    .select()
    .from(imapSyncJobs)
    .where(and(eq(imapSyncJobs.id, jobId), eq(imapSyncJobs.tenantId, tenantId)));
  if (!original) {
    throw new ApiError(
      'IMAPSYNC_JOB_NOT_FOUND',
      `IMAPSync job '${jobId}' not found for tenant '${tenantId}'`,
      404,
    );
  }
  if (
    original.status !== 'succeeded'
    && original.status !== 'failed'
    && original.status !== 'cancelled'
  ) {
    throw new ApiError(
      'INVALID_STATE',
      `Cannot re-sync a job in '${original.status}' state — wait for it to finish or cancel it first`,
      409,
      { status: original.status },
    );
  }

  // Check active job limit per tenant
  await enforceActiveJobLimit(db, tenantId);

  const now = new Date();
  const newK8sJobName = `imapsync-${jobId}-${now.getTime()}`;
  const [row] = await db
    .update(imapSyncJobs)
    .set({
      status: 'pending',
      k8sJobName: newK8sJobName,
      logTail: null,
      errorMessage: null,
      messagesTotal: null,
      messagesTransferred: null,
      currentFolder: null,
      // The previous run's outcome must not survive into the new one — a
      // stale "Transferred 4 messages" beside a running job is worse than
      // no summary at all.
      summary: null,
      lastProgressAt: null,
      podPhase: null,
      podMessage: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    })
    .where(eq(imapSyncJobs.id, jobId))
    .returning();
  return row as ImapSyncJob;
}

/**
 * Enforce the per-tenant active job limit. Throws 429 if the
 * tenant already has MAX_ACTIVE_IMAPSYNC_JOBS pending/running.
 */
export async function enforceActiveJobLimit(
  db: Database,
  tenantId: string,
): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(imapSyncJobs)
    .where(
      and(
        eq(imapSyncJobs.tenantId, tenantId),
        inArray(imapSyncJobs.status, ['pending', 'running']),
      ),
    );
  if (count >= MAX_ACTIVE_IMAPSYNC_JOBS) {
    throw new ApiError(
      'IMAPSYNC_ACTIVE_LIMIT',
      `Maximum ${MAX_ACTIVE_IMAPSYNC_JOBS} active sync jobs per tenant`,
      429,
    );
  }
}

/**
 * Enforce the per-tenant total job limit. Throws 429 if the tenant
 * already has MAX_TOTAL_IMAPSYNC_JOBS rows.
 */
export async function enforceTotalJobLimit(
  db: Database,
  tenantId: string,
): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(imapSyncJobs)
    .where(eq(imapSyncJobs.tenantId, tenantId));
  if (count >= MAX_TOTAL_IMAPSYNC_JOBS) {
    throw new ApiError(
      'IMAPSYNC_TOTAL_LIMIT',
      `Maximum ${MAX_TOTAL_IMAPSYNC_JOBS} sync jobs per tenant — delete old jobs to create new ones`,
      429,
    );
  }
}

/**
 * Update a terminal job's source settings. Only allowed for jobs
 * in succeeded/failed/cancelled status. Re-encrypts the password
 * if provided.
 */
export async function updateImapSyncJob(
  db: Database,
  encryptionKey: string,
  tenantId: string,
  jobId: string,
  input: UpdateImapSyncJobInput,
): Promise<ImapSyncJobResponse> {
  const [row] = await db
    .select()
    .from(imapSyncJobs)
    .where(and(eq(imapSyncJobs.id, jobId), eq(imapSyncJobs.tenantId, tenantId)));
  if (!row) {
    throw new ApiError('IMAPSYNC_JOB_NOT_FOUND', 'IMAPSync job not found', 404);
  }
  if (row.status !== 'succeeded' && row.status !== 'failed' && row.status !== 'cancelled') {
    throw new ApiError(
      'INVALID_STATE',
      `Cannot edit a job in '${row.status}' state — wait for it to finish or cancel it first`,
      409,
    );
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.source_host !== undefined) updates.sourceHost = input.source_host;
  if (input.source_port !== undefined) updates.sourcePort = input.source_port;
  if (input.source_username !== undefined) updates.sourceUsername = input.source_username;
  if (input.source_password !== undefined) {
    updates.sourcePasswordEncrypted = encrypt(input.source_password, encryptionKey);
  }
  if (input.source_ssl !== undefined) updates.sourceSsl = input.source_ssl ? 1 : 0;
  if (input.options !== undefined) updates.options = input.options;

  const [updated] = await db
    .update(imapSyncJobs)
    .set(updates)
    .where(eq(imapSyncJobs.id, jobId))
    .returning();
  return rowToResponse(updated as ImapSyncJob);
}

/**
 * Delete terminal jobs older than IMAPSYNC_JOB_RETENTION_DAYS.
 * Returns the number of rows deleted.
 */
export async function cleanupExpiredJobs(db: Database): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - IMAPSYNC_JOB_RETENTION_DAYS);

  const deleted = await db
    .delete(imapSyncJobs)
    .where(
      and(
        inArray(imapSyncJobs.status, ['succeeded', 'failed', 'cancelled']),
        lt(imapSyncJobs.finishedAt, cutoff),
      ),
    )
    .returning({ id: imapSyncJobs.id });
  return deleted.length;
}

/**
 * Mark a job as failed with an optional error message and log
 * tail. Used by the start flow if the K8s Job creation itself
 * fails.
 */
export async function markFailed(
  db: Database,
  jobId: string,
  errorMessage: string,
): Promise<void> {
  const [row] = await db
    .select({ tenantId: imapSyncJobs.tenantId })
    .from(imapSyncJobs)
    .where(eq(imapSyncJobs.id, jobId));

  await db
    .update(imapSyncJobs)
    .set({
      status: 'failed',
      errorMessage,
      finishedAt: new Date(),
    })
    .where(eq(imapSyncJobs.id, jobId));

  if (row?.tenantId) {
    void notifyTenantImapsyncTerminal(db, row.tenantId, {
      jobId,
      status: 'failed',
      errorMessage,
    });
  }
}
