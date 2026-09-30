/**
 * Run a bundle import end to end (ADR-063).
 *
 * The shape mirrors a capture, because the whole point is that an imported
 * bundle is indistinguishable from a captured one — restore, browse, selective
 * restore and re-export then need no changes at all:
 *
 *   reserve bundle → init repo(s) → creds Secret → Job → watch → parse log
 *     → success: component rows + meta + `completed`
 *     → failure: forget partial snapshots, drop the bundle, drop the row
 *     → always:  delete the uploaded archive, delete the creds Secret
 *
 * ★ ORDERING IS THE CONTRACT. The `backup_jobs` row exists from the start
 * (the internal upload route resolves the store through it, so `config`/
 * `secrets` cannot upload without it) but only ever reaches `completed` —
 * and only then gain `backup_components` rows — once every unit succeeded.
 * A half-imported bundle must never be visible to the restore cart: either
 * the bundle is registered complete, or it does not exist.
 */
import { randomUUID } from 'node:crypto';
import {
  MANUAL_IMPORT_LABEL,
  BACKUP_META_SCHEMA_VERSION,
  type BackupMetaV1,
} from '@insula/api-contracts';
import { eq } from 'drizzle-orm';

import { backupJobs, backupComponents, backupConfigurations } from '../../db/schema.js';
import { storeKindToTargetKind } from './bundle-store.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';
import { requireWritableTarget } from '../backup-config/writable-guard.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { readJobLogTail } from '../storage-lifecycle/job-log-tail.js';
import { waitForJob } from '../backup-restore/executors/files-paths.js';
import {
  buildResticCredsStringData,
  createResticCredsSecret,
  wireSecretOwnerRef,
} from './components/files.js';
import {
  buildResticEnv,
  buildResticRepoUri,
  deriveResticPassword,
  ensureResticRepoInitialised,
  type BackupTarget,
} from './restic-driver.js';
import { makeRepoInitSerialiser } from './repo-init-lock.js';
import {
  captureTenantBlock,
  captureDomainsSummary,
  captureDeploymentsSummary,
} from './orchestrator.js';
import { CURRENT_REPO_LAYOUT } from './repo-layout.js';
import {
  buildImportJobSpec,
  importCompleted,
  parseImportObjectResults,
  parseImportUnitResults,
  repoUriKey,
  type ImportObjectUpload,
  type ParsedUnitResult,
} from './import-job.js';
import { signUploadToken } from './upload-token.js';
import {
  deleteAbortedImportRow,
  forgetImportSnapshots,
  reapImportUpload,
  type FileManagerGateway,
  type ReapLog,
} from './import-reaper.js';
import type { ImportPreflight, ImportScope } from './import-preflight.js';

/**
 * Bundles created by upload carry this label so they are distinguishable.
 *
 * Re-exported from `@insula/api-contracts` rather than redeclared — both
 * panels render it and the backend writes it, and a second declaration is
 * exactly how those drift apart.
 */
export { MANUAL_IMPORT_LABEL } from '@insula/api-contracts';

/** Upload tokens outlive the Job's own deadline by a margin, nothing more. */
const UPLOAD_TOKEN_TTL_SECONDS = 60 * 60;

const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6h — a bundle can be large
const JOB_DEADLINE_BUFFER_SEC = 120;

export interface ImportRunnerDeps {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly fm: FileManagerGateway;
  readonly log: ReapLog;
  /** `PLATFORM_ENCRYPTION_KEY` — derives the restic password and signs tokens. */
  readonly encryptionKey: string;
  /** e.g. `http://platform-api.platform.svc:3000`. */
  readonly platformApiUrl: string;
  readonly platformVersion: string;
}

