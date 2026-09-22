/**
 * Tenant-bundle restic retention — the reclamation half of ADR-048.
 *
 * ADR-048 specified that the retention sweeper's `delete()` path calls
 * `restic forget ... --prune` for the incremental components and the legacy
 * delete path for `config`/`secrets`. Only the legacy half shipped: for months
 * `retention.ts` deleted `<prefix>/<bundleId>/` and flipped the row to
 * 'expired' while the restic repos — a SIBLING namespace at
 * `<prefix>/restic-<component>/<tenantId>/` — were never touched. No
 * `restic forget` and no `restic prune` existed anywhere in the backend, so
 * tenant file and mail content was never reclaimed and never actually deleted.
 *
 * ── Why reconciliation rather than per-bundle deletion ──────────────────────
 * The obvious fix is to forget the snapshot inside the per-bundle expiry loop.
 * That would fix future expiries and leave every already-orphaned snapshot
 * stranded forever — and there are two ways they were orphaned:
 *   - expiry marked the bundle 'expired' and never told restic;
 *   - DELETE /admin/tenant-bundles/:id hard-deletes the backup_jobs row,
 *     cascading backup_components and destroying the snapshot id while the
 *     snapshot itself survives.
 * A reconciler instead asks "which snapshots does the repo hold, and which
 * does the DB still vouch for?" and drops the difference. That covers historic
 * orphans and future expiries with one mechanism, and it is idempotent — a
 * crashed sweep is simply re-run.
 *
 * ── Safety ─────────────────────────────────────────────────────────────────
 * This code deletes backups. Every guard below exists because the failure mode
 * is unrecoverable:
 *
 *   G1 min-age    A snapshot younger than `forgetMinAgeHours` (default 48h) is
 *                 never forgotten, whatever the DB says. Covers an in-flight
 *                 capture whose backup_components row has not committed, clock
 *                 skew against the backup target, and a platform DB restored
 *                 to a point before recent snapshots were recorded.
 *
 *   G2 no-history A repo whose tenant has NO backup_jobs rows at all for that
 *                 component is ambiguous: either the tenant legitimately aged
 *                 out, or we lost the rows (DB restore, migration accident).
 *                 We refuse to guess and skip the repo — the difference that
 *                 makes it safe is that a legitimately aged-out tenant still
 *                 has its EXPIRED bundle rows on file, so it does get cleaned.
 *                 Without this, restoring the platform DB from an old backup
 *                 would empty every keep-set and delete every tenant's
 *                 backups on the next tick.
 *
 *   G3 frozen     Read-only (DR-frozen) targets are never written to, matching
 *                 the existing expiry sweep.
 *
 *   G4 kill sw.   `forget_enabled` setting, plus env
 *                 TENANT_BUNDLES_RESTIC_FORGET=disable for an outage.
 *
 *   G5 two-signal A snapshot is kept if EITHER its id matches a live bundle's
 *                 backup_components.sha256 OR its `bundle-id=` tag names a
 *                 live bundle. Deletion requires both signals to agree it is
 *                 dead; either one alone can save it.
 *
 * ── forget vs prune ────────────────────────────────────────────────────────
 * `forget` only rewrites the snapshot list and frees nothing; `prune` repacks
 * blobs and is expensive. They are deliberately NOT run as `forget --prune`:
 * forget runs per repo on every sweep, sets `prune_pending`, and a separate
 * rate-limited pass (default once per repo per 24h, bounded per tick) does the
 * reclaiming. `prune_pending` is durable so a pod kill between the two is
 * recovered on the next tick.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/index.js';
import {
  backupComponents,
  backupConfigurations,
  resticRepoReclaimState,
  tenantBackupV2Settings,
} from '../../db/schema.js';
import {
  buildResticRepoUri,
  deriveResticPassword,
  listResticSnapshots,
  runResticForget,
  runResticPrune,
  runResticStats,
  type BackupTarget,
  type ResticComponent,
} from './restic-driver.js';
import { anchorResticRepoTotal } from './repo-state.js';
import { notifyResticFailure } from './restic-failure-notify.js';
import { resolveShimBackupTarget } from './resolve-backup-target.js';
import { repoLayoutForStateRow } from './repo-layout.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export type RepoSkipReason =
  | 'forget-disabled'
  | 'frozen-target'
  | 'no-db-history'
  | 'unknown-component'
  | 'repo-missing'
  | 'nothing-to-forget';

export interface ResticRepoResult {
  readonly tenantId: string;
  readonly component: string;
  readonly repoUri: string;
  readonly snapshotsInRepo: number;
  readonly keptCount: number;
  readonly forgottenCount: number;
  /** Full ids, so a dry run tells the operator exactly what would go. */
  readonly forgottenIds: ReadonlyArray<string>;
  readonly prunedNow: boolean;
  readonly prunePending: boolean;
  readonly skipped: RepoSkipReason | null;
  readonly error: string | null;
}

