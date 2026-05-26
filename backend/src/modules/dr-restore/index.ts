/**
 * DR restore primitive (Units B + C).
 *
 * Top-level entry consumed by:
 *   - `backend/src/cli/dr-restore-runner.ts` (the tsx CLI shim
 *     `scripts/dr-restore-bundle.sh` invokes)
 *   - `platform-ops dr restore` (PR 10 of the holistic upgrade plan
 *     wraps this once the binary lands)
 *
 * Modes:
 *   - mode='partial' (Unit B): import backup_configurations +
 *     backup_target_assignments only; every row inserted readOnly=true.
 *     Operator restores tenants individually via admin UI.
 *   - mode='full' (Unit C): everything in partial + CNPG recovery
 *     (side-by-side bootstrap.recovery + promote) + mail data restore
 *     (PVC wipe + restic restore via existing failover primitive).
 *
 * Locked design (see ADR notes in db-import.ts):
 *   - Sidecars must be present in the bundle (A2 or later). Older
 *     bundles surface as LegacyBundleError; the caller decides
 *     whether to fall through to a Secrets-only restore.
 *   - Per-cluster type-to-confirm is required for `mode='full'`
 *     (each CNPG cluster being promoted needs `--confirm-cluster=<name>`).
 *
 * Not in this module:
 *   - Bootstrap.sh invocation (caller's responsibility — cluster must
 *     already be live before runDrRestore is called)
 *   - Secrets application (`make secrets-restore` is the canonical
 *     path; we leave Secret-bundle YAMLs untouched on the restore side)
 *   - Tenant content restore (operator drives this via admin UI per
 *     the locked PARTIAL design — applies in both modes)
 */

import { readBundle } from './bundle-reader.js';
import { importDrRows, probeClusterState, type ImportResult } from './db-import.js';
import { runCnpgRecovery, type CnpgRecoveryResult } from './cnpg-recovery.js';
import { restoreMailData, type MailRestoreResult } from './mail-restore.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

// Re-exports for callers (CLI runner, future platform-ops binary) so
// they can catch typed errors without reaching into submodules.
export { BundleDecryptError, LegacyBundleError } from './bundle-reader.js';
export { DrImportError } from './db-import.js';
export type { ImportResult, DriftReport } from './db-import.js';
export { BundleVersionError } from '../system-backup/dr-sidecars.js';
export { CnpgRecoveryError } from './cnpg-recovery.js';
export type { CnpgRecoveryResult, ClusterRecoveryResult } from './cnpg-recovery.js';
export { MailRestoreError } from './mail-restore.js';
export type { MailRestoreResult } from './mail-restore.js';

export type DrRestoreMode = 'partial' | 'full';

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
  /** REQUIRED for mode='full'. Operator's typed confirmation per
   *  CNPG cluster being recovered — key is cluster name, value must
   *  equal the cluster name verbatim. Refused with a clear error
   *  if missing for any cluster in `cnpgClusters`. */
  readonly confirmClusterNames?: ReadonlyMap<string, string>;
  /** REQUIRED for mode='full'. Target node for the mail-stack to
   *  land on after the restore. Operator picks via CLI flag. */
  readonly targetMailNode?: string;
  /** REQUIRED for mode='full'. K8s API clients for CNPG + mail
   *  operations. Mode='partial' doesn't need these — DB-only. */
  readonly k8s?: K8sClients;
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
  /** Present when mode='full' completed successfully. */
  readonly cnpgRecoveryResult?: CnpgRecoveryResult;
  /** Present when mode='full' completed successfully. */
  readonly mailRestoreResult?: MailRestoreResult;
}

export async function runDrRestore(opts: RunDrRestoreOpts): Promise<RunDrRestoreResult> {
  if (opts.mode !== 'partial' && opts.mode !== 'full') {
    // Defense-in-depth: TS narrows DrRestoreMode to 'partial'|'full',
    // but a future Unit D addition could widen the union without
    // updating this function. Refuse explicitly.
    throw new Error(`unsupported mode: ${opts.mode}; supported: 'partial' | 'full'`);
  }

  // Pre-validate FULL-mode required inputs BEFORE doing any DB work,
  // so the operator gets a fast error on a misconfigured CLI instead
  // of half-importing rows and then failing on the recovery step.
  if (opts.mode === 'full') {
    if (!opts.k8s) {
      throw new Error("mode='full' requires K8sClients; got undefined");
    }
    if (!opts.targetMailNode || opts.targetMailNode.length === 0) {
      throw new Error("mode='full' requires --target-mail-node=<name>");
    }
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

  // PARTIAL ends here. The remaining phases run only on full-mode
  // — operator drives tenants via the admin UI in both modes.
  if (opts.mode === 'partial') {
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

  // ── 4. Full-mode: CNPG recovery (sequential per cluster) ──────────
  // After this, every CNPG cluster's data is replaced with the
  // restored barman-cloud archive. The source Cluster CR survives
  // (PITR Job recreates it); the side-by-side Cluster CR is deleted
  // post-promote.
  const cnpgRecoveryResult = await runCnpgRecovery({
    k8s: opts.k8s!,
    db: opts.db,
    pointers: bundle.drInputs.cnpgClusters,
    confirmClusterNames: opts.confirmClusterNames ?? new Map(),
  });

  // ── 5. Full-mode: mail data restore (PVC wipe + restic restore) ───
  // After cnpg-recovery completes, system-db contains the restored
  // data including any mail-related rows the OLD cluster had. We
  // now wipe the mail PVC and let the initContainers restic-restore
  // from the offsite repo (creds come from the `make secrets-restore`
  // step the operator ran before invoking this CLI).
  const mailRestoreResult = await restoreMailData({
    db: opts.db,
    core: opts.k8s!.core,
    apps: opts.k8s!.apps,
    batch: opts.k8s!.batch,
    targetMailNode: opts.targetMailNode!,
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
    cnpgRecoveryResult,
    mailRestoreResult,
  };
}