export interface RunBundleImportInput {
  readonly tenantId: string;
  readonly namespace: string;
  readonly pvcName: string;
  readonly importId: string;
  /** Path of the uploaded archive relative to the tenant file root. */
  readonly archiveRelPath: string;
  readonly targetConfigId: string;
  readonly preflight: ImportPreflight;
  readonly scope: ImportScope;
  readonly initiator: 'admin' | 'tenant';
  /** Operator-supplied note, appended to the `manual-import` label. */
  readonly label?: string | null;
  readonly retentionDays?: number;
  readonly onProgress?: (msg: string) => Promise<void> | void;
  readonly timeoutMs?: number;
  readonly pinToNode?: string;
}

export interface BundleImportResult {
  readonly bundleId: string;
  readonly units: ReadonlyArray<ParsedUnitResult>;
  readonly objects: ReadonlyArray<{ component: string; name: string; sizeBytes: number }>;
  readonly sizeBytes: number;
}

/** `manual-import`, plus the operator's note when they gave one. */
export function buildImportLabel(note?: string | null): string {
  const trimmed = (note ?? '').trim();
  return (trimmed ? `${MANUAL_IMPORT_LABEL}: ${trimmed}` : MANUAL_IMPORT_LABEL).slice(0, 255);
}

/** Canonical object-store filename for a small component. */
function artifactNameFor(component: 'config' | 'secrets'): string {
  return component === 'config' ? 'db-rows.json.gz' : 'tls.json.gz.enc';
}

