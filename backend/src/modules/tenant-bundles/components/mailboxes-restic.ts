/**
 * Restic-native mailbox capture (ADR-061).
 *
 * Replaces the tar-stream transport this component was the last user of:
 * the Job used to `tar cf - .` a whole-tenant Maildir tree into
 * platform-api's `restic backup --stdin`. Two things changed on every file
 * on every run — the filename (prefixed with the capture clock) and the tar
 * header mtime — so each altered 512-byte header landed inside a
 * content-defined chunk and only the interiors of large attachments
 * deduplicated. Production measured 8.2 GB of `data_added_packed` per night
 * against a mailbox whose real growth was single-digit MB.
 *
 * The Job now runs `restic backup` itself, once per mailbox, exactly as
 * `components/files.ts` has since its own restic-native rewrite. restic
 * deduplicates per FILE CONTENT, so a re-captured message costs a tree entry
 * rather than its bytes — measured on DEV against real Stalwart, night two
 * added 1.6 MB where the tar stream added 68.0 MB.
 *
 * One snapshot per mailbox, not one per tenant:
 *   - peak scratch becomes the LARGEST MAILBOX rather than the whole
 *     tenant's mail, because each address's tree is deleted before the next
 *     one is captured;
 *   - restoring one mailbox restores one snapshot, instead of fetching the
 *     whole-tenant tarball and extracting it twice (~31 GB of scratch to
 *     restore one mailbox of a 15 GB tenant);
 *   - `backup_components` already keys on (backup_job_id, component,
 *     artifact_name), so one row per address needs no schema change.
 *
 * Capture root is `/capture/<address>` — a dedicated emptyDir, NOT `/tmp`,
 * so the snapshot's stored paths are stable and meaningful and restic's
 * cache cannot share a size limit with the mail tree.
 */

import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';

/** Where the Maildir tree for the mailbox being captured is written. */
export const MAILBOX_CAPTURE_ROOT = '/capture';

/** Mount path of the per-Job restic creds Secret (mirrors files.ts). */
export const CREDS_MOUNT_PATH = '/var/run/restic-creds';

/**
 * Mirror of `_safe_filename()` in `images/tenant-backup-tools/imap-sync.py`,
 * which is what actually names the per-address directory. Kept as an explicit
 * copy rather than an assumption: `isSafeAddress` admits `+` in the local
 * part, and the python sanitiser rewrites it to `_`, so the address and its
 * directory name are NOT always the same string.
 */
export function addressDirName(address: string): string {
  return address.replace(/[^A-Za-z0-9._@-]/g, '_');
}

/** POSIX single-quote for embedding a whitelisted value in the Job shell. */
function shQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}


// ── Defence-in-depth input validation ──────────────────────────────────────
// Every value below is interpolated into the Job's shell script. Addresses
// come from the platform DB and the endpoints from config, so these are not
// the primary control — they are the one that still holds if a row or a
// setting is ever poisoned.

function isSafeAddress(address: string): boolean {
  return /^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+$/.test(address);
}

function isSafeJmapEndpoint(url: string): boolean {
  return /^https?:\/\/[A-Za-z0-9.\-]+(:\d+)?(\/[A-Za-z0-9._\-/]*)?$/.test(url);
}

function isSafeMasterUser(user: string): boolean {
  return /^[A-Za-z0-9._\-]+(@[A-Za-z0-9.\-]+)?$/.test(user);
}

function assertCaptureInputs(input: {
  addresses: ReadonlyArray<string>;
  jmapEndpoint: string;
  imapHost: string;
  imapPort: number;
  stalwartMasterUser: string;
  tenantId: string;
}): void {
  for (const a of input.addresses) {
    if (!isSafeAddress(a)) {
      throw new Error(`mailboxes-restic: invalid address '${a}'`);
    }
  }
  if (!isSafeJmapEndpoint(input.jmapEndpoint)) {
    throw new Error(`mailboxes-restic: invalid jmapEndpoint '${input.jmapEndpoint}'`);
  }
  if (!isSafeMasterUser(input.stalwartMasterUser)) {
    throw new Error(`mailboxes-restic: invalid stalwartMasterUser '${input.stalwartMasterUser}'`);
  }
  if (!/^[A-Za-z0-9.\-]+$/.test(input.imapHost)) {
    throw new Error(`mailboxes-restic: invalid imapHost '${input.imapHost}'`);
  }
  if (!Number.isInteger(input.imapPort) || input.imapPort < 1 || input.imapPort > 65535) {
    throw new Error(`mailboxes-restic: invalid imapPort ${input.imapPort}`);
  }
  // The tenant id becomes restic's --host; it must not be able to inject a flag.
  if (!/^[A-Za-z0-9._-]+$/.test(input.tenantId)) {
    throw new Error(`mailboxes-restic: invalid tenantId '${input.tenantId}'`);
  }
}

