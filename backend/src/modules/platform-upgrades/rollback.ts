/**
 * Upgrade rollback (ADR-045 W16). Two halves:
 *   1. REVISION rollback (safe, proven reversible by the PR-18 spike): re-pin the
 *      Flux GitRepository back to the ref recorded before the upgrade.
 *   2. DATA restore (destructive, opt-in): revert the Longhorn rescue snapshots
 *      taken before the upgrade — only when the operator explicitly asks.
 *
 * Pure orchestration over a RollbackDeps seam (DB + k8s + Longhorn injected) so
 * the decision flow is unit-testable. A rescue snapshot is MANDATORY before an
 * apply (locked decision #15) — captureUpgradeRescue refuses if it snapshots 0
 * volumes, so an upgrade never proceeds without a safety net.
 */
import { eq, desc } from 'drizzle-orm';
import { platformUpgradeSnapshots } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  readGitRepositoryRef,
  repinGitRepositoryRef,
  resolveUpgradeGitRepository,
  type GitRepoRef,
  type RepinResult,
} from './flux-repin.js';

export interface RescueSnapshot {
  readonly volumeName: string;
  readonly namespace: string;
  readonly pvcName: string;
  readonly snapshotName: string;
}

export interface RollbackManifest {
  readonly id: string;
  readonly fromVersion: string | null;
  readonly toVersion: string;
  readonly gitRepository: string;
  readonly previousRef: GitRepoRef;
  readonly rescueSnapshots: readonly RescueSnapshot[];
  readonly status: string;
  readonly createdAt: string;
}

export interface RollbackDeps {
  resolveGitRepository: () => Promise<string | null>;
  readRef: (name: string) => Promise<GitRepoRef | null>;
  captureRescue: (label: string) => Promise<{ snapshots: RescueSnapshot[]; failures: number }>;
  recordManifest: (m: {
    fromVersion: string | null;
    toVersion: string;
    gitRepository: string;
    previousRef: GitRepoRef;
    rescueSnapshots: RescueSnapshot[];
  }) => Promise<RollbackManifest>;
  getLatestManifest: () => Promise<RollbackManifest | null>;
  markRolledBack: (id: string) => Promise<void>;
  repinRef: (name: string, ref: GitRepoRef) => Promise<RepinResult>;
  /** DESTRUCTIVE: revert a Longhorn volume to its rescue snapshot. */
  revertVolume: (snapshot: RescueSnapshot) => Promise<void>;
}

export interface CaptureResult {
  readonly ok: boolean;
  readonly manifest?: RollbackManifest;
  readonly reason?: string;
  /** Per-volume snapshot failures (the safety net is incomplete when > 0). */
  readonly failures?: number;
}

/**
 * Capture the rollback safety net BEFORE an apply re-pin: record the current
 * (soon-to-be-previous) Flux ref + take Longhorn rescue snapshots. Refuses if it
 * can't resolve a source, the current ref is empty, or it snapshots 0 volumes.
 */
export async function captureUpgradeRescue(
  deps: RollbackDeps,
  input: { fromVersion: string | null; toVersion: string; gitRepository?: string },
): Promise<CaptureResult> {
  // Reuse the already-resolved source when the caller has one (avoids a second
  // resolve + the race window between them); otherwise resolve here.
  const gitRepository = input.gitRepository ?? (await deps.resolveGitRepository());
  if (!gitRepository) return { ok: false, reason: 'no Flux GitRepository to roll back to' };

  const previousRef = await deps.readRef(gitRepository);
  if (!previousRef || (!previousRef.tag && !previousRef.branch && !previousRef.commit)) {
    return { ok: false, reason: 'current Flux ref is empty — cannot record a rollback target' };
  }

  const rescue = await deps.captureRescue(`pre-upgrade-${input.toVersion}`);
  if (rescue.snapshots.length === 0) {
    return { ok: false, reason: 'rescue snapshot captured 0 volumes — refusing to upgrade without a safety net' };
  }
  // Surface a partial capture (some volumes failed) — the safety net is incomplete.
  const partialNote = rescue.failures > 0 ? ` (WARNING: ${rescue.failures} volume snapshot(s) failed — partial safety net)` : '';

  const manifest = await deps.recordManifest({
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    gitRepository,
    previousRef,
    rescueSnapshots: rescue.snapshots,
  });
  return { ok: true, manifest, failures: rescue.failures, reason: partialNote || undefined };
}

export interface RollbackResult {
  readonly ok: boolean;
  readonly manifest?: RollbackManifest;
  readonly repin?: RepinResult;
  readonly dataRestored: boolean;
  readonly reason?: string;
  readonly summary: string;
}

/**
 * Roll back the most recent applied upgrade. Dry-run by default. With apply:
 * re-pins the Flux source back (revision rollback); with restoreData ALSO
 * reverts the Longhorn rescue snapshots (destructive — undoes data changes).
 */