export async function runBundleImport(
  deps: ImportRunnerDeps,
  input: RunBundleImportInput,
): Promise<BundleImportResult> {
  const { preflight } = input;
  if (preflight.blocked) {
    // Defence in depth: the route checks this too, but a blocked preflight
    // must never be able to reach a Job by another path.
    throw new ApiError('IMPORT_BLOCKED', preflight.blockReasons.join(' '), 409);
  }
  if (preflight.units.length === 0) {
    throw new ApiError('IMPORT_BLOCKED', 'This archive carries no files or mailboxes to import.', 409);
  }

  // A FROZEN target must refuse new writes — an operator freezes one while
  // decommissioning it or after restoring it from DR, and an import is a
  // write like any other. `active` alone does not cover this: a frozen
  // target is still active for reads.
  await requireWritableTarget(deps.db, input.targetConfigId);

  const [cfg] = await deps.db.select().from(backupConfigurations)
    .where(eq(backupConfigurations.id, input.targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  // ★ `enabled`, NOT `active`. `active` is the Longhorn-BackupTarget
  // designator — at most ONE row per cluster may carry it, and the schema
  // states it is "not consulted by the shim path (… tenant-bundles …)".
  // Gating on it would have refused almost every real target, and the
  // failure would have looked like a misconfigured backup rather than a
  // wrong column. `enabled` is the operator's on/off switch.
  if (cfg.enabled === 0) {
    throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.name} is disabled`, 400);
  }

  const bundleId = `bkp-${randomUUID()}`;
  const credsSecretName = `imp-creds-${input.importId}`.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 63);
  const jobName = importJobName(input.importId);
  const progress = async (msg: string): Promise<void> => { await input.onProgress?.(msg); };

  // ── Refuse a duplicate before touching anything ─────────────────────────
  // Two calls with the same importId (double-click, a client retry after a
  // timed-out-but-successful request, two tabs) derive the SAME Job name and
  // the SAME archive path. Without this the loser's `finally` would delete
  // the archive the winner's Job is still extracting from.
  if (await importJobExists(deps, input.namespace, jobName)) {
    throw new ApiError('IMPORT_IN_PROGRESS',
      'An import with this id is already running for this tenant. Wait for it to finish, or start a new import.', 409);
  }

  // ── Repos: one URI per component present (per-component layout splits them)
  const target = await resolveTargetForImport(deps, cfg);
  const passwordHex = deriveResticPassword(deps.encryptionKey, input.tenantId);
  const layout = CURRENT_REPO_LAYOUT;
  const components = [...new Set(preflight.units.map((u) => u.component))];
  const repoUriByComponent = new Map<'files' | 'mailboxes', string>();
  for (const c of components) {
    repoUriByComponent.set(c, buildResticRepoUri(target, input.tenantId, c, layout));
  }

  await progress('Preparing the destination repository…');
  for (const repoUri of new Set(repoUriByComponent.values())) {
    // In-process and BEFORE the Job: a destination that cannot be initialised
    // (bad credentials, unreachable bucket) must fail here, where the error is
    // legible, rather than as a Job that exits non-zero for opaque reasons.
    await ensureResticRepoInitialised({
      target,
      passwordHex,
      repoUri,
      serialise: makeRepoInitSerialiser(deps.db, { warn: (m) => deps.log.warn({}, m) }),
      log: { warn: (m) => deps.log.warn({}, m) },
    });
  }

  const objectArtifacts: ImportObjectUpload[] = preflight.objectArtifacts.map((a) => ({
    component: a.component,
    name: artifactNameFor(a.component),
    tokenKey: `upload_token_${a.component}`,
  }));

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const writtenByRepo = new Map<string, string[]>();
  const retentionDays = input.retentionDays ?? 30;
  let succeeded = false;
  let credsCreated = false;
  let store: import('./bundle-store.js').BackupStore | null = null;
  let handle: import('./bundle-store.js').BundleHandle | null = null;
  let rowInserted = false;

  try {
    // Reservation and row are INSIDE the try: a failure between them used to
    // leak the store-side reservation, because the only `store.delete` lives
    // in the catch below.
    store = await resolveStoreOrThrow(deps, input.targetConfigId);
    handle = await store.reserveBundle({ backupId: bundleId, tenantId: input.tenantId });

    // ★ Derived from the resolved STORE, not from `cfg.storageType`. The
    // `backup_target_kind` enum has only hostpath/s3/ssh — a `cifs` config
    // (what real clusters use since S3 was retired) is served by the rclone
    // shim, whose store kind maps to `s3`. Writing storageType straight in
    // fails the insert with "invalid input value for enum backup_target_kind".
    const targetKind = storeKindToTargetKind(store.kind);
    await deps.db.insert(backupJobs).values({
      id: bundleId,
      tenantId: input.tenantId,
      initiator: input.initiator,
      systemTrigger: null,
      // `running`, NOT `completed`: the row must exist for the internal upload
      // route to resolve a store, but it must not look like a usable bundle
      // until every unit has landed.
      status: 'running',
      targetKind,
      targetUri: `${targetKind}://${cfg.id}`,
      targetConfigId: input.targetConfigId,
      label: buildImportLabel(input.label),
      description: describeImport(input.importId, preflight.sourceBundleId),
      sizeBytes: 0,
      repoLayout: layout,
      retentionDays,
      expiresAt: null,
      exportMode: null,
      startedAt: new Date(),
      lastError: null,
    });
    rowInserted = true;

    // ── Creds Secret: repo URIs per component + one upload token per artifact
    const stringData: Record<string, string> = buildResticCredsStringData({
      passwordHex,
      // `repo_uri` stays populated for any shared tooling that expects it; the
      // import script reads the per-component keys below.
      repoUri: repoUriByComponent.get(components[0]!)!,
      env: buildResticEnv(target),
    });
    for (const [component, uri] of repoUriByComponent) stringData[repoUriKey(component)] = uri;
    for (const a of objectArtifacts) {
      stringData[a.tokenKey] = signUploadToken(
        { bundleId, component: a.component, artifactName: a.name, ttlSeconds: UPLOAD_TOKEN_TTL_SECONDS },
        deps.encryptionKey,
      );
    }

    await createResticCredsSecret(deps.k8s, input.namespace, credsSecretName, stringData, 'bundle-import');
    credsCreated = true;

    const spec = buildImportJobSpec({
      jobName,
      namespace: input.namespace,
      tenantId: input.tenantId,
      importId: input.importId,
      bundleId,
      pvcName: input.pvcName,
      archiveRelPath: input.archiveRelPath,
      units: preflight.units,
      credsSecretName,
      stageSizeLimit: preflight.stageSizeLimit,
      objectArtifacts,
      internalApiBase: deps.platformApiUrl,
      pinToNode: input.pinToNode,
      activeDeadlineSeconds: Math.max(60, Math.ceil(timeoutMs / 1000) - JOB_DEADLINE_BUFFER_SEC),
    });

    await progress('Extracting and re-ingesting the bundle…');
    const created = await (deps.k8s.batch as unknown as {
      createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<{ metadata?: { uid?: string } }>;
    }).createNamespacedJob({ namespace: input.namespace, body: spec });

    const jobUid = created.metadata?.uid;
    if (jobUid) {
      try {
        await wireSecretOwnerRef(deps.k8s, input.namespace, credsSecretName, jobName, jobUid);
      } catch (err) {
        deps.log.warn(
          { credsSecretName, err: err instanceof Error ? err.message : String(err) },
          'bundle-import: could not ownerRef the creds Secret; it is deleted explicitly instead',
        );
      }
    }

    // ★ Fail fast when the Job cannot create a pod at all. `backoffLimit: 0`
    // bounds pod FAILURES, not pod CREATE failures — a quota rejection makes
    // the job-controller retry creation forever, so the Job sits in
    // `Running 0/1` and `waitForJob` blocks for the whole deadline (hours).
    // Observed on DEV before the priorityClass/resources fix landed.
    await assertJobCanSchedule(deps, input.namespace, jobName);

    let log = '';
    try {
      await waitForJob(deps.k8s, input.namespace, jobName, timeoutMs, progress);
    } finally {
      // ★ Read the log on BOTH paths. `waitForJob` throws the moment the Job
      // reports Failed — and a Job that failed on unit 2 still WROTE unit 1's
      // snapshot. Those ids exist only in the log, so reading it only on the
      // success path left every partial snapshot orphaned in the repo, with
      // nothing referencing it and retention unable to reclaim it.
      log = await readImportLog(deps, input.namespace, jobName, preflight.units.length);
      for (const u of parseImportUnitResults(log)) {
        const repoUri = repoUriByComponent.get(u.component as 'files' | 'mailboxes');
        if (!repoUri) continue;
        const list = writtenByRepo.get(repoUri) ?? [];
        list.push(u.snapshotId);
        writtenByRepo.set(repoUri, list);
      }
    }

    const units = parseImportUnitResults(log);
    const objects = parseImportObjectResults(log);
    assertImportComplete(log, input.importId, preflight, units, objects);

    // ── Only now do rows appear ───────────────────────────────────────────
    const sizeBytes = units.reduce((a, u) => a + u.sizeBytes, 0)
      + objects.reduce((a, o) => a + o.sizeBytes, 0);
    const addedBytes = units.reduce((a, u) => a + u.addedBytes, 0);

    // ★ Re-check the quota against what ACTUALLY landed. The preflight's
    // check ran on sizes declared by the uploaded manifest, which is an
    // assertion by whoever built the archive — a bundle declaring
    // `sizeBytes: 0` would sail through it and then park arbitrary data on a
    // shared, admin-managed target. This is the same question asked of the
    // only number that is measured. Throwing here runs the teardown below,
    // so the oversized snapshots are forgotten rather than left behind.
    if (preflight.quota.limitBytes > 0 && sizeBytes > preflight.quota.limitBytes) {
      throw new ApiError(
        'IMPORT_EXCEEDS_QUOTA',
        `The imported data is ${Math.ceil(sizeBytes / 1024 ** 3)} GiB, which exceeds this tenant's `
        + `${Math.floor(preflight.quota.limitBytes / 1024 ** 3)} GiB storage allowance. `
        + 'Nothing has been registered. Raise the plan or import a smaller bundle.',
        409,
      );
    }

    await deps.db.insert(backupComponents).values([
      ...units.map((u) => ({
        id: randomUUID(),
        backupJobId: bundleId,
        component: u.component as 'files' | 'mailboxes',
        artifactName: u.name,
        status: 'completed' as const,
        sizeBytes: u.sizeBytes,
        // For a restic component this column holds the SNAPSHOT ID — every
        // restore and browse path reads it back as one.
        sha256: u.snapshotId,
        startedAt: new Date(),
        finishedAt: new Date(),
      })),
      ...objects.map((o) => ({
        id: randomUUID(),
        backupJobId: bundleId,
        component: o.component as 'config' | 'secrets',
        artifactName: o.name,
        status: 'completed' as const,
        sizeBytes: o.sizeBytes,
        sha256: null,
        startedAt: new Date(),
        finishedAt: new Date(),
      })),
    ]);

    await store.putMeta(handle, await buildImportedMeta({
      db: deps.db,
      bundleId,
      input,
      preflight,
      units,
      objects,
      platformVersion: deps.platformVersion,
      retentionDays,
    }));

    await deps.db.update(backupJobs)
      .set({ status: 'completed', sizeBytes, resticAddedBytes: addedBytes, finishedAt: new Date() })
      .where(eq(backupJobs.id, bundleId));

    // ★ Nothing that can throw may run between here and `return` unguarded —
    // past this line the bundle is REGISTERED, and the catch below would
    // delete the data it points at. The progress call is therefore wrapped.
    succeeded = true;
    try { await progress('Import complete.'); } catch { /* cosmetic only */ }
    return { bundleId, units, objects, sizeBytes };
  } catch (err) {
    // ★ Guarded on `succeeded`. Without it, a throw AFTER the bundle was
    // registered would forget its snapshots and delete its artefacts while
    // `deleteAbortedImportRow` (which skips `completed` rows by design) left
    // the row behind — a bundle that is registered complete and has no data,
    // the exact inverse of the invariant this module exists to hold.
    if (!succeeded) {
      if (writtenByRepo.size > 0) {
        await forgetImportSnapshots({ target, passwordHex, byRepo: writtenByRepo, log: deps.log });
      }
      if (store && handle) {
        try { await store.delete(handle); } catch (e) {
          deps.log.warn({ bundleId, err: e instanceof Error ? e.message : String(e) },
            'bundle-import: could not drop the reserved bundle after a failed import');
        }
      }
      if (rowInserted) {
        // Guarded: an unwrapped throw here would replace the operator-legible
        // original failure with an opaque DB error.
        try { await deleteAbortedImportRow(deps.db, bundleId); } catch (e) {
          deps.log.warn({ bundleId, err: e instanceof Error ? e.message : String(e) },
            'bundle-import: could not delete the aborted bundle row');
        }
      }
    }
    throw err;
  } finally {
    // ★ The uploaded archive is deleted on SUCCESS only.
    //
    // It is the one artifact here the import did NOT create — the user
    // uploaded it, into their own file space, before any of this ran. On
    // success it has been consumed and keeping it would silently double the
    // bundle's cost against their quota. On FAILURE deleting it makes the
    // obvious next step — retry — cost a full re-upload of a multi-GB file,
    // for a failure that was usually not theirs. It is kept, the retry is
    // cheap, and `sweepAbandonedImportUploads` reclaims it if they never
    // come back (age-gated, and it skips uploads whose import is live).
    if (succeeded) {
      await reapImportUpload(deps.fm, input.namespace, input.archiveRelPath, deps.log);
    } else {
      deps.log.warn(
        { namespace: input.namespace, archiveRelPath: input.archiveRelPath },
        'bundle-import: import failed — the uploaded archive is kept so a retry need not re-upload; '
        + 'the abandoned-upload sweeper reclaims it if no retry follows',
      );
    }
    if (credsCreated) {
      try {
        await (deps.k8s.core as unknown as {
          deleteNamespacedSecret: (a: { name: string; namespace: string }) => Promise<unknown>;
        }).deleteNamespacedSecret({ name: credsSecretName, namespace: input.namespace });
      } catch { /* ownerRef GC is the backstop */ }
    }
    if (!succeeded) {
      try {
        await (deps.k8s.batch as unknown as {
          deleteNamespacedJob: (a: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
        }).deleteNamespacedJob({ name: jobName, namespace: input.namespace, propagationPolicy: 'Background' });
      } catch { /* ttlSecondsAfterFinished is the backstop */ }
    }
  }
}


