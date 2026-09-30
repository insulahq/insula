/**
 * Import Job — the mirror of `components/files.ts`'s capture Job (ADR-063).
 *
 * Capture runs `restic backup /source` natively in the tenant namespace so each
 * file becomes its own restic node, which is what makes `restic ls` /
 * `restore --include` work. Import has to produce snapshots of the SAME shape or
 * a re-imported bundle is not restorable the way a captured one is — so it runs
 * the same command against a staged tree, in the same namespace, with the same
 * creds Secret.
 *
 * ★ Why re-ingest at all rather than re-register the snapshot ids from
 * `meta.json`: the per-tenant restic password is `HKDF(key,
 * "restic-tenant-<id>")`, derived from THIS cluster's PLATFORM_ENCRYPTION_KEY.
 * An uploaded bundle's ids name snapshots in a repo this cluster cannot open.
 * `dr-recover/recreate.ts` re-registers because its bundle is already in this
 * repo; an upload never is. See ADR-063.
 *
 * SHAPE OF THE RUN
 *   1. Export RESTIC_PASSWORD / AWS_* from the mounted creds Secret (identical
 *      to capture).
 *   2. `tar -xzf <archive on the mounted tenant PVC> -C /stage`.
 *
 *      ★ The archive arrives through the EXISTING chunked upload path —
 *      `POST /tenants/:id/files/upload-raw?path=…&offset=…&total=…`, the same
 *      one the file browser uses. That gives parallel chunks, resumable
 *      offsets, per-chunk progress and abort for free, and it is already carved
 *      out of the WAF. It lands under `.insula-imports/` in the tenant's own
 *      file space, so the Job reads it by mounting the tenant PVC exactly as
 *      the capture Job mounts `/source` — no second transfer, no new receiver,
 *      no HMAC download rail.
 *   3. Assert every unit the caller promised actually landed. A truncated or
 *      malformed archive otherwise leaves `tar` exiting 0 on a short read;
 *      asserting the units exist turns that into a hard failure.
 *   4. Per unit: `restic backup <unit dir> --json`, parse the snapshot id,
 *      print a machine-readable line, then DELETE the staged unit.
 *
 * STAGING SIZE — see ADR-063 D2. Peak is the extracted total at the end of step
 * 3, falling as step 4 deletes each unit. `emptyDir.sizeLimit` bounds it: the
 * kubelet evicts this Job rather than filling the node, which is the safe
 * failure for a manifest that under-declared.
 *
 * REAPING — every artifact has an owner:
 *   - staged unit        deleted after its own `restic backup`
 *   - staging dir        emptyDir, gone with the pod
 *   - the Job            `ttlSecondsAfterFinished`
 *   - partial snapshots  every one is tagged `import=<importId>`, so a failed
 *                        run is prunable by tag by the caller
 *   - uploaded archive   under `.insula-imports/` in the tenant's file space.
 *                        The caller deletes it on success AND on failure, and a
 *                        sweeper removes abandoned ones — an upload that is
 *                        never imported would otherwise sit in the tenant's
 *                        quota forever.
 */
import { resolvePlatformImage } from '../../shared/platform-images.js';

/** Where the archive is unpacked inside the Job. */
export const IMPORT_STAGE_ROOT = '/stage';

/** Same mount point the capture Job uses, so the creds Secret is interchangeable. */
export const IMPORT_CREDS_MOUNT_PATH = '/var/run/restic-creds';

/** Tenant file space, mounted read-only — matches the capture Job's `/source`. */
export const IMPORT_SOURCE_ROOT = '/source';

/**
 * Directory in the tenant's file space that uploaded archives land in.
 *
 * Dot-prefixed so the file browser's normal listing does not put it in a
 * tenant's face, and fixed so the reaper has exactly one place to sweep.
 */
export const IMPORT_UPLOAD_DIR = '.insula-imports';

/** restic's own cache/scratch. Matches the capture Job. */
const SCRATCH_SIZE = '2Gi';

const TOOLS_IMAGE_DEFAULT = resolvePlatformImage('tenant-backup-tools');

/** A single restic snapshot's worth of data inside the archive. */
export interface ImportUnit {
  readonly component: 'files' | 'mailboxes';
  /**
   * Entry name under `components/<component>/` in the archive — `archive` for
   * files, or the mailbox address (ADR-061 gives each mailbox its own snapshot).
   */
  readonly name: string;
  /** Declared size from meta.json. Advisory: used for sizing and progress only. */
  readonly sizeBytes: number;
}