export interface MailboxCaptureResult {
  readonly address: string;
  readonly snapshotId: string;
  readonly sizeBytes: number;
  /** `data_added_packed`; null when restic did not report it. */
  readonly dataAddedPacked: number | null;
  readonly messageCount: number;
}

export interface BuildMailboxesResticJobSpecInput {
  readonly jobName: string;
  readonly mailNamespace: string;
  readonly tenantId: string;
  readonly backupId: string;
  readonly toolsImage: string;
  /** 'imap' (default) or 'jmap' — selects the per-address capture script. */
  readonly engine: 'imap' | 'jmap';
  readonly jmapEndpoint: string;
  readonly imapHost: string;
  readonly imapPort: number;
  readonly stalwartMasterUser: string;
  readonly masterSecretName: string;
  readonly masterSecretKey: string;
  /** Per-Job Secret holding restic_password / aws_* / repo_uri. */
  readonly credsSecretName: string;
  /** Snapshot tags shared by every mailbox in this bundle. */
  readonly tags: ReadonlyArray<string>;
  readonly addresses: ReadonlyArray<string>;
  readonly activeDeadlineSeconds?: number;
  /** emptyDir sizeLimit for the Maildir tree. Defaults to 50Gi. */
  readonly captureSizeLimit?: string;
}

/**
 * Per-address capture + snapshot + delete, as a POSIX shell script.
 *
 * `--host` is set to the tenant id. Without it restic defaults to the POD
 * hostname, which changes on every Job, so no parent snapshot is ever matched
 * and restic re-reads and re-hashes every file even when it stores none of
 * them. (The files component has the same omission and pays the same cost.)
 *
 * `--ignore-inode --ignore-ctime` are required alongside it: the tree is
 * rebuilt in a fresh pod each run, so inode numbers and ctimes always differ
 * even when the message and its mtime do not.
 */