export async function runRollback(
  deps: RollbackDeps,
  opts: { apply: boolean; restoreData: boolean },
): Promise<RollbackResult> {
  const manifest = await deps.getLatestManifest();
  if (!manifest) return { ok: false, dataRestored: false, reason: 'no rollback manifest', summary: 'nothing to roll back' };
  if (manifest.status === 'rolled-back') {
    return { ok: false, manifest, dataRestored: false, reason: 'already rolled back', summary: `the latest upgrade (${manifest.toVersion}) was already rolled back` };
  }

  const refStr = JSON.stringify(manifest.previousRef);
  if (!opts.apply) {
    return {
      ok: true,
      manifest,
      dataRestored: false,
      summary: `DRY-RUN: would re-pin ${manifest.gitRepository} → ${refStr}${opts.restoreData ? ` + revert ${manifest.rescueSnapshots.length} volume(s) (DESTRUCTIVE)` : ' (revision only)'}`,
    };
  }

  const repin = await deps.repinRef(manifest.gitRepository, manifest.previousRef);
  if (!repin.ok) {
    return { ok: false, manifest, repin, dataRestored: false, reason: repin.reason, summary: `rollback re-pin failed: ${repin.reason}` };
  }

  // Mark rolled-back BEFORE the destructive revert so a concurrent/re-run is
  // blocked by the status guard (the revert is the irreversible step).
  await deps.markRolledBack(manifest.id);

  let dataRestored = false;
  if (opts.restoreData && manifest.rescueSnapshots.length > 0) {
    for (const s of manifest.rescueSnapshots) {
      // Skip a malformed manifest entry rather than pass undefined fields to the
      // destructive revert (defends against a hand-edited DB row).
      if (!s.volumeName || !s.namespace || !s.pvcName || !s.snapshotName) continue;
      await deps.revertVolume(s);
    }
    dataRestored = true;
  }
  return {
    ok: true,
    manifest,
    repin,
    dataRestored,
    summary: `rolled back ${manifest.gitRepository} → ${refStr}${dataRestored ? ` + reverted ${manifest.rescueSnapshots.length} volume(s)` : ' (revision only — data NOT restored)'}`,
  };
}

// ── Real wiring ──────────────────────────────────────────────────────────────

export function realRollbackDeps(db: Database, k8s: K8sClients): RollbackDeps {
  return {
    resolveGitRepository: () => resolveUpgradeGitRepository(k8s),
    readRef: (name) => readGitRepositoryRef(k8s, name),
    repinRef: (name, ref) => repinGitRepositoryRef(k8s, name, ref),

    async captureRescue(label) {
      const snap = await import('../system-snapshots/service.js');
      await k8s.core.listNode(); // liveness — listSystemPvcSnapshots swallows errors
      const summaries = await snap.listSystemPvcSnapshots(k8s);
      const snapshots: RescueSnapshot[] = [];
      let failures = 0;
      const seen = new Set<string>();
      for (const s of summaries) {
        if (!s.longhornVolumeName || seen.has(s.longhornVolumeName)) continue;
        seen.add(s.longhornVolumeName);
        try {
          const { snapshotName } = await snap.takeSnapshot(k8s, s.longhornVolumeName, label);
          snapshots.push({ volumeName: s.longhornVolumeName, namespace: s.namespace, pvcName: s.pvcName, snapshotName });
        } catch {
          failures++;
        }
      }
      return { snapshots, failures };
    },

    async revertVolume(s) {
      const snap = await import('../system-snapshots/service.js');
      await snap.revertSnapshot(k8s, s.namespace, s.pvcName, s.volumeName, s.snapshotName);
    },

    async recordManifest(m) {
      const rows = await db
        .insert(platformUpgradeSnapshots)
        .values({
          fromVersion: m.fromVersion ?? null,
          toVersion: m.toVersion,
          gitRepository: m.gitRepository,
          previousRef: m.previousRef as Record<string, string>,
          rescueSnapshots: m.rescueSnapshots as unknown as Array<Record<string, string>>,
        })
        .returning();
      return toManifest(rows[0]);
    },

    async getLatestManifest() {
      const rows = await db.select().from(platformUpgradeSnapshots).orderBy(desc(platformUpgradeSnapshots.createdAt)).limit(1);
      return rows[0] ? toManifest(rows[0]) : null;
    },

    async markRolledBack(id) {
      await db.update(platformUpgradeSnapshots).set({ status: 'rolled-back' }).where(eq(platformUpgradeSnapshots.id, id));
    },
  };
}

function toManifest(row: typeof platformUpgradeSnapshots.$inferSelect): RollbackManifest {
  return {
    id: row.id,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    gitRepository: row.gitRepository,
    previousRef: row.previousRef as GitRepoRef,
    rescueSnapshots: (row.rescueSnapshots as unknown as RescueSnapshot[]) ?? [],
    status: row.status,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}