/**
 * A small component (`config` / `secrets`) the Job pushes straight to the
 * object store through platform-api's existing internal upload endpoint —
 * the same door a capture Job uses.
 *
 * The HMAC token is NOT inlined into the pod spec: it arrives as a key in the
 * mounted creds Secret. A token in `command` would be readable by anyone with
 * pod-read in the tenant namespace.
 */
export interface ImportObjectUpload {
  readonly component: 'config' | 'secrets';
  /** Canonical artifact filename, e.g. `db-rows.json.gz`. */
  readonly name: string;
  /** Key under the creds mount holding the HMAC upload token. */
  readonly tokenKey: string;
}

export interface BuildImportJobInput {
  readonly jobName: string;
  readonly namespace: string;
  readonly tenantId: string;
  readonly importId: string;
  /** Bundle row the imported snapshots will be registered against. */
  readonly bundleId: string;
  /** PVC holding the tenant's file space — the uploaded archive lives on it. */
  readonly pvcName: string;
  /**
   * Archive path RELATIVE to the tenant file root, e.g.
   * `.insula-imports/<importId>.tar.gz`. Validated by `assertSafeArchivePath`.
   */
  readonly archiveRelPath: string;
  readonly units: ReadonlyArray<ImportUnit>;
  readonly credsSecretName: string;
  /** e.g. '12Gi' — derived from meta, clamped by the caller. */
  readonly stageSizeLimit: string;
  readonly image?: string;
  readonly activeDeadlineSeconds?: number;
  readonly pinToNode?: string;
  /** Extra restic tags. `import=<importId>` is always added. */
  readonly tags?: ReadonlyArray<string>;
  /**
   * Small components pushed to the object store. Admin imports carry
   * `config`/`secrets`; a tenant self-import carries none (ADR-063 D4).
   */
  readonly objectArtifacts?: ReadonlyArray<ImportObjectUpload>;
  /** e.g. `http://platform-api.platform.svc:3000`. Required iff objectArtifacts is non-empty. */
  readonly internalApiBase?: string;
}

/** `components/<component>/<name>` — where a unit lands under the stage root. */
export function unitStagePath(u: ImportUnit): string {
  return `${IMPORT_STAGE_ROOT}/components/${u.component}/${u.name}`;
}

/**
 * Shell-quote for single-quoted POSIX context.
 *
 * Unit names include mailbox addresses, which come from an UPLOADED archive —
 * i.e. from whoever produced the file. They reach a shell command line, so they
 * are quoted here and additionally validated by `assertSafeUnitName` before any
 * Job is built. Belt and braces: the validator is the control, this is the
 * containment.
 */
