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

import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/index.js';
import {
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
  type BackupTarget,
  type ResticComponent,
} from './restic-driver.js';
import { resolveShimBackupTarget } from './resolve-backup-target.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export type RepoSkipReason =
  | 'forget-disabled'
  | 'frozen-target'
  | 'no-db-history'
  | 'unknown-component'
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
}

const DEFAULT_MAX_REPOS = 25;
const DEFAULT_MAX_PRUNES = 4;
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
      prunesRun: 0, bundlesPurged: 0, errors: 0,
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
  // Oldest-swept first (NULL = never swept) so every repo gets a turn under
  // the per-tick cap.
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
    ORDER BY r.last_forget_at ASC NULLS FIRST
    LIMIT ${args.maxRepos ?? DEFAULT_MAX_REPOS}
  `) as unknown as { rows: Array<{ tenantId: string; component: string }> }).rows;

  if (stateRows.length === 0) {
    return { dryRun, reposScanned: 0, reposSkipped: 0, snapshotsForgotten: 0, prunesRun: 0, bundlesPurged: 0, errors: 0, repos: [] };
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
      dryRun, reposScanned: 0, reposSkipped: 0, snapshotsForgotten: 0, prunesRun: 0, bundlesPurged: 0, errors: 1,
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

    if (!RESTIC_COMPONENTS.has(component)) {
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
        repos.push({ ...base, repoUri: '', skipped: 'frozen-target', error: null });
        reposSkipped++;
        continue;
      }
    }

    const repoUri = buildResticRepoUri(target, tenantId, component as ResticComponent);
    try {
      // Keep-set: snapshots belonging to bundles that are still live. A bundle
      // is live when it completed (fully or partially) AND has not passed its
      // expires_at. Note this keys off expires_at directly rather than
      // status='expired', so the reconciler agrees with the expiry sweep even
      // when it has not run yet.
      const keepRows = await db.execute(sql`
        SELECT bc.sha256 AS snapshot_id, bj.id AS bundle_id
        FROM backup_components bc
        JOIN backup_jobs bj ON bj.id = bc.backup_job_id
        WHERE bj.tenant_id = ${tenantId}
          AND bc.component::text = ${component}
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

      const snapshots = await listResticSnapshots({
        target, passwordHex: deriveResticPassword(secretsKeyHex, tenantId),
        readOnly: true, repoUri,
      });
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
        repos.push({ ...base, repoUri, skipped: 'no-db-history', error: null });
        reposSkipped++;
        continue;
      }
      if (candidates.length === 0) {
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
        repoUri, snapshotIds: candidates,
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

      // Stamp the components whose snapshots are now genuinely gone. This is
      // what later authorises purging the bundle row: the snapshot id in
      // backup_components.sha256 must outlive the bundle's expiry and only
      // becomes disposable once the blob it names has been forgotten.
      await db.execute(sql`
        UPDATE backup_components bc
        SET snapshot_reclaimed_at = ${now()}
        FROM backup_jobs bj
        WHERE bj.id = bc.backup_job_id
          AND bj.tenant_id = ${tenantId}
          AND bc.component::text = ${component}
          AND bc.sha256 = ANY(${candidates}::text[])
      `);

      snapshotsForgotten += candidates.length;
      logger.info(
        { tenantId, component, forgotten: candidates.length, kept: kept.length },
        'restic retention: forgot expired snapshots',
      );
      repos.push({
        ...base, repoUri, forgottenCount: candidates.length, forgottenIds: [...candidates],
        prunePending: true, skipped: null, error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, tenantId, component }, 'restic retention: repo sweep failed');
      repos.push({ ...base, repoUri, skipped: null, error: msg.slice(0, 300) });
      errors++;
    }
  }

  // ── Prune pass ────────────────────────────────────────────────────────────
  let prunesRun = 0;
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

    for (const { tenant_id: tenantId, component } of due.rows) {
      if (!RESTIC_COMPONENTS.has(component)) continue;
      const repoUri = buildResticRepoUri(target, tenantId, component as ResticComponent);
      const startedAt = Date.now();
      try {
        await runResticPrune({
          target, passwordHex: deriveResticPassword(secretsKeyHex, tenantId), repoUri,
          ...(maxRepackSize ? { maxRepackSize } : {}),
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
      }
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
    errors,
    repos,
  };
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
  await db.execute(sql`DELETE FROM backup_jobs WHERE id = ANY(${ids}::text[])`);
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