export interface ResticRetentionResult {
  readonly dryRun: boolean;
  readonly reposScanned: number;
  readonly reposSkipped: number;
  readonly snapshotsForgotten: number;
  readonly prunesRun: number;
  /** Repos whose size was re-measured with `restic stats` this sweep. */
  readonly reposAnchored: number;
  /** backup_jobs rows deleted because nothing of them remains in storage. */
  readonly bundlesPurged: number;
  readonly errors: number;
  readonly repos: ReadonlyArray<ResticRepoResult>;
}

export interface ResticRetentionArgs {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly secretsKeyHex: string;
  readonly logger: FastifyBaseLogger;
  /** Injectable clock for tests. */
  readonly now?: () => Date;
  /** Compute and report, change nothing. */
  readonly dryRun?: boolean;
  /** Restrict to one tenant (manual admin trigger). */
  readonly tenantId?: string;
  /**
   * Override G2 (no-db-history). Operator-only, from the manual route, for
   * the case where they have confirmed the DB is authoritative and a repo
   * really is abandoned.
   */
  readonly force?: boolean;
  /** Bound the work in one tick. */
  readonly maxRepos?: number;
  readonly maxPrunes?: number;
  /** Bound the `restic stats` measurements in one tick (see the anchor pass). */
  readonly maxRepoAnchors?: number;
}

const DEFAULT_MAX_REPOS = 25;
const DEFAULT_MAX_PRUNES = 4;
/**
 * Repos re-measured per sweep beyond those just pruned. `restic stats --mode
 * raw-data` walks the repo index, so this is the one deliberately expensive
 * thing in the sweep — bounded, and whatever is left over is LOGGED rather
 * than silently dropped, then picked up by the next tick.
 */
const DEFAULT_MAX_REPO_ANCHORS = 10;
const RESTIC_COMPONENTS: ReadonlySet<string> = new Set<ResticComponent>(['files', 'mailboxes']);

/** `bundle-id=<uuid>` → `<uuid>`. Returns null when the tag is absent. */
function bundleIdFromTags(tags: ReadonlyArray<string>): string | null {
  for (const t of tags) {
    if (t.startsWith('bundle-id=')) return t.slice('bundle-id='.length);
  }
  return null;
}

/**
 * G5: a snapshot survives if either signal vouches for it. Restic may report
 * short ids in some code paths, so a keep id that is a prefix (>= 8 hex) of
 * the snapshot id also counts.
 */
function isKept(
  snap: { id: string; shortId: string; tags: ReadonlyArray<string> },
  keepSnapshotIds: ReadonlySet<string>,
  keepBundleIds: ReadonlySet<string>,
): boolean {
  if (keepSnapshotIds.has(snap.id)) return true;
  if (snap.shortId && keepSnapshotIds.has(snap.shortId)) return true;
  for (const k of keepSnapshotIds) {
    if (k.length >= 8 && (snap.id.startsWith(k) || k.startsWith(snap.id))) return true;
  }
  const bid = bundleIdFromTags(snap.tags);
  if (bid && keepBundleIds.has(bid)) return true;
  return false;
}

export interface RepoReclamationPlan {
  readonly keep: ReadonlyArray<string>;
  readonly forget: ReadonlyArray<string>;
  readonly skip: RepoSkipReason | null;
}

export interface PlanRepoReclamationArgs {
  readonly snapshots: ReadonlyArray<{ id: string; shortId: string; time: string; tags: ReadonlyArray<string> }>;
  readonly keepSnapshotIds: ReadonlySet<string>;
  readonly keepBundleIds: ReadonlySet<string>;
  /** Does the DB hold ANY bundle row for this (tenant, component)? */
  readonly hasHistory: boolean;
  /** Snapshots at or after this instant are never forgotten (G1). */
  readonly minAgeCutoff: Date;
  /** Operator override for G2. */
  readonly force?: boolean;
}

/**
 * The whole deletion decision, as a pure function — every guard that stands
 * between a live backup and `restic forget` is here, so each one is directly
 * testable without a repo, a cluster, or an ORM mock.
 */
export function planRepoReclamation(args: PlanRepoReclamationArgs): RepoReclamationPlan {
  // G2: a repo with snapshots but no DB history at all is ambiguous — either
  // the tenant aged out, or we lost the rows. Refuse to guess.
  if (!args.hasHistory && args.snapshots.length > 0 && !args.force) {
    return { keep: args.snapshots.map((s) => s.id), forget: [], skip: 'no-db-history' };
  }

  const keep: string[] = [];
  const forget: string[] = [];
  for (const s of args.snapshots) {
    // G5: either signal saves it.
    if (isKept(s, args.keepSnapshotIds, args.keepBundleIds)) { keep.push(s.id); continue; }
    // G1: an unparseable timestamp is treated as "too young to judge" — we
    // never delete on the strength of a value we could not read.
    const t = Date.parse(s.time);
    if (!Number.isFinite(t) || new Date(t) > args.minAgeCutoff) { keep.push(s.id); continue; }
    forget.push(s.id);
  }
  return { keep, forget, skip: forget.length === 0 ? 'nothing-to-forget' : null };
}

/**
 * One reclamation pass. Safe to call concurrently with backups: forget/prune
 * take the restic repo lock, and a lock conflict surfaces as a per-repo error
 * that the next tick retries.
 */