/** How long a Job gets to produce its first pod before we call it stuck. */
const POD_APPEAR_TIMEOUT_MS = 90_000;
const POD_APPEAR_POLL_MS = 3_000;

/**
 * Wait for the Job's first pod, or explain why it will never come.
 *
 * A pod that has not appeared within the window is almost always a quota or
 * scheduling rejection, and the reason is only in the Job's events. Surfacing
 * it beats a timeout hours later whose message says nothing.
 */
export async function assertJobCanSchedule(
  deps: ImportRunnerDeps,
  namespace: string,
  jobName: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const core = deps.k8s.core as unknown as {
    listNamespacedPod: (a: { namespace: string; labelSelector?: string }) => Promise<{ items?: unknown[] }>;
    listNamespacedEvent?: (a: { namespace: string; fieldSelector?: string }) => Promise<{
      items?: Array<{ reason?: string; message?: string; involvedObject?: { name?: string } }>;
    }>;
  };
  const deadline = Date.now() + (opts.timeoutMs ?? POD_APPEAR_TIMEOUT_MS);
  for (;;) {
    try {
      const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}` });
      if ((pods.items ?? []).length > 0) return;
    } catch {
      // A listing hiccup must not fail a Job that is otherwise fine; the
      // normal waitForJob deadline remains the backstop.
      return;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? POD_APPEAR_POLL_MS));
  }

  let detail = '';
  try {
    const events = await core.listNamespacedEvent?.({ namespace });
    const failed = (events?.items ?? []).find(
      (e) => e.reason === 'FailedCreate' && e.involvedObject?.name === jobName,
    );
    if (failed?.message) detail = ` ${failed.message}`;
  } catch { /* events are a nicety, not a requirement */ }

  throw new ApiError(
    'IMPORT_JOB_UNSCHEDULABLE',
    `The import job could not start a pod within ${Math.round((opts.timeoutMs ?? POD_APPEAR_TIMEOUT_MS) / 1000)}s — `
    + `usually the tenant namespace's resource quota.${detail} Nothing has been registered.`,
    409,
  );
}