function sq(v: string): string {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/**
 * Reject a unit name that could escape its directory or the shell.
 *
 * Mailbox addresses and `archive` are the only legitimate values. Anything with
 * a slash, a `..`, a NUL or a shell metacharacter is refused rather than
 * escaped — an archive containing one is malformed or hostile, and neither is
 * worth importing.
 */
export function assertSafeUnitName(name: string): void {
  if (!name || name.length > 320) {
    throw new Error(`import-job: unit name has an implausible length: ${JSON.stringify(name.slice(0, 40))}`);
  }
  if (!/^[A-Za-z0-9._@+-]+$/.test(name)) {
    throw new Error(`import-job: refusing unit name with unexpected characters: ${JSON.stringify(name.slice(0, 40))}`);
  }
  if (name === '.' || name === '..' || name.includes('..')) {
    throw new Error(`import-job: refusing traversal-shaped unit name: ${JSON.stringify(name)}`);
  }
}

/**
 * Reject an archive path that could escape the upload directory.
 *
 * The path reaches a shell command line and a filesystem read inside a pod that
 * has the tenant's whole file space mounted. It is constructed server-side
 * today, but a traversal here would let a caller read any file on that PVC into
 * a restic snapshot, so it is validated rather than trusted.
 */
export function assertSafeArchivePath(relPath: string): void {
  if (!relPath.startsWith(`${IMPORT_UPLOAD_DIR}/`)) {
    throw new Error(`import-job: archive path must live under ${IMPORT_UPLOAD_DIR}/`);
  }
  const rest = relPath.slice(IMPORT_UPLOAD_DIR.length + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(rest) || rest.includes('..')) {
    throw new Error(`import-job: refusing archive path ${JSON.stringify(relPath)}`);
  }
}

/**
 * Build the POSIX-sh script. Kept POSIX (not bash) for the same reason the
 * capture script is: the image is debian today and a future swap must not
 * silently change semantics.
 */
/**
 * Canonical artifact filenames only — the same shape the internal upload route
 * enforces server-side. Checked here too so a malformed name fails at
 * build time rather than as a 400 from inside a running Job.
 */
/**
 * Creds-Secret key holding the restic repo URI for a component.
 *
 * One key per component because `buildResticRepoUri` is component-scoped:
 * the `per-component` layout gives `files` and `mailboxes` separate
 * repositories.
 */
export function repoUriKey(component: 'files' | 'mailboxes'): string {
  return `repo_uri_${component}`;
}

export function assertSafeArtifactName(name: string): void {
  if (!/^[A-Za-z0-9._@-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`import artifact name contains unexpected characters: ${JSON.stringify(name)}`);
  }
}

export function buildImportScript(input: BuildImportJobInput): string {
  for (const u of input.units) assertSafeUnitName(u.name);
  assertSafeArchivePath(input.archiveRelPath);
  const objects = input.objectArtifacts ?? [];
  for (const o of objects) {
    assertSafeArtifactName(o.name);
    assertSafeArtifactName(o.tokenKey);
  }
  if (objects.length > 0 && !input.internalApiBase) {
    throw new Error('buildImportScript: internalApiBase is required when objectArtifacts are present');
  }

  const tagArgs = [`import=${input.importId}`, ...(input.tags ?? [])]
    .map((t) => `--tag ${sq(t)}`)
    .join(' ');

  const lines: string[] = [
    'set -e',
    `export RESTIC_PASSWORD="$(cat ${IMPORT_CREDS_MOUNT_PATH}/restic_password)"`,
    `[ -n "$RESTIC_PASSWORD" ] || { echo "ERROR: restic password missing"; exit 1; }`,
    `if [ -f ${IMPORT_CREDS_MOUNT_PATH}/aws_access_key_id ]; then export AWS_ACCESS_KEY_ID="$(cat ${IMPORT_CREDS_MOUNT_PATH}/aws_access_key_id)"; fi`,
    `if [ -f ${IMPORT_CREDS_MOUNT_PATH}/aws_secret_access_key ]; then export AWS_SECRET_ACCESS_KEY="$(cat ${IMPORT_CREDS_MOUNT_PATH}/aws_secret_access_key)"; fi`,
    `if [ -f ${IMPORT_CREDS_MOUNT_PATH}/aws_region ]; then export AWS_DEFAULT_REGION="$(cat ${IMPORT_CREDS_MOUNT_PATH}/aws_region)"; fi`,
    `mkdir -p ${IMPORT_STAGE_ROOT}`,
    `ARCHIVE=${sq(`${IMPORT_SOURCE_ROOT}/${input.archiveRelPath}`)}`,
    `[ -f "$ARCHIVE" ] || { echo "ERROR: uploaded archive not found at $ARCHIVE"; exit 1; }`,
    'echo "Extracting the uploaded archive..."',
    // Read straight off the mounted PVC — the chunked upload already put it
    // there, so there is no second transfer.
    `tar -xzf "$ARCHIVE" -C ${IMPORT_STAGE_ROOT}`,
  ];

  // A truncated or malformed archive can leave tar exiting 0 on a short read,
  // so the reliable completeness signal is that every promised unit is present.
  // Assert before touching the repo.
  for (const u of input.units) {
    const p = unitStagePath(u);
    lines.push(
      `[ -e ${sq(p)} ] || { echo "ERROR: archive is missing ${u.component}/${u.name} — download truncated or bundle malformed"; exit 1; }`,
    );
  }
  lines.push(`echo "IMPORT_EXTRACTED units=${input.units.length}"`);

  for (const u of input.units) {
    const p = unitStagePath(u);
    lines.push(
      `echo "Backing up ${u.component}/${u.name}..."`,
      // Per COMPONENT, not one repo for the whole import: under the
      // `per-component` layout `files` and `mailboxes` are DIFFERENT
      // repositories, and writing both into one would put the mailbox
      // snapshots somewhere no restore path ever looks. Under `per-tenant`
      // both keys hold the same URI, so this is correct for both layouts.
      `REPO="$(cat ${IMPORT_CREDS_MOUNT_PATH}/${repoUriKey(u.component)})"`,
      `[ -n "$REPO" ] || { echo "ERROR: repo uri missing for ${u.component}"; exit 1; }`,
      'set +e',
      `restic -r "$REPO" backup ${sq(p)} ${tagArgs} --tag ${sq(`component=${u.component}`)} --compression auto --pack-size 64 --option s3.connections=5 --json > /tmp/out.json 2>/tmp/err`,
      'RC=$?',
      'set -e',
      // Same acceptance as capture: 3 means "some files unreadable" but a valid
      // snapshot was still written. Anything else is fatal.
      '[ "$RC" = "3" ] && echo "WARN: restic backup completed with partial read errors (exit 3)"',
      '{ [ "$RC" = "0" ] || [ "$RC" = "3" ]; } || { echo "ERROR: restic backup failed (exit $RC)"; tail -n 20 /tmp/err 2>/dev/null || true; exit 1; }',
      `SNAP=$(grep -o '"snapshot_id":"[0-9a-f]\\{64\\}"' /tmp/out.json | tail -n1 | sed 's/.*":"//;s/"$//')`,
      '[ -n "$SNAP" ] || { echo "ERROR: no snapshot_id in restic output"; tail -n 40 /tmp/out.json; exit 1; }',
      `SIZE=$(grep -o '"total_bytes_processed":[0-9]\\+' /tmp/out.json | tail -n1 | sed 's/.*://')`,
      `ADDED=$(grep -o '"data_added_packed":[0-9]\\+' /tmp/out.json | tail -n1 | sed 's/.*://')`,
      `[ -n "$ADDED" ] || ADDED=$(grep -o '"data_added":[0-9]\\+' /tmp/out.json | tail -n1 | sed 's/.*://')`,
      `echo "IMPORT_UNIT_DONE importId=${input.importId} component=${u.component} name=${u.name} snapshot=$SNAP sizeBytes=\${SIZE:-0} addedBytes=\${ADDED:-0}"`,
      // Free the space before the next unit — this is what keeps peak staging
      // falling rather than holding the whole bundle to the end.
      `rm -rf ${sq(p)}`,
    );
  }

  // Object artifacts go LAST, after every restic unit has succeeded. An import
  // that dies early therefore leaves nothing in the object store to orphan —
  // and the orchestrator drops the reserved bundle on failure regardless.
  for (const o of objects) {
    const artPath = `${IMPORT_STAGE_ROOT}/components/${o.component}/${o.name}`;
    const url = `${input.internalApiBase}/api/v1/internal/bundles/${input.bundleId}`
      + `/components/${o.component}/${o.name}`;
    lines.push(
      `echo "Uploading ${o.component}/${o.name}..."`,
      `ART=${sq(artPath)}`,
      `[ -f "$ART" ] || { echo "ERROR: archive is missing ${o.component}/${o.name}"; exit 1; }`,
      `TOKEN="$(cat ${IMPORT_CREDS_MOUNT_PATH}/${o.tokenKey})"`,
      `[ -n "$TOKEN" ] || { echo "ERROR: upload token missing for ${o.component}"; exit 1; }`,
      // --upload-file already implies PUT, which is what the internal route
      // registers. -f so an HTTP error is a non-zero exit rather than a body.
      `curl -sS -f --retry 3 --retry-delay 2 --max-time 600 --upload-file "$ART" ${sq(url)}"?token=$TOKEN" > /dev/null `
        + `|| { echo "ERROR: object upload failed for ${o.component}/${o.name}"; exit 1; }`,
      `OSIZE=$(wc -c < "$ART" | tr -d " ")`,
      `echo "IMPORT_OBJECT_DONE importId=${input.importId} component=${o.component} name=${o.name} sizeBytes=\${OSIZE:-0}"`,
      `rm -f "$ART"`,
    );
  }

  lines.push(`echo "IMPORT_DONE importId=${input.importId} units=${input.units.length} objects=${objects.length}"`);
  return lines.join('\n');
}

/** Build the whole Job manifest. Mirrors components/files.ts's shape. */
export function buildImportJobSpec(input: BuildImportJobInput): Record<string, unknown> {
  const labels = {
    'platform.io/component': 'bundle-import',
    'platform.io/tenant-id': input.tenantId,
    'platform.io/import-id': input.importId,
    'platform.io/backup-id': input.bundleId,
  };

  const podSpec: Record<string, unknown> = {
    restartPolicy: 'Never',
    containers: [{
      name: 'import',
      image: input.image ?? TOOLS_IMAGE_DEFAULT,
      command: ['/bin/sh', '-c', buildImportScript(input)],
      volumeMounts: [
        // Read-only: the import must never be able to mutate tenant files. It
        // only reads the archive it was told to read.
        { name: 'source', mountPath: IMPORT_SOURCE_ROOT, readOnly: true },
        { name: 'stage', mountPath: IMPORT_STAGE_ROOT },
        { name: 'scratch', mountPath: '/tmp' },
        { name: 'restic-creds', mountPath: IMPORT_CREDS_MOUNT_PATH, readOnly: true },
      ],
    }],
    volumes: [
      { name: 'source', persistentVolumeClaim: { claimName: input.pvcName, readOnly: true } },
      // sizeLimit is the containment: the kubelet evicts this Job rather than
      // filling the node root disk when a manifest under-declared its sizes.
      { name: 'stage', emptyDir: { sizeLimit: input.stageSizeLimit } },
      { name: 'scratch', emptyDir: { sizeLimit: SCRATCH_SIZE } },
      { name: 'restic-creds', secret: { secretName: input.credsSecretName, defaultMode: 0o400 } },
    ],
  };
  if (input.pinToNode) podSpec.nodeName = input.pinToNode;

  const deadline = input.activeDeadlineSeconds && input.activeDeadlineSeconds > 0
    ? { activeDeadlineSeconds: input.activeDeadlineSeconds }
    : {};

  // The spec is inlined after `kind: 'Job'` rather than built above and
  // referenced: ci-job-ttl-check scans FORWARD from the `kind` line for
  // `ttlSecondsAfterFinished`, so a TTL declared earlier reads to the guard
  // as no TTL at all.
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: input.jobName, namespace: input.namespace, labels },
    spec: {
      // No retries: a re-run would re-extract and re-snapshot, producing a
      // second set of snapshots for the same import. The caller decides
      // whether to retry.
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      ...deadline,
      template: { metadata: { labels }, spec: podSpec },
    },
  };
}