export async function runResticRetentionSweep(
  args: ResticRetentionArgs,
): Promise<ResticRetentionResult> {
  const { db, k8s, secretsKeyHex, logger } = args;
  const now = args.now ?? (() => new Date());
  const dryRun = args.dryRun ?? false;
  const repos: ResticRepoResult[] = [];

  const [settings] = await db.select().from(tenantBackupV2Settings).limit(1);
  const forgetEnabled = settings?.forgetEnabled ?? true;
  const minAgeHours = settings?.forgetMinAgeHours ?? 48;
  const pruneIntervalHours = settings?.pruneMinIntervalHours ?? 24;
  const maxRepackSize = settings?.pruneMaxRepackSize ?? null;

  const envDisabled = process.env.TENANT_BUNDLES_RESTIC_FORGET === 'disable';
  if (envDisabled || (!forgetEnabled && !args.force)) {
    logger.info(
      { envDisabled, forgetEnabled },
      'restic retention: disabled — no snapshots will be forgotten',
    );
    return {
      dryRun, reposScanned: 0, reposSkipped: 0, snapshotsForgotten: 0,
      prunesRun: 0, reposAnchored: 0, bundlesPurged: 0, errors: 0,
      repos: [{
        tenantId: args.tenantId ?? '*', component: '*', repoUri: '',
        snapshotsInRepo: 0, keptCount: 0, forgottenCount: 0, forgottenIds: [],
        prunedNow: false, prunePending: false, skipped: 'forget-disabled', error: null,
      }],
    };
  }

  // Which repos exist? NOT tenant_restic_repo_state — that table's tenantId
  // CASCADEs on tenant deletion, so it is empty for exactly the tenants whose
  // repos are most orphaned (staging: 135 recorded snapshots, 0 rows there).
  // The authoritative set is the (tenant, component) pairs that ever produced
  // a restic snapshot, which lives in backup_components joined to the
  // loose-referenced backup_jobs and therefore survives tenant deletion.
  // Union in the reclaim-state table so a repo stays in rotation even after
  // its last bundle row is hard-deleted.
  //
  // Least-recently-EXAMINED first. Ordering by last_forget_at instead would
  // starve every repo that is only ever skipped: those never got a row, so they
  // kept sorting into the NULLS-FIRST group and the tail was never reached
  // (staging: 131 pairs, 21 recorded, sweeps stalled). last_sweep_at is stamped
  // on every outcome, making this a true round robin.
  const stateRows = (await db.execute(sql`
    WITH pairs AS (
      -- ::text on both arms is required, not cosmetic: backup_components.component
      -- is the backup_component_name ENUM while restic_repo_reclaim_state.component
      -- is varchar, and Postgres refuses to UNION those types.
      SELECT DISTINCT bj.tenant_id, bc.component::text AS component
      FROM backup_components bc
      JOIN backup_jobs bj ON bj.id = bc.backup_job_id
      WHERE bc.component IN ('files','mailboxes')
        AND bc.sha256 IS NOT NULL
      UNION
      SELECT tenant_id, component::text AS component FROM restic_repo_reclaim_state
    )
    SELECT p.tenant_id AS "tenantId", p.component AS "component"
    FROM pairs p
    LEFT JOIN restic_repo_reclaim_state r
      ON r.tenant_id = p.tenant_id AND r.component = p.component
    WHERE ${args.tenantId ? sql`p.tenant_id = ${args.tenantId}` : sql`TRUE`}
    ORDER BY r.last_sweep_at ASC NULLS FIRST
    LIMIT ${args.maxRepos ?? DEFAULT_MAX_REPOS}
  `) as unknown as { rows: Array<{ tenantId: string; component: string }> }).rows;

  if (stateRows.length === 0) {
    return { dryRun, reposScanned: 0, reposSkipped: 0, snapshotsForgotten: 0, prunesRun: 0, reposAnchored: 0, bundlesPurged: 0, errors: 0, repos: [] };
  }

  // G3: frozen (read-only / DR) targets, fetched once for the batch.
  const frozen = new Set<string>();
  {
    const rows = await db
      .select({ id: backupConfigurations.id })
      .from(backupConfigurations)
      .where(eq(backupConfigurations.readOnly, true));
    for (const r of rows) frozen.add(r.id);
  }

  let target: BackupTarget;
  try {
    target = await resolveShimBackupTarget(k8s.core, 'tenant', logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'restic retention: cannot resolve shim backup target — sweep aborted');
    return {
      dryRun, reposScanned: 0, reposSkipped: 0, snapshotsForgotten: 0, prunesRun: 0, reposAnchored: 0, bundlesPurged: 0, errors: 1,
      repos: [{
        tenantId: args.tenantId ?? '*', component: '*', repoUri: '', snapshotsInRepo: 0,
        keptCount: 0, forgottenCount: 0, forgottenIds: [], prunedNow: false,
        prunePending: false, skipped: null, error: msg.slice(0, 300),
      }],
    };
  }

  const minAgeCutoff = new Date(now().getTime() - minAgeHours * 60 * 60 * 1000);
  let snapshotsForgotten = 0;
  let reposSkipped = 0;
  let errors = 0;

  for (const row of stateRows) {
    const { tenantId, component } = row;
    const base = { tenantId, component, snapshotsInRepo: 0, keptCount: 0, forgottenCount: 0, forgottenIds: [] as string[], prunedNow: false, prunePending: false };
    // Stamp the examination on every outcome so the round-robin advances. A
    // dry run deliberately writes nothing, so it must not be used to audit
    // coverage.
    const note = async (outcome: string): Promise<void> => {
      if (dryRun) return;
      await recordSweepExamination({ db, tenantId, component, outcome, at: now(), logger });
    };

    if (!RESTIC_COMPONENTS.has(component)) {
      await note('unknown-component');
      repos.push({ ...base, repoUri: '', skipped: 'unknown-component', error: null });
      reposSkipped++;
      continue;
    }
    // G3: if every bundle this repo still has on file points at a frozen
    // (DR read-only) target, do not write to it.
    if (frozen.size > 0) {
      const tgt = await db.execute(sql`
        SELECT DISTINCT target_config_id FROM backup_jobs
        WHERE tenant_id = ${tenantId} AND target_config_id IS NOT NULL
      `) as unknown as { rows: Array<{ target_config_id: string }> };
      if (tgt.rows.length > 0 && tgt.rows.every((r) => frozen.has(r.target_config_id))) {
        await note('frozen-target');
        repos.push({ ...base, repoUri: '', skipped: 'frozen-target', error: null });
        reposSkipped++;
        continue;
      }
    }

    // Which repository this row's snapshots are actually in. A tenant
    // mid-migration has rows pointing at both layouts (ADR-061).
    const layout = await repoLayoutForStateRow(db, tenantId, component);
    const repoUri = buildResticRepoUri(target, tenantId, component as ResticComponent, layout);
    try {
      // Keep-set: snapshots belonging to bundles that are still live. A bundle
      // is live when it completed (fully or partially) AND has not passed its
      // expires_at. Note this keys off expires_at directly rather than
      // status='expired', so the reconciler agrees with the expiry sweep even
      // when it has not run yet.
      //
      // The component filter is dropped for a MERGED repository, because that
      // repository holds every component's snapshots. Filtering it to one
      // component there would make every OTHER component's snapshot look
      // unreferenced — and an unreferenced snapshot is one this sweep forgets.
      // That is the single most destructive thing this file can get wrong, so
      // it is expressed as a widening of the keep-set, never a narrowing.
      const keepRows = await db.execute(sql`
        SELECT bc.sha256 AS snapshot_id, bj.id AS bundle_id
        FROM backup_components bc
        JOIN backup_jobs bj ON bj.id = bc.backup_job_id
        WHERE bj.tenant_id = ${tenantId}
          ${layout === 'per-tenant' ? sql`` : sql`AND bc.component::text = ${component}`}
          AND bj.status IN ('completed','partial')
          AND (bj.expires_at IS NULL OR bj.expires_at > ${now()})
      `) as unknown as { rows: Array<{ snapshot_id: string | null; bundle_id: string }> };

      const keepSnapshotIds = new Set<string>();
      const keepBundleIds = new Set<string>();
      for (const r of keepRows.rows) {
        if (r.snapshot_id) keepSnapshotIds.add(r.snapshot_id);
        keepBundleIds.add(r.bundle_id);
      }

      // G2: does the DB remember ANY bundle for this (tenant, component)?
      // Expired rows count — they are proof the DB still has its history.
      const histRows = await db.execute(sql`
        SELECT 1
        FROM backup_components bc
        JOIN backup_jobs bj ON bj.id = bc.backup_job_id
        WHERE bj.tenant_id = ${tenantId} AND bc.component::text = ${component}
        LIMIT 1
      `) as unknown as { rows: Array<unknown> };
      const hasHistory = histRows.rows.length > 0;

      let snapshots;
      try {
        snapshots = await listResticSnapshots({
          target, passwordHex: deriveResticPassword(secretsKeyHex, tenantId),
          readOnly: true, repoUri,
        });
      } catch (err) {
        // restic exits 10 with "repository does not exist" when the repo was
        // never created here, or when the bundle predates a change of backup
        // target so the shim no longer fronts the upstream holding it. That is
        // an expected steady state on older installs, not a fault: reporting it
        // as an error every 6 hours would train operators to ignore the count.
        const msg = err instanceof Error ? err.message : String(err);
        if (/repository does not exist|unable to open config file/i.test(msg)) {
          // Deliberately NOT stamped as reclaimed. An unreachable repo is not a
          // reclaimed one — the data may be intact on a target this cluster no
          // longer fronts, and purging those bundle rows would destroy the only
          // record of it. Reclaim it by pointing the shim at that target, or
          // with an explicit forced per-tenant run.
          await note('repo-missing');
          repos.push({ ...base, repoUri, skipped: 'repo-missing', error: null });
          reposSkipped++;
          continue;
        }
        throw err;
      }
      base.snapshotsInRepo = snapshots.length;

      const plan = planRepoReclamation({
        snapshots, keepSnapshotIds, keepBundleIds, hasHistory,
        minAgeCutoff, ...(args.force !== undefined ? { force: args.force } : {}),
      });
      const kept = plan.keep;
      const candidates = plan.forget;
      base.keptCount = kept.length;

      if (plan.skip === 'no-db-history') {
        logger.warn(
          { tenantId, component, snapshots: snapshots.length },
          'restic retention: repo has snapshots but the DB has no bundle history for it — skipping (possible DB loss). Use the manual route with force=true if the repo is genuinely abandoned.',
        );
        await note('no-db-history');
        repos.push({ ...base, repoUri, skipped: 'no-db-history', error: null });
        reposSkipped++;
        continue;
      }
      if (candidates.length === 0) {
        // Still reconcile the stamps: a snapshot may have disappeared by some
        // other route (interrupted sweep, manual forget), and its component
        // must not pin the bundle row forever.
        if (!dryRun) {
          try {
            await stampReclaimedComponents({
              db, tenantId, component, stillPresent: new Set(kept), at: now(),
            });
          } catch (err) {
            logger.warn({ err, tenantId, component }, 'restic retention: stamp reconcile failed (retried next sweep)');
          }
        }
        await note('nothing-to-forget');
        repos.push({ ...base, repoUri, skipped: 'nothing-to-forget', error: null });
        continue;
      }

      if (dryRun) {
        repos.push({
          ...base, repoUri, forgottenCount: candidates.length, forgottenIds: [...candidates],
          prunePending: true, skipped: null, error: null,
        });
        snapshotsForgotten += candidates.length;
        continue;
      }

      await runResticForget({
        target, passwordHex: deriveResticPassword(secretsKeyHex, tenantId),
        repoUri, snapshotIds: candidates, log: logger,
      });
      // Upsert, not update: most repos have no reclaim row yet on first sweep.
      await db.execute(sql`
        INSERT INTO restic_repo_reclaim_state
          (tenant_id, component, last_forget_at, forgotten_snapshots_total, prune_pending)
        VALUES (${tenantId}, ${component}, ${now()}, ${candidates.length}, TRUE)
        ON CONFLICT (tenant_id, component) DO UPDATE SET
          last_forget_at = EXCLUDED.last_forget_at,
          forgotten_snapshots_total =
            restic_repo_reclaim_state.forgotten_snapshots_total + EXCLUDED.forgotten_snapshots_total,
          prune_pending = TRUE,
          updated_at = now()
      `);

      // The forget is the irreversible part and it has now happened — count it
      // before any bookkeeping, so a bookkeeping failure cannot report
      // "forgotten=0" for snapshots that are actually gone.
      snapshotsForgotten += candidates.length;
      logger.info(
        { tenantId, component, forgotten: candidates.length, kept: kept.length },
        'restic retention: forgot expired snapshots',
      );

      // Stamp components whose snapshots are no longer in the repo. Derived
      // from OBSERVED repo contents rather than from what this run forgot, so
      // it is self-healing: a snapshot that vanished in an earlier interrupted
      // sweep, or by any other route, still gets stamped on the next pass.
      // Bookkeeping failures are logged, never fatal — the reclamation stands.
      try {
        const stillPresent = new Set(kept);
        await stampReclaimedComponents({
          db, tenantId, component, stillPresent, at: now(),
        });
      } catch (err) {
        logger.warn({ err, tenantId, component }, 'restic retention: could not stamp reclaimed components (retried next sweep)');
      }
      await note('forgot');
      repos.push({
        ...base, repoUri, forgottenCount: candidates.length, forgottenIds: [...candidates],
        prunePending: true, skipped: null, error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, tenantId, component }, 'restic retention: repo sweep failed');
      await note('error');
      // This sweep runs INSIDE platform-api, so no Job exists for the
      // backup-health watcher to find. Without this the failure lives and dies
      // in the log line above.
      await notifyResticFailure(db, {
        operation: 'forget',
        scope: `tenant ${tenantId} / ${component}`,
        dedupeScope: `${tenantId}:${component}`,
      }, err, logger);
      repos.push({ ...base, repoUri, skipped: null, error: msg.slice(0, 300) });
      errors++;
    }
  }

  // ── Prune pass ────────────────────────────────────────────────────────────
  let prunesRun = 0;
  const justPruned: Array<{ tenantId: string; component: string }> = [];
  if (!dryRun) {
    const pruneCutoff = new Date(now().getTime() - pruneIntervalHours * 60 * 60 * 1000);
    const due = await db.execute(sql`
      SELECT tenant_id, component
      FROM restic_repo_reclaim_state
      WHERE prune_pending = TRUE
        AND (last_prune_at IS NULL OR last_prune_at < ${pruneCutoff})
        ${args.tenantId ? sql`AND tenant_id = ${args.tenantId}` : sql``}
      ORDER BY last_prune_at ASC NULLS FIRST
      LIMIT ${args.maxPrunes ?? DEFAULT_MAX_PRUNES}
    `) as unknown as { rows: Array<{ tenant_id: string; component: string }> };

    // A merged repository is reached by both of a tenant's component rows;
    // pruning it twice in one pass is wasted work on an exclusive lock.
    const prunedRepos = new Set<string>();
    for (const { tenant_id: tenantId, component } of due.rows) {
      if (!RESTIC_COMPONENTS.has(component)) continue;
      const repoUri = buildResticRepoUri(
        target, tenantId, component as ResticComponent,
        await repoLayoutForStateRow(db, tenantId, component),
      );
      if (prunedRepos.has(repoUri)) continue;
      prunedRepos.add(repoUri);
      const startedAt = Date.now();
      try {
        await runResticPrune({
          target, passwordHex: deriveResticPassword(secretsKeyHex, tenantId), repoUri,
          ...(maxRepackSize ? { maxRepackSize } : {}), log: logger,
        });
        await db.update(resticRepoReclaimState)
          .set({
            prunePending: false,
            lastPruneAt: now(),
            lastPruneError: null,
            lastPruneDurationMs: Date.now() - startedAt,
          })
          .where(and(
            eq(resticRepoReclaimState.tenantId, tenantId),
            eq(resticRepoReclaimState.component, component),
          ));
        prunesRun++;
        justPruned.push({ tenantId, component });
        logger.info({ tenantId, component, ms: Date.now() - startedAt }, 'restic retention: pruned repo');
        const existing = repos.find((r) => r.tenantId === tenantId && r.component === component);
        if (existing) {
          repos[repos.indexOf(existing)] = { ...existing, prunedNow: true, prunePending: false };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // prune_pending stays TRUE so the next tick retries.
        await db.update(resticRepoReclaimState)
          .set({ lastPruneError: msg.slice(0, 500), lastPruneDurationMs: Date.now() - startedAt })
          .where(and(
            eq(resticRepoReclaimState.tenantId, tenantId),
            eq(resticRepoReclaimState.component, component),
          ));
        errors++;
        logger.error({ err: msg, tenantId, component }, 'restic retention: prune failed — will retry next tick');
        await notifyResticFailure(db, {
          operation: 'prune',
          scope: `tenant ${tenantId} / ${component}`,
          dedupeScope: `${tenantId}:${component}`,
        }, err, logger);
      }
    }
  }

  // ── Repo-size anchor pass ─────────────────────────────────────────────────
  //
  // `tenant_restic_repo_state.repo_total_bytes` is advanced on every snapshot
  // by that snapshot's `data_added_packed` (see repo-state.ts), which is free
  // — restic already prints it. That accumulator only ever GROWS, so it needs
  // a real measurement to anchor it in two situations:
  //
  //   1. A prune just ran. Prune is the only thing that SHRINKS a repo, so a
  //      tracked total is stale the moment one completes. We are already
  //      paying for a repack here; one `restic stats` beside it is noise.
  //   2. The row has never been measured. Accumulating from NULL would report
  //      "bytes added since we started counting" as the repo size, which for
  //      a tenant with 26 existing snapshots is wrong by orders of magnitude.
  //      repo-state.ts deliberately leaves those NULL, and this seeds them.
  //
  // Failures are logged and skipped: an unreachable repo must leave the last
  // good number alone rather than zero it.
  let reposAnchored = 0;
  if (!dryRun) {
    const anchored = new Set<string>();
    const queue: Array<{ tenantId: string; component: string }> = [];
    for (const pair of justPruned) {
      const key = `${pair.tenantId}:${pair.component}`;
      if (anchored.has(key)) continue;
      anchored.add(key);
      queue.push(pair);
    }

    const unseeded = await db.execute(sql`
      SELECT tenant_id, component
      FROM tenant_restic_repo_state
      WHERE repo_total_bytes IS NULL
        AND repo_uri <> ''
        ${args.tenantId ? sql`AND tenant_id = ${args.tenantId}` : sql``}
      ORDER BY last_snapshot_at DESC NULLS LAST
    `) as unknown as { rows: Array<{ tenant_id: string; component: string }> };

    const budget = args.maxRepoAnchors ?? DEFAULT_MAX_REPO_ANCHORS;
    let deferred = 0;
    for (const row of unseeded.rows) {
      const key = `${row.tenant_id}:${row.component}`;
      if (anchored.has(key)) continue;
      if (queue.length >= budget) { deferred += 1; continue; }
      anchored.add(key);
      queue.push({ tenantId: row.tenant_id, component: row.component });
    }
    if (deferred > 0) {
      // Never let a bound look like completion: say what was left behind.
      logger.info(
        { deferred, budget },
        'restic retention: repo-size seeding deferred to the next sweep (per-sweep budget reached)',
      );
    }

    // Measured once per REPOSITORY. Under the merged layout both component
    // rows name the same repository, and anchoring its full size against each
    // of them would double the tenant's reported storage — the rollup sums the
    // rows. The size lands on the first component seen; the others anchor 0,
    // so the per-tenant total stays exact.
    const measuredRepos = new Set<string>();
    for (const { tenantId, component } of queue) {
      if (!RESTIC_COMPONENTS.has(component)) continue;
      try {
        const repoUri = buildResticRepoUri(
          target, tenantId, component as ResticComponent,
          await repoLayoutForStateRow(db, tenantId, component),
        );
        if (measuredRepos.has(repoUri)) {
          await anchorResticRepoTotal({
            db, tenantId, component, totalBytes: 0, measuredAt: now(),
          });
          reposAnchored += 1;
          continue;
        }
        measuredRepos.add(repoUri);
        const stats = await runResticStats({
          target,
          passwordHex: deriveResticPassword(secretsKeyHex, tenantId),
          repoUri,
        });
        await anchorResticRepoTotal({
          db, tenantId, component, totalBytes: stats.totalSizeBytes, measuredAt: now(),
        });
        reposAnchored += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err: msg, tenantId, component },
          'restic retention: could not measure repo size (previous value kept, retried next sweep)',
        );
      }
    }
    if (reposAnchored > 0) {
      logger.info({ reposAnchored }, 'restic retention: repo sizes re-anchored');
    }
  }

  // ── Purge rows for bundles that no longer exist anywhere ──────────────────
  // Gated on status='expired', which retention.ts sets ONLY after the
  // per-bundle directory delete succeeded — so the config/secrets/db-dump
  // artefacts are already gone. Combined with "no restic component still
  // awaiting reclamation", the row now describes nothing at all.
  let bundlesPurged = 0;
  if (!dryRun) {
    try {
      const purgedIds = await purgeFullyReclaimedBundles(db, args.tenantId);
      bundlesPurged = purgedIds.length;
      if (bundlesPurged > 0) {
        logger.info(
          { count: bundlesPurged },
          'restic retention: purged bundle rows whose storage is fully reclaimed',
        );
      }
    } catch (err) {
      // Never fatal: reclamation already happened, and the rows are only
      // cosmetic at this point. Retried next tick.
      logger.warn({ err }, 'restic retention: bundle-row purge failed (non-fatal)');
      errors++;
    }
  }

  return {
    dryRun,
    bundlesPurged,
    reposScanned: stateRows.length,
    reposSkipped,
    snapshotsForgotten,
    prunesRun,
    reposAnchored,
    errors,
    repos,
  };
}