/** Deterministic Job name for an import — also the duplicate-detection key. */
export function importJobName(importId: string): string {
  return `bundle-import-${importId}`.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 63);
}

/** Description carrying the importId, so the sweeper can correlate uploads. */
export function describeImport(importId: string, sourceBundleId: string | null): string {
  return sourceBundleId
    ? `Imported from uploaded bundle ${sourceBundleId} [import:${importId}]`
    : `Imported from an uploaded bundle [import:${importId}]`;
}

/** True when an import Job with this name already exists in the namespace. */
async function importJobExists(
  deps: ImportRunnerDeps,
  namespace: string,
  jobName: string,
): Promise<boolean> {
  try {
    await (deps.k8s.batch as unknown as {
      readNamespacedJob: (a: { name: string; namespace: string }) => Promise<unknown>;
    }).readNamespacedJob({ name: jobName, namespace });
    return true;
  } catch {
    // A 404 is the expected case. Any other read failure is treated as
    // "absent" rather than blocking a legitimate import on a transient
    // API hiccup — the Job create itself 409s if it really does exist.
    return false;
  }
}

/**
 * Read enough of the Job log to see EVERY unit line.
 *
 * A fixed `tailLines` silently truncates: each unit emits 2-3 lines, so a
 * tenant with a few hundred mailboxes pushes the early `IMPORT_UNIT_DONE`
 * lines out of the window. `assertImportComplete` would then reject a
 * genuinely complete import — and, worse, the truncated-out snapshots would
 * be invisible to the cleanup that is supposed to forget them.
 */