export interface ParsedUnitResult {
  readonly component: string;
  readonly name: string;
  readonly snapshotId: string;
  readonly sizeBytes: number;
  readonly addedBytes: number;
}

/**
 * Parse `IMPORT_UNIT_DONE` lines out of the Job log.
 *
 * Only a 64-hex snapshot id is accepted. `backup_components.sha256` is read
 * back as a restic snapshot id by every restore and browse path, and
 * `buildMailboxesByAddressJobSpec` throws on a malformed one — so a partial
 * parse must produce NO row rather than a row that fails later.
 */
export function parseImportUnitResults(log: string): ParsedUnitResult[] {
  const out: ParsedUnitResult[] = [];
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('IMPORT_UNIT_DONE ')) continue;
    const field = (k: string): string | null => {
      const m = line.match(new RegExp(`\\b${k}=([^\\s]+)`));
      return m ? m[1]! : null;
    };
    const component = field('component');
    const name = field('name');
    const snapshotId = field('snapshot');
    if (!component || !name || !snapshotId) continue;
    if (!/^[0-9a-f]{64}$/.test(snapshotId)) continue;
    if (component !== 'files' && component !== 'mailboxes') continue;
    out.push({
      component,
      name,
      snapshotId,
      sizeBytes: Number(field('sizeBytes') ?? 0) || 0,
      addedBytes: Number(field('addedBytes') ?? 0) || 0,
    });
  }
  return out;
}