/**
 * Record that this repository was examined, whatever the outcome.
 *
 * Drives the round-robin ordering. Must be called on EVERY path the sweep can
 * take for a repo — including skips and errors — or that repo sorts first
 * forever and the tail starves once there are more repos than the per-tick cap.
 * Best-effort: bookkeeping must never fail a sweep.
 */
async function recordSweepExamination(args: {
  db: Database;
  tenantId: string;
  component: string;
  outcome: string;
  at: Date;
  logger: FastifyBaseLogger;
}): Promise<void> {
  try {
    await args.db.execute(sql`
      INSERT INTO restic_repo_reclaim_state (tenant_id, component, last_sweep_at, last_sweep_outcome)
      VALUES (${args.tenantId}, ${args.component}, ${args.at}, ${args.outcome})
      ON CONFLICT (tenant_id, component) DO UPDATE SET
        last_sweep_at = EXCLUDED.last_sweep_at,
        last_sweep_outcome = EXCLUDED.last_sweep_outcome,
        updated_at = now()
    `);
  } catch (err) {
    args.logger.warn({ err, tenantId: args.tenantId, component: args.component },
      'restic retention: could not record sweep examination');
  }
}

/**
 * Mark every component of this (tenant, component) repo whose snapshot is no
 * longer present in the repository.
 *
 * Driven by observed repo contents, not by the ids this run happened to
 * forget, which makes it converge no matter how a snapshot disappeared —
 * an interrupted sweep, a manual `restic forget`, a repo restored from
 * elsewhere. Uses the query builder so array binding is handled properly.
 */
