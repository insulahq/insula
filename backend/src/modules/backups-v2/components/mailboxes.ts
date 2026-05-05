/**
 * `mailboxes` component capture (Phase 3 closer).
 *
 * Per BACKUP_COMPONENT_MODEL.md:
 *   components/mailboxes/<address>.mbox.tar.gz   — per-mailbox export
 *
 * Pattern (mirrors files-component):
 *
 *   1. Resolve every mailbox address belonging to the client from
 *      the platform DB (mailboxes.client_id direct FK).
 *   2. Sign a per-mailbox HMAC upload token bound to
 *      (bundleId, 'mailboxes', '<address>.mbox.tar.gz').
 *   3. Spawn a single Job in the `mail` namespace using the Stalwart
 *      image (which ships `stalwart-cli`). The Job script loops
 *      every address, runs `stalwart-cli account export` against the
 *      Stalwart management API on http://stalwart-mail-v016.mail:8080
 *      (HTTP-Basic with the recoveryAdmin Secret), gzips, then
 *      `curl --upload-file` to platform-api's internal upload route.
 *   4. Each upload is authorised by its own short-lived HMAC token —
 *      a leaked token can only overwrite that one address's artifact.
 *   5. Tokens are passed via env vars (one per address) so they do
 *      NOT appear in the script body that's visible in pod spec.
 *
 * Why a Job (not in-process from platform-api):
 *   - stalwart-cli does the heavy lifting (mbox tarball assembly).
 *   - The Stalwart admin creds stay in the `mail` namespace —
 *     platform-api never sees them.
 *   - Same NetworkPolicy rule (`platform.io/component: backup-files`)
 *     covers this Job too if we use the same label, OR we can split
 *     to `backup-mailboxes` for finer auditing. Going with the same
 *     label for Phase 3 — one rule, less churn.
 *
 * Failure modes:
 *   - If a single mailbox export fails the whole Job fails (set -e).
 *     Phase 3.x can split this into per-address sub-Jobs for better
 *     partial-success reporting; for now, fail loudly.
 *   - If a mailbox is empty, stalwart-cli still produces a tarball
 *     (just with no .eml files). That's a valid artefact.
 */

import { sql } from 'drizzle-orm';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { Database } from '../../../db/index.js';
import type { BackupStore, BundleHandle } from '../bundle-store.js';
import { tailJobLog } from '../../storage-lifecycle/job-log-tail.js';
import { signUploadToken } from '../upload-token.js';

export interface MailboxesComponentResult {
  readonly mailboxCount: number;
  readonly addresses: ReadonlyArray<string>;
  /** Total bytes across all mbox.tar.gz artefacts. */
  readonly sizeBytes: number;
}

export interface CaptureMailboxesComponentOpts {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly clientId: string;
  readonly backupId: string;
  readonly store: BackupStore;
  readonly handle: BundleHandle;
  readonly platformApiUrl: string;
  readonly secretsKeyHex: string;
  readonly mailNamespace?: string; // defaults to 'mail'
  readonly stalwartImage?: string;  // defaults to docker.io/stalwartlabs/stalwart:v0.16.3
  readonly jobImage?: string;        // image used for the wrapper Job (alpine + curl)
  readonly stalwartMgmtUrl?: string; // defaults to http://stalwart-mail-v016.mail.svc.cluster.local:8080
  readonly timeoutMs?: number;
  readonly onProgress?: (msg: string) => Promise<void> | void;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const UPLOAD_TOKEN_TTL_SEC = 30 * 60;
const MAIL_NAMESPACE = 'mail';
const STALWART_MGMT_URL_DEFAULT = 'http://stalwart-mail-v016.mail.svc.cluster.local:8080';
const STALWART_IMAGE_DEFAULT = 'docker.io/stalwartlabs/stalwart:v0.16.3';

/**
 * Resolve the addresses of every mailbox owned by the client.
 *
 * Mailboxes table has a direct client_id column (audited 2026-05-02
 * in CONFIG_DUMP_TABLES). Returns sorted-by-address for stable
 * iteration order across runs.
 */
export async function listClientMailboxAddresses(db: Database, clientId: string): Promise<string[]> {
  const rawDb = db as unknown as { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: { address: string }[] }> };
  const r = await rawDb.execute(sql`SELECT address FROM mailboxes WHERE client_id = ${clientId} ORDER BY address`);
  return r.rows.map((row) => row.address);
}