async function readImportLog(
  deps: ImportRunnerDeps,
  namespace: string,
  jobName: string,
  unitCount: number,
): Promise<string> {
  const tailLines = Math.max(400, unitCount * 4 + 200);
  try {
    return (await readJobLogTail(deps.k8s, namespace, jobName, { tailLines })) ?? '';
  } catch (err) {
    deps.log.warn(
      { jobName, err: err instanceof Error ? err.message : String(err) },
      'bundle-import: could not read the Job log',
    );
    return '';
  }
}


/**
 * Fail unless the Job reported EVERY promised unit and artifact.
 *
 * `IMPORT_DONE` alone is not enough: a log that was truncated, or a unit whose
 * snapshot id failed validation and was dropped by the parser, would otherwise
 * register a bundle with fewer components than the operator was shown.
 */
export function assertImportComplete(
  log: string,
  importId: string,
  preflight: ImportPreflight,
  units: ReadonlyArray<{ component: string; name: string }>,
  objects: ReadonlyArray<{ component: string; name: string }>,
): void {
  if (!importCompleted(log, importId)) {
    throw new ApiError('IMPORT_FAILED',
      'The import Job did not report completion. Nothing has been registered.', 500);
  }
  const got = new Set(units.map((u) => `${u.component}/${u.name}`));
  const missing = preflight.units
    .map((u) => `${u.component}/${u.name}`)
    .filter((k) => !got.has(k));
  if (missing.length > 0) {
    throw new ApiError('IMPORT_INCOMPLETE',
      `The import did not produce a snapshot for: ${missing.slice(0, 5).join(', ')}. Nothing has been registered.`, 500);
  }
  const gotObjects = new Set(objects.map((o) => o.component));
  const missingObjects = preflight.objectArtifacts
    .map((a) => a.component)
    .filter((c) => !gotObjects.has(c));
  if (missingObjects.length > 0) {
    throw new ApiError('IMPORT_INCOMPLETE',
      `The import did not upload: ${missingObjects.join(', ')}. Nothing has been registered.`, 500);
  }
}