async function stampReclaimedComponents(args: {
  db: Database;
  tenantId: string;
  component: string;
  /** Snapshot ids still in the repository. */
  stillPresent: ReadonlySet<string>;
  at: Date;
}): Promise<number> {
  const rows = await args.db.execute(sql`
    SELECT bc.id AS id, bc.sha256 AS sha256
    FROM backup_components bc
    JOIN backup_jobs bj ON bj.id = bc.backup_job_id
    WHERE bj.tenant_id = ${args.tenantId}
      AND bc.component::text = ${args.component}
      AND bc.sha256 IS NOT NULL
      AND bc.snapshot_reclaimed_at IS NULL
  `) as unknown as { rows: Array<{ id: string; sha256: string }> };

  const gone = rows.rows.filter((r) => !args.stillPresent.has(r.sha256)).map((r) => r.id);
  if (gone.length === 0) return 0;
  await args.db.update(backupComponents)
    .set({ snapshotReclaimedAt: args.at })
    .where(inArray(backupComponents.id, gone));
  return gone.length;
}

/**
 * Delete backup_jobs rows describing a bundle that no longer exists anywhere.
 *
 * Two conditions, both required:
 *   - `status = 'expired'`, which retention.ts sets ONLY after the per-bundle
 *     directory delete succeeded, so config/secrets/db-dump artefacts are gone;
 *   - no restic component of the bundle is still awaiting reclamation.
 *
 * The second is what makes a bundle spanning two repos (files + mailboxes)
 * safe: it survives until BOTH have been swept, so its surviving snapshot id
 * is never destroyed while the snapshot is still there.
 *
 * Returns the purged ids. Exported for direct testing — this statement deletes
 * user-visible history, so its gating is asserted rather than assumed.
 */
