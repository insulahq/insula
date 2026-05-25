/**
 * DR restore primitive (Unit B).
 *
 * Top-level entry consumed by:
 *   - `backend/src/cli/dr-restore-runner.ts` (the ts-node CLI shim
 *     `scripts/dr-restore-bundle.sh` invokes)
 *   - `platform-ops dr restore` (PR 10 of the holistic upgrade plan
 *     wraps this once the binary lands)
 *
 * Locked design (see ADR notes in db-import.ts):
 *   - mode='partial' only in this unit (B). mode='full' lands in Unit C.
 *   - PARTIAL imports only backup_configurations + backup_target_assignments.
 *   - Sidecars must be present in the bundle (A2 or later). Older
 *     bundles surface as LegacyBundleError; the caller decides
 *     whether to fall through to a Secrets-only restore.
 *
 * Not in this unit:
 *   - Bootstrap.sh invocation (caller's responsibility — cluster must
 *     already be live before runDrRestore is called)
 *   - Secrets application (`make secrets-restore` is the canonical
 *     path; we leave Secret-bundle YAMLs untouched on the restore side)
 *   - Mode='full' / CNPG bootstrap.recovery (Unit C)
 *   - Stalwart mailbox PVC restore (Unit C)
 *   - Tenant content restore (operator drives this via admin UI per
 *     the locked PARTIAL design)
 */

import { readBundle, BundleDecryptError, LegacyBundleError } from './bundle-reader.js';
import { importDrRows, probeClusterState, DrImportError, type ImportResult } from './db-import.js';
import type { Database } from '../../db/index.js';

export { BundleDecryptError, LegacyBundleError } from './bundle-reader.js';
export { DrImportError } from './db-import.js';
export type { ImportResult, DriftReport } from './db-import.js';
export { BundleVersionError } from '../system-backup/dr-sidecars.js';

export type DrRestoreMode = 'partial';

export interface RunDrRestoreOpts {
  readonly db: Database;
  readonly mode: DrRestoreMode;
  readonly bundlePath: string;
  readonly ageKeyPath: string;
  /** Live cluster config — used for drift detection. The CLI shim
   *  reads these from app.config; tests pass synthetic values. */
  readonly config: {
    readonly PLATFORM_BASE_DOMAIN?: string;
    readonly INGRESS_BASE_DOMAIN?: string;
    readonly PLATFORM_VERSION?: string;
  };
  /** When true, any drift between the bundle and the live cluster
   *  is a hard error (importer throws before any INSERT). When false
   *  (default), drift is logged + returned in the result; operator
   *  decides whether to act on it after the fact. */
  readonly strict?: boolean;
  /** Override the `age` binary path (tests use a stub). */
  readonly ageBinary?: string;
}

export interface RunDrRestoreResult {
  readonly bundleInfo: {
    readonly apexDomain: string;
    readonly clusterName: string;
    readonly platformVersion: string;
    readonly createdAt: string;
    readonly cnpgClusters: ReadonlyArray<{ namespace: string; clusterName: string; serverName: string; objectStoreName: string }>;
    readonly secretYamlCount: number;
  };
  readonly importResult: ImportResult;
}

export async function runDrRestore(opts: RunDrRestoreOpts): Promise<RunDrRestoreResult> {
  if (opts.mode !== 'partial') {
    // Defense-in-depth: TS narrows DrRestoreMode to 'partial' today,
    // but a future Unit C addition could widen the union without
    // updating this function. Refuse explicitly.
    throw new Error(`unsupported mode: ${opts.mode}; this build supports only 'partial' (Unit C adds 'full')`);
  }

  // ── 1. Read + decrypt + parse the bundle ───────────────────────────
  const bundle = await readBundle({
    bundlePath: opts.bundlePath,
    ageKeyPath: opts.ageKeyPath,
    ageBinary: opts.ageBinary,
  });

  // ── 2. Probe the live cluster state for drift detection ────────────
  const cluster = await probeClusterState(opts.db, opts.config);

  // ── 3. Import the two tables (transactional, idempotent on re-run) ─
  const importResult = await importDrRows({
    db: opts.db,
    drInputs: bundle.drInputs,
    drRows: bundle.drRows,
    cluster,
    strict: opts.strict,
  });

  return {
    bundleInfo: {
      apexDomain: bundle.drInputs.apexDomain,
      clusterName: bundle.drInputs.clusterName,
      platformVersion: bundle.drInputs.platformVersion,
      createdAt: bundle.drInputs.createdAt,
      cnpgClusters: bundle.drInputs.cnpgClusters,
      secretYamlCount: bundle.secretYamls.length,
    },
    importResult,
  };
}