/**
 * meta.json for the newly created bundle.
 *
 * ★ Built the SAME way capture builds it — `captureTenantBlock` /
 * `captureDomainsSummary` / `captureDeploymentsSummary` off the TARGET
 * tenant — because "an imported bundle is indistinguishable from a captured
 * one" is the whole premise of ADR-063, and `putMeta` validates against
 * `backupMetaV2Schema`. An ad-hoc object shaped by hand failed that
 * validation on the first real run, AFTER the snapshots were written.
 *
 * Source values are deliberately NOT carried over: the source tenant's plan,
 * namespace and limits describe a different cluster. What IS carried is
 * provenance, under `description`.
 */
export async function buildImportedMeta(args: {
  db: Database;
  bundleId: string;
  input: RunBundleImportInput;
  preflight: ImportPreflight;
  units: ReadonlyArray<ParsedUnitResult>;
  objects: ReadonlyArray<{ component: string; name: string; sizeBytes: number }>;
  platformVersion: string;
  retentionDays: number;
}): Promise<BackupMetaV1> {
  const sourceComponents = args.preflight.sourceComponents ?? {};

  const filesUnit = args.units.find((u) => u.component === 'files');
  const mailboxUnits = args.units.filter((u) => u.component === 'mailboxes');

  const components: Record<string, unknown> = {};
  if (filesUnit) {
    components.files = {
      sizeBytes: filesUnit.sizeBytes,
      fileCount: filesUnit.fileCount,
      sha256: filesUnit.snapshotId,
    };
  }
  if (mailboxUnits.length > 0) {
    const addresses = mailboxUnits.map((u) => u.name).filter((n) => n.includes('@'));
    components.mailboxes = {
      sizeBytes: mailboxUnits.reduce((a, u) => a + u.sizeBytes, 0),
      mailboxCount: addresses.length,
      addresses,
      // ADR-061: one snapshot per mailbox, keyed by address. The legacy
      // whole-tenant shape has no addresses and keeps the flat `sha256`.
      ...(addresses.length > 0
        ? { snapshots: Object.fromEntries(mailboxUnits.filter((u) => u.name.includes('@')).map((u) => [u.name, u.snapshotId])) }
        : { sha256: mailboxUnits[0]!.snapshotId }),
    };
  }
  for (const o of args.objects) {
    if (o.component === 'config') {
      components.config = {
        sizeBytes: o.sizeBytes,
        rowCount: Number((sourceComponents.config ?? {}).rowCount ?? 0) || 0,
      };
    }
    if (o.component === 'secrets') {
      components.secrets = {
        sizeBytes: o.sizeBytes,
        secretCount: Number((sourceComponents.secrets ?? {}).secretCount ?? 0) || 0,
        encryptionKeyId: String((sourceComponents.secrets ?? {}).encryptionKeyId ?? 'k1'),
      };
    }
  }

  const tenantBlock = await captureTenantBlock(args.db, args.input.tenantId);
  const domainsSummary = [...(await captureDomainsSummary(args.db, args.input.tenantId))];
  const deploymentsSummary = [...(await captureDeploymentsSummary(args.db, args.input.tenantId))];

  return {
    schemaVersion: BACKUP_META_SCHEMA_VERSION,
    backupId: args.bundleId,
    tenantId: args.input.tenantId,
    capturedAt: new Date().toISOString(),
    platformVersion: args.platformVersion,
    initiator: args.input.initiator,
    systemTrigger: null,
    label: buildImportLabel(args.input.label),
    components: components as BackupMetaV1['components'],
    nodePlacement: tenantBlock.nodeName
      ? { preferredNode: tenantBlock.nodeName, preferredRegion: tenantBlock.regionId }
      : null,
    expiresAt: null,
    retentionDays: args.retentionDays,
    // Provenance: which upload this came from, so a bundle traces back to the
    // archive without reading the Job log.
    description: describeImport(args.input.importId, args.preflight.sourceBundleId),
    tenant: tenantBlock,
    domainsSummary,
    deploymentsSummary,
    repoLayout: CURRENT_REPO_LAYOUT,
  };
}

