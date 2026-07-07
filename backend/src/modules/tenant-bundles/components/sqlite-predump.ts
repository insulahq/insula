/**
 * SQLite pre-capture logical dump (ADR-048 Primitive 3, extended 2026-07-07).
 *
 * Unlike MariaDB/MySQL/PostgreSQL/MongoDB, SQLite is NOT a catalog "database"
 * deployment — it is a file inside a tenant's application PVC (a PHP app's
 * `app.sqlite`, etc.). The SQL Manager already opens/edits such files via the
 * file-manager pod (`sqlite3`), so this hook reuses that reach to discover
 * every SQLite file on the PVC and capture a portable `.dump` next to the
 * SQL-engine predumps, INSIDE the files snapshot.
 *
 * Design mirrors database-predump.ts:
 *   - Runs BEFORE the files-component restic capture (dump must be on the PVC).
 *   - Failures are per-file and NON-fatal: the raw SQLite file is always in the
 *     files snapshot and crash-recovers (WAL), so a failed/degraded `.dump`
 *     only means the portable logical layer is missing for that file.
 *   - Discovery is heuristic (extension + SQLite magic header) and bounded
 *     (first 200 matches) so a pathological tree can't hang the bundle.
 *
 * Output lands in a dedicated `/data/.backup-sqlite-dumps/` dir (kept out of
 * the app's own folders); older dumps there are pruned before each capture
 * (prior bundles retain their own copy inside their restic snapshot).
 *
 * Restore: the raw SQLite file is restored by the `files-paths` restore item
 * and crash-recovers on open; the `.dump` is the belt-and-suspenders portable
 * copy for a manual SQL Manager import (there is no live "SQLite pod" to
 * auto-import into, so `databases-by-id` does not touch SQLite).
 */

import type { BackupDatabaseDumps } from '@insula/api-contracts';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';

type DumpDeployment = BackupDatabaseDumps['deployments'][number];

export interface SqliteCaptureArgs {
  readonly k8s: K8sClients;
  readonly namespace: string;
  readonly backupId: string;
  readonly kubeconfigPath?: string;
}

/** Dedicated capture dir on the tenant PVC (under /data → in the files snapshot). */
export const SQLITE_DUMP_DIR = '/data/.backup-sqlite-dumps';

/**
 * Parse the discovery/dump script's line protocol into a summary deployment
 * entry. Each line is `TAG|<file>|<extra>`:
 *   OK|<file>|<sizeBytes>            → dumped
 *   DEGRADED|<file>|<reason>         → degraded (benign skip, e.g. PVC full)
 *   FAIL|<file>|<reason>             → failed (dump errored)
 * Returns null when no SQLite files were found (nothing to summarise).
 */
export function parseSqliteDumpOutput(stdout: string): DumpDeployment | null {
  const databases: DumpDeployment['databases'] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bar = line.indexOf('|');
    if (bar < 0) continue;
    const tag = line.slice(0, bar);
    const rest = line.slice(bar + 1);
    const bar2 = rest.lastIndexOf('|');
    const file = bar2 >= 0 ? rest.slice(0, bar2) : rest;
    const extra = bar2 >= 0 ? rest.slice(bar2 + 1) : '';
    if (!file) continue;
    if (tag === 'OK') {
      databases.push({ name: file, status: 'dumped', sizeBytes: Number.parseInt(extra, 10) || 0 });
    } else if (tag === 'DEGRADED') {
      databases.push({ name: file, status: 'degraded', sizeBytes: 0, error: extra || 'skipped' });
    } else if (tag === 'FAIL') {
      databases.push({ name: file, status: 'failed', sizeBytes: 0, error: extra || 'sqlite .dump failed' });
    }
  }
  if (databases.length === 0) return null;
  return { deploymentId: '', deploymentName: '(sqlite files)', engine: 'sqlite', databases };
}

/** Build the discovery + validate + dump shell script (run in the file-manager pod). */
export function buildSqliteCaptureScript(backupId: string): string {
  const bid = backupId.replace(/[^A-Za-z0-9._-]/g, '_');
  return [
    'set -u',
    `DEST=${SQLITE_DUMP_DIR}`,
    'mkdir -p "$DEST" 2>/dev/null || true',
    // Prune this tenant's stale sqlite predumps from the LIVE PVC — older
    // bundles keep their own copy inside their restic snapshot.
    'rm -f "$DEST"/predump-*.sqlite.sql 2>/dev/null || true',
    // PVC fullness (5th df -P field is Capacity%). Avoid ENOSPC on the live app.
    'CAP=$(df -P /data 2>/dev/null | tail -1 | tr -s " " | cut -d" " -f5 | tr -d "%")',
    // Discover candidate SQLite files (bounded), skipping our own dump dir.
    'find /data -path "$DEST" -prune -o -type f \\( -iname "*.sqlite" -o -iname "*.db" -o -iname "*.sqlite3" \\) -print 2>/dev/null | head -200 | while IFS= read -r f; do',
    // Validity: SQLite files begin with the ASCII magic "SQLite format 3".
    '  head -c 16 "$f" 2>/dev/null | grep -q "SQLite format 3" || continue',
    '  if [ "${CAP:-0}" -ge 90 ]; then echo "DEGRADED|$f|PVC ${CAP}% full — sqlite dump skipped; raw file still captured"; continue; fi',
    '  rel=$(printf "%s" "$f" | sed "s#^/data/##" | tr "/" "_")',
    `  out="$DEST/predump-\${rel}-${bid}.sqlite.sql"`,
    '  if sqlite3 "$f" ".dump" > "$out" 2>/dev/null; then sz=$(stat -c %s "$out" 2>/dev/null || echo 0); echo "OK|$f|$sz"; else rm -f "$out" 2>/dev/null; echo "FAIL|$f|sqlite .dump failed (locked or corrupt)"; fi',
    'done',
  ].join('\n');
}

/**
 * Discover + logical-dump every SQLite file on the tenant PVC via the
 * file-manager pod. Returns a summary deployment entry (engine='sqlite') or
 * null when there is no file-manager pod / no SQLite files. Never throws — a
 * discovery failure is non-fatal (the raw-files floor still captures SQLite).
 */
export async function runSqliteCapture(args: SqliteCaptureArgs): Promise<DumpDeployment | null> {
  const { execInPod } = await import('../../../shared/k8s-exec.js');
  const { getReadyFileManagerPod } = await import('../../file-manager/service.js');

  let fmPod: string;
  try {
    fmPod = await getReadyFileManagerPod(args.k8s, args.namespace);
  } catch {
    // No file-manager pod → cannot discover SQLite files. Not an error; the
    // raw-files snapshot still captures any SQLite file on the PVC.
    return null;
  }

  try {
    const res = await execInPod(
      args.kubeconfigPath, args.namespace, fmPod, 'file-manager',
      ['sh', '-c', buildSqliteCaptureScript(args.backupId)],
    );
    return parseSqliteDumpOutput(res.stdout);
  } catch {
    return null;
  }
}
