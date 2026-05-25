/**
 * Render the shim config (R-X17 — versitygw architecture).
 *
 * Inputs:
 *   1. The platform-wide BACKUP_TARGET_KEY (Secret platform/backup-target-key)
 *   2. The `backup_configurations` rows referenced by class assignments
 *   3. The `backup_target_assignments` rows (class → target_id)
 *
 * Outputs:
 *   - `upstreamEnv` — env-file content for the shim launcher.sh. Encodes
 *     the operator-selected upstream (S3 / SFTP / CIFS / NFS) plus the
 *     shim's own HKDF-derived S3 credentials that clients use to
 *     authenticate to the shim.
 *   - `classesTxt` — one bound class per line (`system\ntenant\nmail`).
 *     The launcher validates each line against a strict allowlist
 *     before pre-creating buckets on POSIX-mode upstreams.
 *   - `posixMounts` — one entry when the upstream is CIFS/NFS/SFTP;
 *     drives the DaemonSet's privileged-mode + volume layout.
 *   - `sshKeyMaterializations` — SFTP PEM material to project into a
 *     Secret-backed volume (file mounted at /etc/rclone/ssh-keys/upstream.pem).
 *
 * Pure functions over the inputs — no I/O. The caller (reconciler.ts)
 * reads the Secret + DB rows, calls render(), writes the resulting
 * ConfigMap + Secret + DaemonSet patch.
 *
 * Why versitygw vs. rclone serve s3:
 *   rclone's ListObjectsV2 returns CommonPrefixes WITHOUT a trailing
 *   slash, which barman-cloud-backup-show + restic + boto3 rely on
 *   to recognise backup directories. versitygw emits the trailing
 *   slash correctly. The combine + crypt layering we previously used
 *   to multiplex per-class buckets is also gone — versitygw POSIX
 *   exposes top-level dirs as buckets natively, and versitygw S3 is
 *   a direct proxy (operator creates one upstream bucket per class).
 *
 * Encryption model (R-X17 difference vs. R-X16):
 *   No rclone-crypt layer. Self-encrypting callers (restic, age, age-
 *   encrypted secrets-bundle) encrypt with their own keys. Postgres
 *   backups can use barman-cloud `--encryption AES256` (SSE-S3) or
 *   `--sse-c-key-base64` (customer-managed key, sent per-request).
 *   See BACKUP_ARCHITECTURE_RFC §13a-iii for the per-caller crypto
 *   matrix.
 */

import { createHash } from 'node:crypto';
import {
  decodeBackupTargetKey,
  fingerprintRawKey,
  deriveShimAccessKey,
  deriveShimSecretKey,
  rcloneObscure,
} from './crypto.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupClass = 'system' | 'tenant' | 'mail';

/** Subset of backup_configurations row fields relevant to the shim
 *  renderer. The service layer maps DB columns to this shape and
 *  decrypts encrypted columns before passing them in. */
export interface BackupTargetConfig {
  readonly id: string;
  readonly name: string;
  readonly storageType: 's3' | 'ssh' | 'cifs';
  // S3 fields
  readonly s3Endpoint?: string | null;
  readonly s3Bucket?: string | null;
  readonly s3Region?: string | null;
  readonly s3AccessKey?: string | null;
  readonly s3SecretKey?: string | null;
  readonly s3Prefix?: string | null;
  /** When true (default), pass `--use-path-style` to versitygw. When
   *  false, omit it so versitygw uses virtual-hosted-style URLs
   *  (`bucket.endpoint`). Required for AWS S3 in regions that no longer
   *  accept path-style. Null/undefined = legacy rows = treat as true. */
  readonly s3UsePathStyle?: boolean | null;
  // SFTP (storage_type='ssh')
  readonly sshHost?: string | null;
  readonly sshPort?: number | null;
  readonly sshUser?: string | null;
  readonly sshKey?: string | null;
  readonly sshPassword?: string | null;
  readonly sshPath?: string | null;
  // CIFS
  readonly cifsHost?: string | null;
  readonly cifsPort?: number | null;
  readonly cifsShare?: string | null;
  readonly cifsUser?: string | null;
  readonly cifsPassword?: string | null;
  readonly cifsDomain?: string | null;
  readonly cifsPath?: string | null;
  // NFS was dropped 2026-05-25 — see ADR-043 postscript.
}

