import { eq, sql } from 'drizzle-orm';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export interface StandbyReport {
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly durationSeconds: number;
  readonly reportedAt: string;
}

export interface StandbyReportInput {
  readonly node: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly durationSeconds: number;
}

export interface NodeStandbyReport extends StandbyReport {
  readonly node: string;
  readonly ageSeconds: number;
}

// system_settings.id is a varchar in this schema; the singleton row
// is keyed by the literal 'system' (matches snapshot-settings.ts).
const SETTINGS_ID = 'system';

/**
 * Merge one node's freshness report into the JSONB blob.
 *
 * Uses a server-side jsonb_set so we don't read-modify-write under a
 * race: two DaemonSet pods can POST at the same instant and both
 * land cleanly. COALESCE handles the first-ever report (column is
 * NULL on a fresh install).
 *
 * The shape is `{[nodeName]: StandbyReport}` — overwrites the prior
 * entry for that node (only the latest report per node is kept).
 */
export async function recordStandbyReport(
  db: Database,
  input: StandbyReportInput,
): Promise<void> {
  const entry: StandbyReport = {
    sizeBytes: input.sizeBytes,
    fileCount: input.fileCount,
    durationSeconds: input.durationSeconds,
    reportedAt: new Date().toISOString(),
  };
  await db
    .update(systemSettings)
    .set({
      mailStandbyReports: sql`
        jsonb_set(
          COALESCE(${systemSettings.mailStandbyReports}, '{}'::jsonb),
          ${`{${input.node}}`}::text[],
          ${JSON.stringify(entry)}::jsonb,
          true
        )
      `,
    })
    .where(eq(systemSettings.id, SETTINGS_ID));
}

/**
 * Read all per-node reports, sorted by node hostname for stable UI
 * rendering. Adds a derived `ageSeconds` field so the frontend
 * doesn't reimplement the Date math.
 */
export async function getStandbyReports(db: Database): Promise<readonly NodeStandbyReport[]> {
  const row = await db
    .select({ reports: systemSettings.mailStandbyReports })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID))
    .limit(1);
  // The schema's $type annotation gives us the JSONB shape, but
  // Drizzle exposes the column as `unknown | null` at the inferred
  // select-shape level. Coerce through Record<string, StandbyReport>
  // — the column is only written by recordStandbyReport above, so
  // the runtime shape is guaranteed.
  const reports = (row[0]?.reports ?? {}) as Record<string, StandbyReport>;
  const now = Date.now();
  return Object.entries(reports)
    .map(([node, r]): NodeStandbyReport => ({
      node,
      sizeBytes: r.sizeBytes,
      fileCount: r.fileCount,
      durationSeconds: r.durationSeconds,
      reportedAt: r.reportedAt,
      ageSeconds: Math.max(0, Math.floor((now - new Date(r.reportedAt).getTime()) / 1000)),
    }))
    .sort((a, b) => a.node.localeCompare(b.node));
}
