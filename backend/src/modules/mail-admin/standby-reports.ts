import { eq, sql } from 'drizzle-orm';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  copierRunningByNode, firstCopyState, onFirstCopy, standbySinceFrom, type FirstCopyState,
} from './standby-since.js';

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
): Promise<StandbyReport> {
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
  return entry;
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

const STANDBY_LABEL = 'insula.host/mail-standby';

export interface StandbyNodeReports {
  /** The latest report of each node that is a standby now. */
  readonly reports: readonly NodeStandbyReport[];
  /** Standby nodes still making their first copy, since when, and how it stands (standby-since.ts). */
  readonly preparing: ReadonlyArray<{ readonly node: string; readonly since: string; readonly state: FirstCopyState }>;
}

type ListedNode = { metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> } };

/**
 * The reports of the nodes that are standbys NOW, plus the standbys still on
 * their first copy.
 *
 * Every node that ever reported keeps its entry, so after the standby moved the
 * old node stayed in the list with a report that only aged — red, for a node
 * that no longer holds a copy (its data was set aside when it was de-elected).
 * A report from before a node became a standby again is from that earlier
 * stint, so it is left out too, and the node shows as preparing instead.
 *
 * When the nodes cannot be listed, every report is returned as before: an
 * extra row is better than an empty tile that reads as "no standby".
 */
export async function getCurrentStandbyReports(
  db: Database,
  cluster: {
    readonly listNodes: () => Promise<ReadonlyArray<ListedNode>>;
    /** The standby replicator's pods (STANDBY_REPLICATOR_SELECTOR in namespace mail). */
    readonly listCopierPods: () => Promise<ReadonlyArray<Parameters<typeof copierRunningByNode>[0][number]>>;
  },
  now: number = Date.now(),
): Promise<StandbyNodeReports> {
  const all = await getStandbyReports(db);
  let nodes: ReadonlyArray<ListedNode>;
  try {
    nodes = await cluster.listNodes();
  } catch {
    return { reports: all, preparing: [] };
  }
  // Unreadable pods: no claim either way (firstCopyState treats null as running).
  const copiers = await cluster.listCopierPods().then(copierRunningByNode, () => null);
  const byName = new Map(all.map((r) => [r.node, r]));
  const reports: NodeStandbyReport[] = [];
  const preparing: Array<{ node: string; since: string; state: FirstCopyState }> = [];
  for (const n of nodes) {
    if (n.metadata?.labels?.[STANDBY_LABEL] !== 'true') continue;
    const name = n.metadata?.name ?? '';
    const hostname = n.metadata?.labels?.['kubernetes.io/hostname'];
    // The replicator reports under the Node name; some sources use the hostname.
    const report = byName.get(name) ?? (hostname ? byName.get(hostname) : undefined);
    const since = standbySinceFrom(n.metadata?.annotations);
    if (onFirstCopy(since, report?.reportedAt)) {
      const copierRunning = copiers ? (copiers.get(name) ?? false) : null;
      preparing.push({ node: name, since: since as string, state: firstCopyState({ since: since as string, now, copierRunning }) });
    } else if (report) {
      reports.push(report);
    }
  }
  return {
    reports: reports.sort((a, b) => a.node.localeCompare(b.node)),
    preparing: preparing.sort((a, b) => a.node.localeCompare(b.node)),
  };
}