export async function purgeFullyReclaimedBundles(
  db: Pick<Database, 'execute'>,
  tenantId?: string,
  limit = 500,
): Promise<string[]> {
  // Select-then-delete rather than a correlated DELETE: the two-statement
  // form is bounded by an explicit LIMIT, returns exactly what it removed,
  // and keeps the gating condition readable. A row deleted concurrently
  // between the two statements simply is not deleted twice.
  const candidates = await db.execute(sql`
    SELECT bj.id AS id
    FROM backup_jobs bj
    WHERE bj.status = 'expired'
      ${tenantId ? sql`AND bj.tenant_id = ${tenantId}` : sql``}
      -- Uncorrelated on purpose: the equivalent correlated NOT EXISTS is
      -- fine in Postgres but unsupported by pg-mem, and this gating deserves
      -- unit coverage. NOT IN is NULL-safe here because backup_job_id is
      -- NOT NULL (FK column).
      AND bj.id NOT IN (
        SELECT bc.backup_job_id FROM backup_components bc
        WHERE bc.component IN ('files','mailboxes')
          AND bc.sha256 IS NOT NULL
          AND bc.snapshot_reclaimed_at IS NULL
      )
    LIMIT ${limit}
  `) as unknown as { rows: Array<{ id: string }> };

  const ids = candidates.rows.map((r) => r.id);
  if (ids.length === 0) return [];
  // backup_components cascades on this delete (FK ON DELETE CASCADE), which
  // is safe now: every restic snapshot id it held has been reclaimed.
  // Bind each id as its own parameter. `ANY(${ids}::text[])` looks tidier but
  // the driver binds a JS array as a single scalar, producing
  // `('bkp-...')::text[]` — a cast error at runtime that no pg-mem test sees.
  await db.execute(sql`DELETE FROM backup_jobs WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  return ids;
}

/**
 * Periodic reclamation. Deliberately NOT folded into the 5-minute expiry
 * sweep in retention.ts: listing snapshots and pruning are network-heavy
 * restic operations against the backup target, and they share the per-pod
 * restic semaphore (cap 2) with live backups. A 6-hour cadence reclaims
 * promptly enough for a 30-day retention window while staying out of the
 * way of the nightly backup run.
 *
 * The first tick is delayed rather than immediate (the expiry sweep fires at
 * once because it is a cheap DB + object-delete): on a rollout that restarts
 * every replica, an immediate tick would have all of them hit the backup
 * target simultaneously.
 */
export function startResticRetentionScheduler(
  app: {
    db: Database;
    log: FastifyBaseLogger;
    config?: Record<string, unknown>;
    addHook?: unknown;
  },
  opts: { intervalMs?: number; initialDelayMs?: number } = {},
): { stop: () => void } {
  const envInterval = Number.parseInt(process.env.TENANT_BUNDLES_RESTIC_RETENTION_INTERVAL_MS ?? '', 10);
  const intervalMs = opts.intervalMs
    ?? (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : 6 * 60 * 60 * 1000);
  const initialDelayMs = opts.initialDelayMs ?? 10 * 60 * 1000;

  let interval: NodeJS.Timeout | null = null;
  const tick = async () => {
    try {
      const secretsKeyHex = (app.config?.PLATFORM_ENCRYPTION_KEY as string | undefined)
        ?? process.env.PLATFORM_ENCRYPTION_KEY;
      if (!secretsKeyHex) {
        app.log.warn('restic retention: PLATFORM_ENCRYPTION_KEY not configured — skipping sweep');
        return;
      }
      const kubeconfigPath = (app.config?.KUBECONFIG_PATH as string | undefined)
        ?? process.env.KUBECONFIG_PATH;
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const res = await runResticRetentionSweep({
        db: app.db,
        k8s: createK8sClients(kubeconfigPath),
        secretsKeyHex,
        logger: app.log,
      });
      if (res.snapshotsForgotten > 0 || res.prunesRun > 0 || res.errors > 0) {
        app.log.info(
          {
            reposScanned: res.reposScanned,
            reposSkipped: res.reposSkipped,
            snapshotsForgotten: res.snapshotsForgotten,
            prunesRun: res.prunesRun,
            errors: res.errors,
          },
          'restic retention: sweep complete',
        );
      }
    } catch (err) {
      app.log.error({ err }, 'restic retention: sweep tick failed');
    }
  };

  const initial = setTimeout(() => {
    void tick();
    interval = setInterval(() => void tick(), intervalMs);
  }, initialDelayMs);

  return {
    stop: () => {
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    },
  };
}