/** True when the Job printed its terminal success marker. */
/** An `IMPORT_OBJECT_DONE` line — a small component that reached the store. */
export interface ParsedObjectResult {
  readonly component: 'config' | 'secrets';
  readonly name: string;
  readonly sizeBytes: number;
}

/**
 * Parse `IMPORT_OBJECT_DONE` lines out of the Job log.
 *
 * Unlike a restic unit there is no snapshot id to validate, so the guard is
 * the component name: anything that is not `config`/`secrets` is dropped
 * rather than becoming a row naming a component this path never writes.
 */
export function parseImportObjectResults(log: string): ParsedObjectResult[] {
  const out: ParsedObjectResult[] = [];
  for (const line of log.split('\n')) {
    const m = line.trim().match(
      /^IMPORT_OBJECT_DONE importId=\S+ component=(\S+) name=(\S+) sizeBytes=(\d+)$/,
    );
    if (!m) continue;
    const component = m[1]!;
    if (component !== 'config' && component !== 'secrets') continue;
    out.push({ component, name: m[2]!, sizeBytes: Number(m[3]!) });
  }
  return out;
}

export function importCompleted(log: string, importId: string): boolean {
  return log.split('\n').some((l) => l.trim().startsWith(`IMPORT_DONE importId=${importId} `));
}