export interface ClassAssignment {
  readonly className: BackupClass;
  readonly target: BackupTargetConfig;
}

/** What the renderer produces. The service writes these into the
 *  Secret + ConfigMap + DaemonSet patch. */
export interface RenderedShimConfig {
  /** env-file content for the shim launcher. Contains only the shim's
   *  HKDF-derived ROOT_ACCESS_KEY / ROOT_SECRET_KEY since R-X20 — all
   *  upstream credentials moved to `rcloneConf` below. */
  readonly upstreamEnv: string;
  /** Full rclone.conf content. R-X20 (always-combined): always emits
   *  a [combined] section that aliases each bound class to its target's
   *  scoped path. Single-target operators get one upstream section +
   *  N class aliases pointing at the same upstream with class-name
   *  suffix. Multi-target operators get N upstream sections + N class
   *  aliases. The client-visible path layout is identical in both
   *  cases: <bucket>/<prefix>/<class>/<key>.
   *  Passwords are obscured at render time using the existing
   *  rcloneObscure helper. */
  readonly rcloneConf: string;
  /** One bound class per line. Written to the ConfigMap as
   *  `classes.txt`. */
  readonly classesTxt: string;
  /** SHA-256 of upstreamEnv + classesTxt + rcloneConf (R-X20) — used as the DaemonSet
   *  spec.template annotation hash so any change rolls the pods. */
  readonly configHash: string;
  /** Shim's own S3 access_key (HKDF-derived). Clients use this to
   *  authenticate to the shim's S3 endpoint. The same value goes into
   *  the `backup-rclone-shim-creds` Secret that callers (CNPG plugin,
   *  etcd CronJob, restic CronJobs, rclone-push) consume. */
  readonly shimAccessKey: string;
  /** Shim's own S3 secret_key. */
  readonly shimSecretKey: string;
  /** sha256(rawKey).slice(0,16). Reported in the status ConfigMap so
   *  the rotation CLI can verify the new key has been picked up. */
  readonly keyFingerprint: string;
  /** Which classes have an upstream bound. Drives the UI + drain
   *  orchestrator + status reporting. */
  readonly assignedClasses: ReadonlyArray<BackupClass>;
  /** Volume mounts needed for posix-backed targets (CIFS, SFTP).
   *  R-X17: SFTP is now a POSIX mount via sshfs (FUSE), so both
   *  remote types are uniformly "POSIX upstream". The service merges
   *  these into the DaemonSet Pod spec — privileged mode is enabled
   *  iff this array is non-empty. (NFS dropped 2026-05-25.) */
  readonly posixMounts: ReadonlyArray<PosixMount>;
  /** PEM-format SSH private keys to project into a Secret volume at
   *  /etc/rclone/ssh-keys/upstream.pem. Empty when SFTP target uses
   *  password auth, or the upstream is not SFTP. */
  readonly sshKeyMaterializations: ReadonlyArray<SshKeyMaterialization>;
}

export interface SshKeyMaterialization {
  /** Filename basename under /etc/rclone/ssh-keys/. R-X20: each
   *  unique SFTP target gets its own filename matching the rclone.conf
   *  section name (e.g. `upstream_a1b2c3d4.pem`) so multiple SFTP
   *  targets in one shim don't collide. */
  readonly fileName: string;
  readonly pemContent: string;
}

