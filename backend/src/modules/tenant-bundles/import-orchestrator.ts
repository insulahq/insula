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
import { eq } from 'drizzle-orm';

import { backupJobs, backupComponents, backupConfigurations } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';
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

/** Bundles created by upload carry this label so they are distinguishable. */
export const MANUAL_IMPORT_LABEL = 'manual-import';

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

  const [cfg] = await deps.db.select().from(backupConfigurations)
    .where(eq(backupConfigurations.id, input.targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  if (!cfg.active) {
    throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.name} is not active`, 400);
  }

  const bundleId = `bkp-${randomUUID()}`;
  const progress = async (msg: string): Promise<void> => { await input.onProgress?.(msg); };

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

  // ── Reserve the bundle + register the row the uploads resolve through ────
  const store = await resolveStoreOrThrow(deps, input.targetConfigId);
  const handle = await store.reserveBundle({ backupId: bundleId, tenantId: input.tenantId });

  const targetKind = cfg.storageType as 's3' | 'ssh' | 'hostpath';
  const retentionDays = input.retentionDays ?? 30;
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
    description: preflight.sourceBundleId
      ? `Imported from uploaded bundle ${preflight.sourceBundleId}`
      : 'Imported from an uploaded bundle',
    sizeBytes: 0,
    repoLayout: layout,
    retentionDays,
    expiresAt: null,
    exportMode: null,
    startedAt: new Date(),
    lastError: null,
  });

  // ── Creds Secret: repo URIs per component + one upload token per artifact ─
  const credsSecretName = `imp-creds-${input.importId}`.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 63);
  const jobName = `bundle-import-${input.importId}`.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 63);

  const objectArtifacts: ImportObjectUpload[] = preflight.objectArtifacts.map((a) => ({
    component: a.component,
    name: artifactNameFor(a.component),
    tokenKey: `upload_token_${a.component}`,
  }));

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

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const writtenByRepo = new Map<string, string[]>();
  let succeeded = false;
  let credsCreated = false;

  try {
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

    await waitForJob(deps.k8s, input.namespace, jobName, timeoutMs, progress);

    const log = (await readJobLogTail(deps.k8s, input.namespace, jobName, { tailLines: 400 })) ?? '';
    const units = parseImportUnitResults(log);
    const objects = parseImportObjectResults(log);

    // Record what landed BEFORE judging success — a partial run still has to
    // be cleaned up, and these ids are the only handle on those snapshots.
    for (const u of units) {
      const repoUri = repoUriByComponent.get(u.component as 'files' | 'mailboxes');
      if (!repoUri) continue;
      const list = writtenByRepo.get(repoUri) ?? [];
      list.push(u.snapshotId);
      writtenByRepo.set(repoUri, list);
    }

    assertImportComplete(log, input.importId, preflight, units, objects);

    // ── Only now do rows appear ───────────────────────────────────────────
    const sizeBytes = units.reduce((a, u) => a + u.sizeBytes, 0)
      + objects.reduce((a, o) => a + o.sizeBytes, 0);
    const addedBytes = units.reduce((a, u) => a + u.addedBytes, 0);

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

    await store.putMeta(handle, buildImportedMeta({
      bundleId,
      input,
      preflight,
      units,
      objects,
      platformVersion: deps.platformVersion,
      retentionDays,
    }) as never);

    await deps.db.update(backupJobs)
      .set({ status: 'completed', sizeBytes, resticAddedBytes: addedBytes, finishedAt: new Date() })
      .where(eq(backupJobs.id, bundleId));

    succeeded = true;
    await progress('Import complete.');
    return { bundleId, units, objects, sizeBytes };
  } catch (err) {
    // ── Failure teardown: leave nothing behind ──────────────────────────────
    if (writtenByRepo.size > 0) {
      await forgetImportSnapshots({ target, passwordHex, byRepo: writtenByRepo, log: deps.log });
    }
    try { await store.delete(handle); } catch (e) {
      deps.log.warn({ bundleId, err: e instanceof Error ? e.message : String(e) },
        'bundle-import: could not drop the reserved bundle after a failed import');
    }
    await deleteAbortedImportRow(deps.db, bundleId);
    throw err;
  } finally {
    // The uploaded archive goes on BOTH paths — it is the artifact that
    // silently eats the tenant's quota if it survives.
    await reapImportUpload(deps.fm, input.namespace, input.archiveRelPath, deps.log);
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

/** meta.json for the newly created bundle. Source values are NOT carried over. */
export function buildImportedMeta(args: {
  bundleId: string;
  input: RunBundleImportInput;
  preflight: ImportPreflight;
  units: ReadonlyArray<ParsedUnitResult>;
  objects: ReadonlyArray<{ component: string; name: string; sizeBytes: number }>;
  platformVersion: string;
  retentionDays: number;
}): Record<string, unknown> {
  const components: Record<string, unknown> = {};
  for (const u of args.units) {
    const bucket = (components[u.component] ?? { sizeBytes: 0 }) as Record<string, unknown>;
    bucket.sizeBytes = (bucket.sizeBytes as number) + u.sizeBytes;
    if (u.component === 'mailboxes') {
      const addrs = (bucket.addresses as string[] | undefined) ?? [];
      addrs.push(u.name);
      bucket.addresses = addrs;
    }
    components[u.component] = bucket;
  }
  for (const o of args.objects) components[o.component] = { sizeBytes: o.sizeBytes };

  return {
    backupId: args.bundleId,
    tenantId: args.input.tenantId,
    capturedAt: new Date().toISOString(),
    platformVersion: args.platformVersion,
    initiator: args.input.initiator,
    systemTrigger: null,
    label: buildImportLabel(args.input.label),
    components,
    nodePlacement: null,
    expiresAt: null,
    retentionDays: args.retentionDays,
    description: args.preflight.sourceBundleId
      ? `Imported from uploaded bundle ${args.preflight.sourceBundleId}`
      : 'Imported from an uploaded bundle',
    // Provenance: which upload this came from, so an operator can trace a
    // bundle back to the archive without reading the Job log.
    importedFrom: {
      sourceBundleId: args.preflight.sourceBundleId,
      sourceTenantId: args.preflight.sourceTenantId,
      importId: args.input.importId,
      scope: args.input.scope,
    },
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

async function resolveStoreOrThrow(
  deps: ImportRunnerDeps,
  targetConfigId: string,
): Promise<import('./bundle-store.js').BackupStore> {
  const { resolveBackupStore } = await import('./resolve-store.js');
  const store = await resolveBackupStore(deps.db, targetConfigId, deps.encryptionKey);
  if (!store) {
    throw new ApiError('NOT_IMPLEMENTED',
      'This backup target does not support bundle import.', 400);
  }
  return store;
}