/** Validate an address before letting it into a shell command. */
function isSafeAddress(address: string): boolean {
  // RFC-style local + domain. Forbid shell metacharacters;
  // allow `+` for sub-addressing.
  return /^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+$/.test(address);
}

/**
 * Build the K8s Job spec for the mailboxes-component capture.
 *
 * Pure function — exposed so unit tests can assert on the spec
 * without a kube client.
 */
export function buildMailboxesComponentJobSpec(input: {
  jobName: string;
  mailNamespace: string;
  clientId: string;
  backupId: string;
  jobImage: string;
  stalwartMgmtUrl: string;
  uploadBase: string;
  /** [{ address, token }] — one per mailbox. */
  uploads: ReadonlyArray<{ address: string; token: string }>;
}): Record<string, unknown> {
  // Reject any unsafe address before composing the script — prevents
  // a malformed address from breaking out of the for-loop into a
  // shell injection. Addresses come from the platform DB, but
  // defence-in-depth is cheap.
  for (const u of input.uploads) {
    if (!isSafeAddress(u.address)) {
      throw new Error(`buildMailboxesComponentJobSpec: invalid address '${u.address}'`);
    }
  }
  // Env vars carry the tokens (one per address) so they don't sit in
  // the script body that's visible via `kubectl get pod -o yaml`.
  const tokenEnvVars = input.uploads.map((u, i) => ({
    name: `MAILBOX_TOKEN_${i}`,
    value: u.token,
  }));
  const addressEnvVars = input.uploads.map((u, i) => ({
    name: `MAILBOX_ADDR_${i}`,
    value: u.address,
  }));
  const stalwartCredsEnv = [
    {
      name: 'STALWART_RECOVERY_ADMIN',
      valueFrom: {
        secretKeyRef: {
          name: 'stalwart-admin-creds',
          key: 'recoveryAdmin',
          optional: false,
        },
      },
    },
  ];

  // We use the Stalwart image itself as the Job container — it ships
  // `stalwart-cli`, the upstream-documented path for mailbox export.
  // (An earlier draft tried to call the HTTP management API directly,
  // but the exact endpoint shape varies between Stalwart minor
  // versions; using stalwart-cli is forward-compatible since the CLI
  // adapts to whichever API the running server speaks.)
  //
  // Stalwart's image is Debian-based — install curl via apt-get for
  // the upload step. Two-stage per address: cli writes a tarball to
  // /tmp/$ADDR.tar.gz, then curl --upload-file streams it to the
  // platform-api internal upload endpoint.
  //
  // The `STALWART_RECOVERY_ADMIN` Secret already holds the value
  // `admin:<password>` (see k8s/base/stalwart-v016/stalwart/deployment.yaml
  // line 144) — we pass it directly to `stalwart-cli -c`.
  //
  // KNOWN GAP (matches files.ts): if this Job already exists from a
  // prior orchestrator run that crashed mid-bundle, createNamespacedJob
  // will 409. We don't tolerate 409 here; the Job's
  // ttlSecondsAfterFinished=600 means the dead Job is GC'd within
  // 10 min and a fresh bundle attempt succeeds. Phase 4.x will
  // factor a 409-tolerant Job-spawn helper.
  const script = [
    'set -e',
    'command -v curl >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq curl) >/dev/null 2>&1 || { echo "ERROR: curl install failed"; exit 1; }',
    'command -v stalwart-cli >/dev/null 2>&1 || { echo "ERROR: stalwart-cli not on PATH (wrong base image?)"; exit 1; }',
    'COUNT=' + input.uploads.length,
    'mkdir -p /tmp/mboxes',
    'for i in $(seq 0 $((COUNT - 1))); do',
    '  ADDR_VAR="MAILBOX_ADDR_$i"',
    '  TOKEN_VAR="MAILBOX_TOKEN_$i"',
    '  ADDR=$(eval echo \\$$ADDR_VAR)',
    '  TOKEN=$(eval echo \\$$TOKEN_VAR)',
    '  echo "Exporting mailbox $ADDR (#$i)..."',
    // stalwart-cli account export <addr> writes a tarball at the
    // given path (one tarball per account, gzipped). The CLI uses
    // the management API internally and adapts to whatever endpoint
    // shape the server speaks.
    `  stalwart-cli -u "${input.stalwartMgmtUrl}" -c "$STALWART_RECOVERY_ADMIN" \\
       account export "$ADDR" "/tmp/mboxes/$ADDR.tar.gz"`,
    '  echo "Uploading $ADDR.tar.gz..."',
    `  curl --fail-with-body -sS --upload-file "/tmp/mboxes/$ADDR.tar.gz" \\
       -H "Content-Type: application/gzip" \\
       "${input.uploadBase}/$ADDR.mbox.tar.gz?token=$TOKEN"`,
    '  rm -f "/tmp/mboxes/$ADDR.tar.gz"', // free disk before next mailbox
    '  echo "MAILBOX_DONE addr=$ADDR"',
    'done',
    'echo "MAILBOXES_TOTAL=$COUNT"',
  ].join('\n');

  return {
    metadata: {
      name: input.jobName,
      namespace: input.mailNamespace,
      labels: {
        // Reuse the backup-files label so the existing NetworkPolicy
        // (allow-backup-files-jobs-to-platform-api) covers this Job
        // too. Phase 3.x can split if per-component auditing matters.
        'platform.io/component': 'backup-files',
        'platform.io/client-id': input.clientId,
        'platform.io/backup-id': input.backupId,
        'platform.io/sub-component': 'backup-mailboxes',
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            'platform.io/component': 'backup-files',
            'platform.io/client-id': input.clientId,
            'platform.io/backup-id': input.backupId,
            'platform.io/sub-component': 'backup-mailboxes',
          },
        },
        spec: {
          restartPolicy: 'Never',
          // Mail namespace doesn't have the platform-tenant-overhead
          // priority class registered. Use the system default.
          containers: [{
            name: 'mailboxes',
            image: input.jobImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', script],
            env: [...stalwartCredsEnv, ...addressEnvVars, ...tokenEnvVars],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '500m', memory: '512Mi' },
            },
          }],
        },
      },
    },
  };
}

