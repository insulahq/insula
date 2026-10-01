/**
 * What an export download is about to do, answered BEFORE it starts.
 *
 * The export UI used to be a button that either produced a file or appeared to
 * hang. Two things made that unreadable to an operator:
 *
 *   1. The response could stall with no bytes and no error (Traefik spooled the
 *      whole body first — fixed by the GET carve-out in
 *      system-settings/ingress-reconciler.ts).
 *   2. A restic-backed component cannot start while the cluster-wide capture
 *      gate is full, so an export can legitimately wait minutes on a backup
 *      that has nothing to do with the bundle being exported — and nothing said
 *      so.
 *
 * This endpoint answers both: what the archive will contain and how big it is,
 * and whether anything is currently in the way. It is READ-ONLY and cheap — two
 * indexed queries and one settings read. It deliberately does NOT reserve a
 * slot: reserving here would mean the UI holds cluster capacity while the
 * operator reads a dialog.
 *
 * ★ It is advisory, not a gate. `blocked` never prevents the download — the
 * export still starts and waits its turn, exactly as before. Treating a
 * preflight as authoritative would be wrong twice over: the answer can go stale
 * between the check and the click, and a capture that finishes one second later
 * would have the UI refusing an export that would have worked.
 */
import { and, eq, gte, sql } from 'drizzle-orm';

import { backupComponents, backupJobs, tenantBackupV2Settings, tenantBundleInFlight } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

/**
 * Mirrors STALE_AFTER_MS in cluster-concurrency.ts. A row whose heartbeat
 * stopped more than this ago is an orphan from a crashed pod and does not hold
 * a slot — so it must not be reported as one either, or the dialog would warn
 * about a backup that is not running.
 */
export const IN_FLIGHT_STALE_AFTER_MS = 5 * 60 * 1000;

export interface ExportPreflightComponent {
  readonly component: string;
  readonly artifactName: string;
  readonly sizeBytes: number;
  /**
   * `restic` components are dumped from the repository and are what the
   * capture gate applies to; `object` components are read straight from the
   * bundle prefix and are never gated.
   */
  readonly source: 'restic' | 'object';
}

export interface ExportPreflight {
  readonly bundleId: string;
  readonly bundleStatus: string;
  readonly components: ReadonlyArray<ExportPreflightComponent>;
  readonly totalBytes: number;
  /** True when any component must be dumped from restic. */
  readonly needsRestic: boolean;
  readonly capture: {
    /** Non-stale rows in tenant_bundle_in_flight, cluster-wide. */
    readonly inFlight: number;
    /** `global_max_in_flight`; 0 means the cluster gate is disabled. */
    readonly cap: number;
    readonly slotsFree: number;
    /** True when a capture for THIS bundle is running — export would contend directly. */
    readonly thisBundleCapturing: boolean;
  };
  /**
   * True when a restic-backed export would have to queue behind running
   * captures. Advisory only — see the module note.
   */
  readonly blocked: boolean;
  readonly warnings: ReadonlyArray<string>;
}

export interface ExportPreflightDeps {
  readonly db: Database;
  readonly now?: () => Date;
}

/**
 * A component is restic-backed when its `sha256` holds a snapshot id.
 * Mirrors the SNAPSHOT_RE test in export-sources.ts — the two must agree, or
 * the dialog would promise a component the export does not carry.
 */
const SNAPSHOT_RE = /^[0-9a-f]{64}$/;

export async function buildExportPreflight(
  deps: ExportPreflightDeps,
  bundleId: string,
): Promise<ExportPreflight | null> {
  const now = (deps.now ?? (() => new Date()))();

  const [job] = await deps.db.select().from(backupJobs).where(eq(backupJobs.id, bundleId)).limit(1);
  if (!job) return null;

  const rows = await deps.db.select().from(backupComponents).where(and(
    eq(backupComponents.backupJobId, bundleId),
    eq(backupComponents.status, 'completed'),
  ));

  const components: ExportPreflightComponent[] = rows.map((r) => ({
    component: String(r.component),
    artifactName: String(r.artifactName ?? ''),
    sizeBytes: Number(r.sizeBytes ?? 0),
    source: typeof r.sha256 === 'string' && SNAPSHOT_RE.test(r.sha256) ? 'restic' : 'object',
  }));

  const totalBytes = components.reduce((a, c) => a + (Number.isFinite(c.sizeBytes) ? c.sizeBytes : 0), 0);
  const needsRestic = components.some((c) => c.source === 'restic');

  // Only non-stale rows hold a slot. `gte` on refreshed_at is the same
  // predicate the gate itself uses to decide whether to admit a capture.
  const cutoff = new Date(now.getTime() - IN_FLIGHT_STALE_AFTER_MS);
  const inFlightRows = await deps.db
    .select({ bundleId: tenantBundleInFlight.bundleId })
    .from(tenantBundleInFlight)
    .where(gte(tenantBundleInFlight.refreshedAt, cutoff));

  const inFlight = inFlightRows.length;
  const thisBundleCapturing = inFlightRows.some((r) => r.bundleId === bundleId);

  const [settings] = await deps.db.select().from(tenantBackupV2Settings)
    .where(eq(tenantBackupV2Settings.id, 1)).limit(1);
  const cap = Number(settings?.globalMaxInFlight ?? 0);

  // cap === 0 disables the cluster gate entirely, so there is nothing to be
  // short of. Reporting "0 slots free" there would warn on every export.
  const slotsFree = cap > 0 ? Math.max(0, cap - inFlight) : Number.POSITIVE_INFINITY;
  const blocked = needsRestic && cap > 0 && slotsFree === 0;

  const warnings: string[] = [];
  if (blocked) {
    warnings.push(
      `All ${cap} cluster backup slots are in use by ${inFlight} running capture(s). `
      + 'The download will start once a slot frees up — it is queued, not failed.',
    );
  }
  if (thisBundleCapturing) {
    warnings.push(
      'A capture for this same bundle is running right now. Exporting while it '
      + 'writes can be slow and the archive may not reflect the capture still in progress.',
    );
  }
  if (job.status !== 'completed') {
    warnings.push(
      `This bundle is "${job.status}", not "completed" — the export will contain only `
      + 'the components that were captured successfully.',
    );
  }
  if (components.length === 0) {
    warnings.push('No completed components found for this bundle; the export would be empty.');
  }

  return {
    bundleId,
    bundleStatus: String(job.status),
    components,
    totalBytes,
    needsRestic,
    capture: {
      inFlight,
      cap,
      slotsFree: Number.isFinite(slotsFree) ? slotsFree : -1,
      thisBundleCapturing,
    },
    blocked,
    warnings,
  };
}

/** Kept for callers that only need the gate view (the tenant panel's banner). */
export async function countActiveCaptures(deps: ExportPreflightDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - IN_FLIGHT_STALE_AFTER_MS);
  const rows = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(tenantBundleInFlight)
    .where(gte(tenantBundleInFlight.refreshedAt, cutoff));
  return Number(rows[0]?.n ?? 0);
}