export function buildMailboxesCaptureScript(input: {
  addresses: ReadonlyArray<string>;
  tenantId: string;
  backupId: string;
  engine: 'imap' | 'jmap';
  jmapEndpoint: string;
  imapHost: string;
  imapPort: number;
  stalwartMasterUser: string;
  tags: ReadonlyArray<string>;
}): string {
  assertCaptureInputs(input);
  const tagArgs = input.tags.map((t) => `--tag '${t.replace(/'/g, `'\\''`)}'`).join(' ');
  const master = shQuote(input.stalwartMasterUser);

  // Address dispatch by integer index — the same `seq + case` pattern the
  // tar-stream version used, so no value is ever expanded through `eval`.
  const caseBranches = input.addresses
    .map((a, i) => `  ${i}) ADDR=${shQuote(a)}; ADDRDIR=${shQuote(addressDirName(a))} ;;`)
    .join('\n');

  const capture = input.engine === 'imap'
    ? `  /usr/local/bin/imap-sync.py --imap-host ${shQuote(input.imapHost)} --imap-port ${input.imapPort}`
      + ` --account-address "$ADDR" --master-user ${master}`
      + ' --auth-pass-env STALWART_MASTER_PASSWORD --output-dir "$CAPTURE_ROOT" > /tmp/sync.json'
    : `  /usr/local/bin/jmap-sync.py --endpoint ${shQuote(input.jmapEndpoint)}`
      + ` --account-address "$ADDR" --master-user ${master}`
      + ' --auth-pass-env STALWART_MASTER_PASSWORD --output-dir "$CAPTURE_ROOT" > /tmp/sync.json';

  return [
    'set -e',
    `export RESTIC_PASSWORD="$(cat ${CREDS_MOUNT_PATH}/restic_password)"`,
    '[ -n "$RESTIC_PASSWORD" ] || { echo "ERROR: restic password missing"; exit 1; }',
    `if [ -f ${CREDS_MOUNT_PATH}/aws_access_key_id ]; then export AWS_ACCESS_KEY_ID="$(cat ${CREDS_MOUNT_PATH}/aws_access_key_id)"; fi`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_secret_access_key ]; then export AWS_SECRET_ACCESS_KEY="$(cat ${CREDS_MOUNT_PATH}/aws_secret_access_key)"; fi`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_region ]; then export AWS_DEFAULT_REGION="$(cat ${CREDS_MOUNT_PATH}/aws_region)"; fi`,
    `REPO="$(cat ${CREDS_MOUNT_PATH}/repo_uri)"`,
    '[ -n "$REPO" ] || { echo "ERROR: repo uri missing"; exit 1; }',
    `CAPTURE_ROOT=${MAILBOX_CAPTURE_ROOT}`,
    `COUNT=${input.addresses.length}`,
    'OK=0',
    'for i in $(seq 0 $((COUNT - 1))); do',
    '  case "$i" in',
    caseBranches,
    '  *) echo "ERROR: invalid index $i"; exit 1 ;;',
    '  esac',
    '  echo "Capturing mailbox $ADDR (#$((i + 1)) of $COUNT)..." >&2',
    '  rm -rf "$CAPTURE_ROOT/$ADDRDIR"',
    '  mkdir -p "$CAPTURE_ROOT/$ADDRDIR"',
    capture,
    // Aux surfaces (Sieve / contacts / calendars / vacation) always go over
    // JMAP — IMAP cannot transport them. Best-effort, exactly as before: a
    // blip here must not cost the mail snapshot.
    `  /usr/local/bin/jmap-aux-sync.py --endpoint ${shQuote(input.jmapEndpoint)} --account-address "$ADDR" --master-user ${master} --auth-pass-env STALWART_MASTER_PASSWORD --output-dir "$CAPTURE_ROOT" > /tmp/aux.json || echo "AUX_WARN address=$ADDR jmap-aux-sync.py exited non-zero — continuing"`,
    // An empty mailbox still snapshots: the directory exists (mkdir -p above)
    // and restic is happy to store an empty tree. Skipping it instead would
    // leave the bundle without a row for that address, which reads as "not
    // captured" rather than "nothing to capture".
    // restic 0.19 exits 3 BOTH for partial read errors and for a source path
    // that does not exist. We treat 3 as a warning, so assert the path here:
    // otherwise a vanished capture directory would be warned about and then
    // recorded as a captured mailbox holding nothing.
    '  [ -d "$CAPTURE_ROOT/$ADDRDIR" ] || { echo "ERROR: capture dir missing for $ADDR"; exit 1; }',
    '  MSGS=$(find "$CAPTURE_ROOT/$ADDRDIR" -type f \\( -path "*/cur/*" -o -path "*/new/*" \\) 2>/dev/null | wc -l | tr -d " ")',
    '  set +e',
    `  restic -r "$REPO" backup "$CAPTURE_ROOT/$ADDRDIR" ${tagArgs} --tag "address=$ADDR"`
      + ` --host ${shQuote(input.tenantId)} --compression auto --pack-size 64`
      + ' --option s3.connections=5 --ignore-inode --ignore-ctime --json > /tmp/out.json 2>/tmp/err',
    '  RC=$?',
    '  set -e',
    '  [ "$RC" = "3" ] && echo "WARN: restic reported partial read errors for $ADDR (exit 3)"',
    '  { [ "$RC" = "0" ] || [ "$RC" = "3" ]; } || { echo "ERROR: restic backup failed for $ADDR (exit $RC)"; tail -n 20 /tmp/err 2>/dev/null || true; exit 1; }',
    '  SNAP=$(grep -o \'"snapshot_id":"[0-9a-f]\\{64\\}"\' /tmp/out.json | tail -n1 | sed \'s/.*":"//;s/"$//\')',
    '  [ -n "$SNAP" ] || { echo "ERROR: no snapshot_id for $ADDR"; tail -n 40 /tmp/out.json; exit 1; }',
    '  SIZE=$(grep -o \'"total_bytes_processed":[0-9]\\+\' /tmp/out.json | tail -n1 | sed \'s/.*://\')',
    '  ADDED=$(grep -o \'"data_added_packed":[0-9]\\+\' /tmp/out.json | tail -n1 | sed \'s/.*://\')',
    '  [ -n "$ADDED" ] || ADDED=$(grep -o \'"data_added":[0-9]\\+\' /tmp/out.json | tail -n1 | sed \'s/.*://\')',
    `  echo "MAILBOX_DONE bundleId=${input.backupId} address=$ADDR snapshot=$SNAP sizeBytes=\${SIZE:-0} messages=\${MSGS:-0} addedBytes=\${ADDED:-}"`,
    // Free the tree before the next mailbox — this is what bounds peak disk
    // to the largest single mailbox instead of the tenant's whole mail.
    '  rm -rf "$CAPTURE_ROOT/$ADDRDIR"',
    '  OK=$((OK + 1))',
    'done',
    `echo "MAILBOXES_DONE bundleId=${input.backupId} captured=$OK of $COUNT"`,
  ].join('\n');
}

/**
 * K8s Job spec for the restic-native mailboxes capture. Pure — unit-tested
 * without a cluster.
 */
export function buildMailboxesResticJobSpec(
  input: BuildMailboxesResticJobSpecInput,
): Record<string, unknown> {
  const script = buildMailboxesCaptureScript({
    addresses: input.addresses,
    tenantId: input.tenantId,
    backupId: input.backupId,
    engine: input.engine,
    jmapEndpoint: input.jmapEndpoint,
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    stalwartMasterUser: input.stalwartMasterUser,
    tags: input.tags,
  });

  const labels = {
    'platform.io/component': 'backup-files',
    'platform.io/tenant-id': input.tenantId,
    'platform.io/backup-id': input.backupId,
    'platform.io/sub-component': 'backup-mailboxes',
  };

  return {
    metadata: { name: input.jobName, namespace: input.mailNamespace, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      ...(input.activeDeadlineSeconds && input.activeDeadlineSeconds > 0
        ? { activeDeadlineSeconds: input.activeDeadlineSeconds }
        : {}),
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          priorityClassName: 'platform-tenant-overhead',
          containers: [{
            name: 'mailboxes',
            image: input.toolsImage,
            imagePullPolicy: 'Always',
            command: ['sh', '-c', script],
            env: [{
              name: 'STALWART_MASTER_PASSWORD',
              valueFrom: {
                secretKeyRef: {
                  name: input.masterSecretName,
                  key: input.masterSecretKey,
                  optional: false,
                },
              },
            }],
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: '1500m', memory: '1Gi' },
            },
            volumeMounts: [
              { name: 'capture', mountPath: MAILBOX_CAPTURE_ROOT },
              { name: 'scratch', mountPath: '/tmp' },
              { name: 'restic-creds', mountPath: CREDS_MOUNT_PATH, readOnly: true },
            ],
          }],
          volumes: [
            // The Maildir tree. Bounded by the largest single mailbox now
            // that each address is deleted after its snapshot.
            { name: 'capture', emptyDir: { sizeLimit: input.captureSizeLimit ?? '50Gi' } },
            // restic's cache + the side-channel JSON files. Separate from the
            // mail tree so a large mailbox cannot starve the cache or vice
            // versa (files.ts uses the same 2Gi).
            { name: 'scratch', emptyDir: { sizeLimit: '2Gi' } },
            {
              name: 'restic-creds',
              secret: { secretName: input.credsSecretName, defaultMode: 0o400 },
            },
          ],
        },
      },
    },
  };
}

/**
 * Parse `MAILBOX_DONE` lines out of the Job log — one per captured mailbox.
 *
 * Format:
 *   MAILBOX_DONE bundleId=<id> address=<addr> snapshot=<64hex>
 *                sizeBytes=<n> messages=<n> addedBytes=<n|empty>
 *
 * `addedBytes` may be empty: a restic build that reports neither
 * `data_added_packed` nor `data_added` must yield null, never 0 — a mailbox
 * with no new mail legitimately adds 0 bytes, and conflating the two makes an
 * unmeasured run read as a measured one.
 */
export function parseMailboxDoneLines(
  log: string,
  bundleId: string,
): MailboxCaptureResult[] {
  const out: MailboxCaptureResult[] = [];
  for (const line of log.split('\n')) {
    if (!line.startsWith('MAILBOX_DONE ')) continue;
    const fields = new Map<string, string>();
    for (const tok of line.trim().split(/\s+/).slice(1)) {
      const eq = tok.indexOf('=');
      if (eq > 0) fields.set(tok.slice(0, eq), tok.slice(eq + 1));
    }
    if (fields.get('bundleId') !== bundleId) continue;
    const address = fields.get('address') ?? '';
    const snapshotId = fields.get('snapshot') ?? '';
    if (!address || !/^[0-9a-f]{64}$/.test(snapshotId)) continue;
    const added = fields.get('addedBytes');
    out.push({
      address,
      snapshotId,
      sizeBytes: Number.parseInt(fields.get('sizeBytes') ?? '0', 10) || 0,
      messageCount: Number.parseInt(fields.get('messages') ?? '0', 10) || 0,
      dataAddedPacked: added !== undefined && added !== '' && /^\d+$/.test(added)
        ? Number.parseInt(added, 10)
        : null,
    });
  }
  return out;
}

export type { K8sClients };