async function resolveTargetForImport(
  deps: ImportRunnerDeps,
  cfg: typeof backupConfigurations.$inferSelect,
): Promise<BackupTarget> {
  const { resolveShimBackupTarget } = await import('./resolve-backup-target.js');
  void cfg;
  return resolveShimBackupTarget(deps.k8s.core, 'tenant', deps.log as never);
}

/**
 * Resolve the bundle store exactly the way CAPTURE does: shim first.
 *
 * ★ The B9 rclone-shim mediates every upstream protocol, and the direct
 * cfg-based resolver only understands `s3` and `ssh` — it returns null for
 * `cifs`, which is what real clusters actually use since S3 was retired. A
 * direct-only resolution therefore fails on every live target: verified on
 * DEV, whose single target is `cifs`. Falls back to the direct resolver when
 * the shim key is not bootstrapped, mirroring `routes.ts:resolveStore`.
 */
async function resolveStoreOrThrow(
  deps: ImportRunnerDeps,
  targetConfigId: string,
): Promise<import('./bundle-store.js').BackupStore> {
  try {
    const { resolveShimBackupStore } = await import('./shim-backup-store.js');
    return await resolveShimBackupStore(deps.k8s.core, 'tenant', {
      log: { warn: (m: string) => deps.log.warn({}, m) },
    });
  } catch (err) {
    deps.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'bundle-import: shim store unavailable — falling back to the direct cfg resolver',
    );
  }
  const { resolveBackupStore } = await import('./resolve-store.js');
  // `requireActive: false` — `active` is the Longhorn-only column; the
  // `enabled` gate in runBundleImport is the real check.
  const store = await resolveBackupStore(deps.db, targetConfigId, deps.encryptionKey, { requireActive: false });
  if (!store) {
    throw new ApiError('NOT_IMPLEMENTED',
      `This backup target does not support bundle import (no shim, and no direct driver for its storage type).`, 400);
  }
  return store;
}