/**
 * Capture the `mailboxes` component.
 *
 * Resolves the client's mailboxes from the DB, signs one HMAC token
 * per mailbox, spawns the Job, polls until done. After the Job
 * returns we sum sizes via BackupStore.listArtifacts (the Job emitted
 * each artefact and the store reports their canonical sizes).
 *
 * Returns sizeBytes=0 + addresses=[] if the client has no mailboxes
 * (no Job spawned). The orchestrator marks the component `completed`
 * with mailboxCount=0 in that case — meaningful "we checked and there
 * was nothing to back up" rather than "we forgot to do this".
 */
export async function captureMailboxesComponent(
  opts: CaptureMailboxesComponentOpts,
): Promise<MailboxesComponentResult> {
  const addresses = await listClientMailboxAddresses(opts.db, opts.clientId);
  if (addresses.length === 0) {
    return { mailboxCount: 0, addresses: [], sizeBytes: 0 };
  }

  const uploads = addresses.map((address) => ({
    address,
    token: signUploadToken(
      { bundleId: opts.backupId, component: 'mailboxes', artifactName: `${address}.mbox.tar.gz`, ttlSeconds: UPLOAD_TOKEN_TTL_SEC },
      opts.secretsKeyHex,
    ),
  }));

  const mailNamespace = opts.mailNamespace ?? MAIL_NAMESPACE;
  const stalwartMgmtUrl = opts.stalwartMgmtUrl ?? STALWART_MGMT_URL_DEFAULT;
  const uploadBase = `${opts.platformApiUrl.replace(/\/$/, '')}/api/v1/internal/bundles/${opts.backupId}/components/mailboxes`;
  const jobName = `bk-mbox-${opts.backupId}`.slice(0, 63);

  // Use the Stalwart image (which ships stalwart-cli) as the Job
  // container. Operators can override via opts.jobImage but the
  // default is the same v0.16.3 image the cluster's Stalwart pod
  // runs — keeps the cli/server versions aligned automatically.
  const spec = buildMailboxesComponentJobSpec({
    jobName,
    mailNamespace,
    clientId: opts.clientId,
    backupId: opts.backupId,
    jobImage: opts.jobImage ?? opts.stalwartImage ?? STALWART_IMAGE_DEFAULT,
    stalwartMgmtUrl,
    uploadBase,
    uploads,
  });

  await (opts.k8s.batch as unknown as {
    createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: mailNamespace, body: spec });

  await waitForJob(opts.k8s, mailNamespace, jobName, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.onProgress);

  // Sum sizes via BackupStore.listArtifacts.
  const refs = await opts.store.listArtifacts(opts.handle, 'mailboxes');
  const sizeBytes = refs.reduce((s, r) => s + r.sizeBytes, 0);

  return {
    mailboxCount: addresses.length,
    addresses,
    sizeBytes,
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
      throw new Error(`mailboxes-component Job ${jobName} failed: ${failed?.message ?? 'unknown'}`);
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