export interface PosixMount {
  /** Always `/mnt/upstream` in R-X17 — the launcher mounts the
   *  single shared upstream at one fixed mount point. The shape is
   *  retained as a record so the DaemonSet patcher knows to add the
   *  CAP_SYS_ADMIN / privileged bits + the mount-helper volume. */
  readonly mountPath: string;
  readonly storageType: 'sftp' | 'cifs';
  readonly target: BackupTargetConfig;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const MOUNT_POINT = '/mnt/upstream';

/**
 * Render the shim config from a 32-byte BACKUP_TARGET_KEY and a list
 * of class→target assignments.
 *
 * R-X20 (2026-05-21): always-combined. The renderer emits an rclone
 * `[combined]` section that aliases each bound class to its target's
 * path with a class-name suffix. Single-target operators get ONE
 * upstream section + N class aliases pointing at the same upstream;
 * multi-target operators get N upstream sections + N class aliases.
 * Client-visible path layout is identical:
 *   <upstream-bucket>/<upstream-prefix>/<class>/<key>
 *
 * Mixed-protocol upstreams (S3 + SFTP + SMB at once) are supported
 * — each class can target a different storage_type if the operator
 * binds them that way.
 *
 * Passwords are obscured at render time using `rcloneObscure` from
 * crypto.ts (AES-CTR with the rclone-canonical key). Operators get
 * a self-contained rclone.conf that's safe to ship as a Secret.
 */
export function renderShimConfig(
  rawKey: Buffer,
  assignments: ReadonlyArray<ClassAssignment>,
): RenderedShimConfig {
  if (rawKey.length !== 32) {
    throw new Error(`rawKey must be 32 bytes; got ${rawKey.length}`);
  }

  const shimAccessKey = deriveShimAccessKey(rawKey);
  const shimSecretKey = deriveShimSecretKey(rawKey);
  const keyFingerprint = fingerprintRawKey(rawKey);

  const sorted = [...assignments].sort((a, b) =>
    a.className.localeCompare(b.className),
  );

  // Empty assignments → minimal env (no upstream) + empty classes.txt.
  // The launcher detects this and sleeps until the reconciler renders
  // real content.
  if (sorted.length === 0) {
    const upstreamEnv = renderEnvHeader(shimAccessKey, shimSecretKey);
    const rcloneConf = renderEmptyRcloneConf();
    return {
      upstreamEnv,
      rcloneConf,
      classesTxt: '',
      configHash: createHash('sha256').update(upstreamEnv).update('\n').update(rcloneConf).digest('hex'),
      shimAccessKey,
      shimSecretKey,
      keyFingerprint,
      assignedClasses: [],
      posixMounts: [],
      sshKeyMaterializations: [],
    };
  }

  const assignedClasses = sorted.map((s) => s.className);

  // R-X20: always-combined. Render N unique target sections + the
  // [combined] aliases. SSH key materialisations and posix-mount
  // hints are still per-target (an operator binding a SSH target gets
  // their key extracted to a Secret, regardless of how many other
  // targets are also bound).
  const uniqueTargetsById = new Map<string, BackupTargetConfig>();
  for (const a of sorted) {
    if (!uniqueTargetsById.has(a.target.id)) {
      uniqueTargetsById.set(a.target.id, a.target);
    }
  }
  const uniqueTargets = [...uniqueTargetsById.values()];

  // Stable section names: `upstream_<8-hex-of-target-id>`. Avoids
  // dashes (rclone config section names accept them but they read
  // poorly) and keeps the section name reasonably short.
  const sectionNameFor = (targetId: string): string => {
    const short = createHash('sha256').update(targetId).digest('hex').slice(0, 8);
    return `upstream_${short}`;
  };

  const sshKeyMaterializations: SshKeyMaterialization[] = [];
  const posixMounts: PosixMount[] = [];
  const upstreamSections: string[] = [];

  for (const target of uniqueTargets) {
    const sec = sectionNameFor(target.id);
    const { conf, sshKey, posixMount } = renderUpstreamSection(sec, target);
    upstreamSections.push(conf);
    if (sshKey) sshKeyMaterializations.push(sshKey);
    if (posixMount) posixMounts.push(posixMount);
  }

  // Build the [combined] section. Each class maps to its target's
  // path with the class name appended as the final path segment —
  // so the client-visible layout is <upstream-root>/<class>/<key>
  // regardless of whether classes share a target.
  const upstreamPairs: string[] = [];
  for (const { className, target } of sorted) {
    const sec = sectionNameFor(target.id);
    const root = upstreamRootPath(target);
    // Path format: <section>:<root>/<class> — but when root is empty
    // (e.g. SFTP target with no sshPath), avoid the leading slash so
    // we get `<section>:<class>` (home-relative) instead of
    // `<section>:/<class>` (absolute) which fails on remote storage
    // that doesn't allow writes outside the user's home (e.g. Hetzner
    // Storage Box SFTP).
    const aliasPath = root ? `${root}/${className}` : className;
    // Validate against rclone combine parser: spaces would break the
    // `upstreams =` token split. S3 bucket names already reject spaces
    // at the AWS layer, but CIFS share names and SFTP paths can
    // contain them.
    if (/\s/.test(aliasPath)) {
      throw new Error(
        `backup-rclone-shim: target '${target.name}' has a whitespace character in its path components; rclone combine parses 'upstreams =' as space-separated tokens and cannot tolerate this. Rename the share/path to avoid spaces.`,
      );
    }
    upstreamPairs.push(`${className}=${sec}:${aliasPath}`);
  }
  upstreamSections.push(
    [
      '[combined]',
      'type = combine',
      `upstreams = ${upstreamPairs.join(' ')}`,
      '',
    ].join('\n'),
  );

  const rcloneConf = renderRcloneConfHeader() + upstreamSections.join('\n');
  const upstreamEnv = renderEnvHeader(shimAccessKey, shimSecretKey);
  const classesTxt = assignedClasses.join('\n') + '\n';

  const configHash = createHash('sha256')
    .update(upstreamEnv)
    .update('\n----\n')
    .update(classesTxt)
    .update('\n----\n')
    .update(rcloneConf)
    .digest('hex');

  return {
    upstreamEnv,
    rcloneConf,
    classesTxt,
    configHash,
    shimAccessKey,
    shimSecretKey,
    keyFingerprint,
    assignedClasses,
    posixMounts,
    sshKeyMaterializations,
  };
}

// ---------------------------------------------------------------------------
// Section renderers (R-X20 always-combined)
// ---------------------------------------------------------------------------

/**
 * Compose the upstream root path that the [combined] section appends
 * the class-name suffix to.
 *
 * S3:    <s3_bucket>[/<s3_prefix>]
 * SFTP:  [<ssh_path>]              (relative path on the SFTP server)
 * CIFS:  <cifs_share>[/<cifs_path>]
 * Local: '/'                       (PVC mount root)
 *
 * Slashes are stripped from operator-supplied paths to keep the final
 * path joiner predictable. Empty path → just the section root.
 */
function upstreamRootPath(t: BackupTargetConfig): string {
  switch (t.storageType) {
    case 's3': {
      if (!t.s3Bucket) throw new Error(`S3 target '${t.name}' missing bucket`);
      const parts = [t.s3Bucket];
      if (t.s3Prefix) parts.push(stripSlashes(t.s3Prefix));
      return parts.join('/');
    }
    case 'ssh':
      return t.sshPath ? stripSlashes(t.sshPath) : '';
    case 'cifs': {
      if (!t.cifsShare) throw new Error(`CIFS target '${t.name}' missing share`);
      const parts = [t.cifsShare];
      if (t.cifsPath) parts.push(stripSlashes(t.cifsPath));
      return parts.join('/');
    }
    default:
      throw new Error(
        `Unsupported storage_type '${(t as { storageType: string }).storageType}'`,
      );
  }
}

/**
 * Render a single upstream section in rclone.conf format. Includes
 * the credentials in obscured form where the backend requires it
 * (SFTP `pass`, SMB `pass`). S3 credentials are stored in cleartext
 * because rclone's S3 backend does not accept obscured access keys.
 *
 * Returns the conf section content + any sshKey/posixMount hints for
 * the reconciler.
 */
function renderUpstreamSection(
  sectionName: string,
  t: BackupTargetConfig,
): {
  conf: string;
  sshKey?: SshKeyMaterialization;
  posixMount?: PosixMount;
} {
  switch (t.storageType) {
    case 's3':
      return { conf: renderS3Section(sectionName, t) };
    case 'ssh':
      return renderSftpSection(sectionName, t);
    case 'cifs':
      return {
        conf: renderCifsSection(sectionName, t),
        // posixMount kept as a metric/log indicator only — R-X20
        // doesn't kernel-mount CIFS, but the field is still useful
        // for "how many POSIX-style backends are bound" logging.
        posixMount: { mountPath: MOUNT_POINT, storageType: 'cifs', target: t },
      };
    default:
      throw new Error(
        `Unsupported storage_type '${(t as { storageType: string }).storageType}'`,
      );
  }
}

function renderS3Section(name: string, t: BackupTargetConfig): string {
  if (!t.s3Endpoint || !t.s3Bucket || !t.s3AccessKey || !t.s3SecretKey) {
    throw new Error(
      `S3 target '${t.name}' is missing required fields (endpoint, bucket, access_key, secret_key)`,
    );
  }
  const usePathStyle = t.s3UsePathStyle === false ? 'false' : 'true';
  return [
    `[${name}]`,
    'type = s3',
    'provider = Other',
    `endpoint = ${t.s3Endpoint}`,
    `region = ${t.s3Region ?? 'us-east-1'}`,
    `access_key_id = ${t.s3AccessKey}`,
    `secret_access_key = ${t.s3SecretKey}`,
    `force_path_style = ${usePathStyle}`,
    '',
  ].join('\n');
}

function renderSftpSection(
  name: string,
  t: BackupTargetConfig,
): { conf: string; sshKey?: SshKeyMaterialization; posixMount: PosixMount } {
  if (!t.sshHost || !t.sshUser) {
    throw new Error(
      `SFTP target '${t.name}' is missing required fields (host, user)`,
    );
  }
  if (!t.sshKey && !t.sshPassword) {
    throw new Error(
      `SFTP target '${t.name}' requires either ssh_key or ssh_password`,
    );
  }
  const lines: string[] = [
    `[${name}]`,
    'type = sftp',
    `host = ${t.sshHost}`,
    `user = ${t.sshUser}`,
    `port = ${t.sshPort ?? 22}`,
    'shell_type = unix',
  ];
  let sshKey: SshKeyMaterialization | undefined;
  if (t.sshKey) {
    // PEM material is projected at /etc/rclone/ssh-keys/<section>.pem
    // by the reconciler so each target gets its own key file.
    const pemFile = `${name}.pem`;
    lines.push(`key_file = /etc/rclone/ssh-keys/${pemFile}`);
    sshKey = { fileName: pemFile, pemContent: t.sshKey };
  } else if (t.sshPassword) {
    // rclone's SFTP backend requires the obscured form, NEVER plaintext.
    lines.push(`pass = ${rcloneObscure(t.sshPassword)}`);
  }
  lines.push('');
  return {
    conf: lines.join('\n'),
    sshKey,
    posixMount: { mountPath: MOUNT_POINT, storageType: 'sftp', target: t },
  };
}

function renderCifsSection(name: string, t: BackupTargetConfig): string {
  if (!t.cifsHost || !t.cifsShare || !t.cifsUser || !t.cifsPassword) {
    throw new Error(
      `CIFS target '${t.name}' is missing required fields (host, share, user, password)`,
    );
  }
  const lines: string[] = [
    `[${name}]`,
    'type = smb',
    `host = ${t.cifsHost}`,
    `user = ${t.cifsUser}`,
    `pass = ${rcloneObscure(t.cifsPassword)}`,
  ];
  if (t.cifsDomain) lines.push(`domain = ${t.cifsDomain}`);
  if (t.cifsPort) lines.push(`port = ${t.cifsPort}`);
  lines.push('');
  return lines.join('\n');
}

function renderRcloneConfHeader(): string {
  return [
    '# rclone.conf — backup-rclone-shim (R-X20 always-combined)',
    '# AUTO-GENERATED by platform-api backup-rclone-shim/config-renderer.',
    '# Do NOT edit by hand. Operator changes flow via',
    '# /admin/backup-rclone-shim/... endpoints.',
    '#',
    '# Layout: N [upstream_<8-hex>] sections (one per unique bound',
    '# target) plus a [combined] section that maps each bound class',
    '# (system/tenant/mail) to its target with a class-name path',
    '# suffix. The launcher execs `rclone serve s3 combined:` so',
    '# clients see <class> as the served bucket name and writes land',
    '# at <upstream-root>/<class>/<client-key>.',
    '#',
    '# Passwords are obscured (rclone AES-CTR canonical) — required',
    '# by the SFTP/SMB backends. S3 credentials are cleartext as the',
    '# S3 backend does not accept obscured access keys.',
    '',
  ].join('\n');
}

function renderEmptyRcloneConf(): string {
  return [
    '# rclone.conf — backup-rclone-shim (no class assignments)',
    '# AUTO-GENERATED. Reconciler renders content when an operator',
    '# binds at least one class to a backup target.',
    '',
  ].join('\n');
}

function renderEnvHeader(shimAccessKey: string, shimSecretKey: string): string {
  return [
    '# upstream.env — backup-rclone-shim (R-X20: minimal — shim creds only)',
    '# AUTO-GENERATED by platform-api backup-rclone-shim/config-renderer.',
    '# Do NOT edit by hand.',
    '#',
    '# All upstream credentials are now in rclone.conf (rendered',
    '# alongside this file in the credentials Secret). This file only',
    '# carries the HKDF-derived shim creds that clients use to',
    '# authenticate TO the shim.',
    `ROOT_ACCESS_KEY='${shimAccessKey}'`,
    `ROOT_SECRET_KEY='${shimSecretKey}'`,
    '',
  ].join('\n');
}

// R-X20: removed renderUpstreamEnv + per-type env renderers
// (renderS3Env, renderSftpEnv, renderCifsEnv, renderNfsEnv, shellQuote)
// — all credentials now live in rclone.conf rendered above. Helper
// functions remain below for path normalization.

function stripSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

// ---------------------------------------------------------------------------
// Input hash (deterministic; ignores random-IV obscure outputs)
// ---------------------------------------------------------------------------

/**
 * Hash that depends ONLY on the rendering INPUTS, used by the
 * reconciler to detect "does this cluster need a re-render?" without
 * false positives from any randomness in the output. R-X17 drops the
 * rclone-obscure layer entirely, so the rendered output is already
 * deterministic — this helper still exists for the reconciler's
 * change-detection contract.
 */
export function computeInputHash(
  rawKey: Buffer,
  assignments: ReadonlyArray<ClassAssignment>,
): string {
  const h = createHash('sha256');
  // Renderer-version sentinel. Bump when the OUTPUT format changes
  // (e.g. new emitted env vars, new launcher contract). This forces
  // the reconciler to re-materialise the Secret + ConfigMap even when
  // the operator INPUTS are unchanged.
  // - v2-versitygw  : R-X17 versitygw launcher
  // - v3-rclone-bp  : R-X19 rclone-serve-s3 + bucket+prefix scoping
  // - v4-combine    : R-X20 always-combined renderer (rclone.conf-based)
  h.update('v4-combine\n');
  h.update(`fp=${fingerprintRawKey(rawKey)}\n`);
  const sorted = [...assignments].sort((a, b) =>
    a.className.localeCompare(b.className),
  );
  for (const { className, target } of sorted) {
    h.update(`class=${className}\n`);
    h.update(`tid=${target.id}\n`);
    h.update(`tname=${target.name}\n`);
    h.update(`ttype=${target.storageType}\n`);
    const credFields = [
      target.s3Endpoint,
      target.s3Bucket,
      target.s3Region,
      target.s3AccessKey,
      target.s3SecretKey,
      target.s3Prefix,
      target.s3UsePathStyle === false ? 'pathstyle=false' : 'pathstyle=true',
      target.sshHost,
      String(target.sshPort ?? ''),
      target.sshUser,
      target.sshKey,
      target.sshPassword,
      target.sshPath,
      target.cifsHost,
      String(target.cifsPort ?? ''),
      target.cifsShare,
      target.cifsUser,
      target.cifsPassword,
      target.cifsDomain,
      target.cifsPath,
    ];
    for (const v of credFields) {
      h.update(v ?? '');
      h.update('\0');
    }
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Re-exports for backwards-compat with reconciler.ts + tests
// ---------------------------------------------------------------------------

export { decodeBackupTargetKey };
