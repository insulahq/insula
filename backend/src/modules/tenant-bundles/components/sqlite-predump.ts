/**
 * SQLite pre-capture logical dump(ADR-048 Primitive 3, extended).
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

type DumpDeployment = BackupDatabaseDumps['deployments'][number];

export interface SqliteCaptureArgs {
  readonly namespace: string;
  /** A file-manager pod the caller holds a lease on (file-manager/lease.ts). */
  readonly fmPod: string;
  readonly backupId: string;
  readonly kubeconfigPath?: string;
}

/** Dedicated capture dir on the tenant PVC (under /data → in the files snapshot). */
export const SQLITE_DUMP_DIR = '/data/.backup-sqlite-dumps';

/** Summary name used when the capture failed as a whole rather than per file. */
export const SQLITE_DISCOVERY_ENTRY = '(SQLite discovery)';

/** Error recorded for a file the script announced but never finished. */
const INTERRUPTED_ERROR =
  'dump interrupted - the file manager stopped before it finished; the raw file is still in the files snapshot';

/** Per-file bound on one `sqlite3 .dump`, in seconds. */
const DUMP_TIMEOUT_S = 900;

/** What one capture produced, and whether a dump in it was cut short. */
export interface SqliteCaptureResult {
  /** The summary entry, or null when the volume holds no SQLite files. */
  readonly entry: DumpDeployment | null;
  /**
   * A dump was started and never finished, so a partial file may still sit
   * on the PVC (see removePartialSqliteDumps). Also true when the exec itself
   * failed, since then nothing is known about how far it got.
   */
  readonly interrupted: boolean;
}

/**
 * Parse the discovery/dump script's line protocol. Each line is
 * `TAG|<file>|<extra>`:
 *   FOUND|<file>|                    → a SQLite file the script will dump
 *   OK|<file>|<sizeBytes>            → dumped
 *   DEGRADED|<file>|<reason>         → degraded (benign skip, e.g. PVC full)
 *   FAIL|<file>|<reason>             → failed (dump errored, or the whole
 *                                      capture refused, file = (SQLite discovery))
 *   DONE||                           → the script ran to its end
 *
 * The script announces every file (FOUND) before it dumps any, so a capture
 * cut short — the file manager OOM-killed or restarted mid-dump — leaves the
 * files it never finished as `failed` instead of silently absent: on
 * production a kill on the third of 21 files once reported two dumps and
 * nothing else. A capture that ends without DONE before announcing anything is
 * a failed discovery. `exitCode` is the exec's exit status, named in the error.
 */
export function parseSqliteCapture(
  stdout: string,
  exec: { readonly exitCode?: number } = {},
): SqliteCaptureResult {
  const found: string[] = [];
  const results = new Map<string, DumpDeployment['databases'][number]>();
  let done = false;
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
    if (tag === 'DONE') { done = true; continue; }
    if (!file) continue;
    if (tag === 'FOUND') {
      if (!found.includes(file)) found.push(file);
    } else if (tag === 'OK') {
      results.set(file, { name: file, status: 'dumped', sizeBytes: Number.parseInt(extra, 10) || 0 });
    } else if (tag === 'DEGRADED') {
      results.set(file, { name: file, status: 'degraded', sizeBytes: 0, error: extra || 'skipped' });
    } else if (tag === 'FAIL') {
      results.set(file, { name: file, status: 'failed', sizeBytes: 0, error: extra || 'sqlite .dump failed' });
    }
  }

  const exitNote = exec.exitCode !== undefined && exec.exitCode !== 0 ? ` (exit ${exec.exitCode})` : '';
  const unfinished = found.filter((f) => !results.has(f));
  const databases: DumpDeployment['databases'] = [];
  for (const file of found) {
    databases.push(results.get(file) ?? { name: file, status: 'failed', sizeBytes: 0, error: INTERRUPTED_ERROR + exitNote });
  }
  // Results the script never announced: an older script without FOUND
  // lines, or a capture-wide FAIL for (SQLite discovery).
  for (const [file, entry] of results) {
    if (!found.includes(file)) databases.push(entry);
  }
  if (databases.length === 0 && !done && (stdout.trim() !== '' || exitNote !== '')) {
    databases.push({
      name: SQLITE_DISCOVERY_ENTRY,
      status: 'failed',
      sizeBytes: 0,
      error: `SQLite discovery was cut short${exitNote}; SQLite files, if any, are only in the files snapshot`,
    });
  }
  return {
    entry: databases.length === 0 ? null : { deploymentId: '', deploymentName: '(sqlite files)', engine: 'sqlite', databases },
    interrupted: unfinished.length > 0,
  };
}

/** The summary entry alone — see {@link parseSqliteCapture}. */
export function parseSqliteDumpOutput(
  stdout: string,
  exec: { readonly exitCode?: number } = {},
): DumpDeployment | null {
  return parseSqliteCapture(stdout, exec).entry;
}

/**
 * Shell: enter the dump directory, refusing anything but the real directory.
 * Once inside, everything is addressed relative to the working directory — its
 * inode, not its path — so renaming or replacing the path cannot redirect what
 * root writes or deletes next.
 */
function enterDumpDir(dest: string): string {
  return `[ ! -L "${dest}" ] && cd "${dest}" 2>/dev/null && [ "$(pwd -P)" = "${dest}" ]`;
}

/** Overall bound on one capture run, in seconds; a file started after it is reported, not dumped. */
const CAPTURE_BUDGET_S = 1800;

/**
 * Build the discovery + validate + dump shell script (run in the file-manager
 * pod as root, over a volume whose names and contents the tenant controls).
 * POSIX sh: the file manager runs busybox ash, the tests dash. `root` and
 * `budgetSeconds` exist for tests; the file manager mounts the volume at /data.
 */
export function buildSqliteCaptureScript(
  backupId: string,
  opts: { readonly root?: string; readonly budgetSeconds?: number } = {},
): string {
  const root = opts.root ?? '/data';
  const dest = `${root}/${SQLITE_DUMP_DIR.slice('/data/'.length)}`;
  const bid = backupId.replace(/[^A-Za-z0-9._-]/g, '_');
  const budget = opts.budgetSeconds ?? CAPTURE_BUDGET_S;
  // Validity: SQLite files begin with the ASCII magic "SQLite format 3".
  const isSqlite = 'head -c 16 "$f" 2>/dev/null | grep -q "SQLite format 3"';
  const discovery = SQLITE_DISCOVERY_ENTRY;
  return [
    'set -u',
    `ROOT='${root}'`,
    `DEST='${dest}'`,
    "NL='",
    "'",
    `DEADLINE=$(( $(date +%s) + ${budget} ))`,
    // printf, not echo: a backslash in a tenant's file name must not reach the protocol.
    "say() { printf '%s|%s|%s\\n' \"$1\" \"$2\" \"$3\"; }",
    'mkdir -p "$DEST" 2>/dev/null || true',
    // The tenant owns everything under the volume, including this path: a
    // symlink or a swapped directory here would point root's writes and
    // deletes elsewhere.
    `if ! { ${enterDumpDir('$DEST')}; }; then say FAIL '${discovery}' 'the dump directory is not a plain directory on the volume; nothing was dumped'; exit 0; fi`,
    // Root's and closed to everyone else, so nothing the tenant runs can
    // create, swap or remove an entry in it while root writes there.
    `if [ "$(id -u)" -eq 0 ] && ! chown 0:0 .; then say FAIL '${discovery}' 'the dump directory could not be secured; nothing was dumped'; exit 0; fi`,
    `if ! chmod 0700 .; then say FAIL '${discovery}' 'the dump directory could not be secured; nothing was dumped'; exit 0; fi`,
    // Prune this tenant's stale sqlite predumps from the LIVE PVC — older
    // bundles keep their own copy inside their restic snapshot — and any
    // partial dump a killed capture left behind.
    'rm -f ./predump-*.sqlite.sql ./.partial-* 2>/dev/null || true',
    `T=$(mktemp) && R=$(mktemp) && V=$(mktemp) || { say FAIL '${discovery}' 'no temporary file for the file list'; exit 0; }`,
    'trap \'rm -f "$T" "$R" "$V"\' EXIT',
    // Discover candidate SQLite files (bounded), skipping our own dump dir and
    // any path with a newline in it (it would split into two list lines).
    // The image's GNU find matches on the file type the directory listing
    // already carries; busybox find lstat()s every entry, and the inode cache
    // that fills charges to the file manager's memory limit. On a volume of
    // 481k files it filled 239 MB of 256 MiB, and a dump write — which cannot
    // reclaim that cache — got the file manager OOM-killed.
    `( timeout ${budget} find "$ROOT" \\( -path "$DEST" -o -path "*$NL*" \\) -prune -o -type f \\( -iname "*.sqlite" -o -iname "*.db" -o -iname "*.sqlite3" \\) -print 2>/dev/null; echo $? > "$R" ) | head -n 201 > "$T"`,
    'FRC=$(cat "$R" 2>/dev/null); [ -n "$FRC" ] || FRC=255',
    // With 201 lines head ended the walk itself (find then dies of SIGPIPE).
    // Otherwise exit 1 is a path that vanished or was unreadable mid-walk —
    // normal on a live volume — while a timeout (124) or a signal (>= 128)
    // means the walk was cut short, so the list would silently miss files.
    `if [ $(( $(wc -l < "$T") )) -le 200 ] && [ "$FRC" -ge 124 ]; then say FAIL '${discovery}' "the file search was stopped (exit $FRC); SQLite files are only in the files snapshot"; exit 1; fi`,
    // Announce every SQLite file before dumping any (see parseSqliteCapture),
    // keeping the validated list for the dump loop.
    'head -n 200 "$T" | while IFS= read -r f; do',
    '  case "$f" in "$ROOT"/*) ;; *) continue ;; esac',
    `  ${isSqlite} || continue`,
    '  printf "%s\\n" "$f" >> "$V"',
    '  say FOUND "$f" ""',
    'done',
    'while IFS= read -r f; do',
    `  if [ "$(date +%s)" -ge "$DEADLINE" ]; then say FAIL "$f" 'the capture ran out of time (${budget} s); the raw file is still in the files snapshot'; continue; fi`,
    // Announced above, so it was a SQLite file a moment ago.
    `  if ! ${isSqlite}; then say FAIL "$f" 'the file changed or vanished before its dump'; continue; fi`,
    // A symlink swapped in after the walk would have root dump whatever it points at.
    `  if [ -L "$f" ] || [ ! -f "$f" ]; then say FAIL "$f" 'the file is no longer a regular file'; continue; fi`,
    // A hot rollback journal would have sqlite3, as root, replay a journal the
    // tenant can write — and delete the super-journal file it names.
    `  if [ -s "$f-journal" ]; then say DEGRADED "$f" 'an unfinished transaction (rollback journal) is pending; dump skipped, raw file still captured'; continue; fi`,
    // Room for this dump: keep the volume below 90% full, counting the dump.
    '  DF=$(df -Pk "$ROOT" 2>/dev/null | tail -1)',
    "  TOTAL_K=$(printf '%s\\n' \"$DF\" | awk '{print $2+0}'); AVAIL_K=$(printf '%s\\n' \"$DF\" | awk '{print $4+0}')",
    '  LIM_K=$(( ${AVAIL_K:-0} - ${TOTAL_K:-0} / 10 ))',
    `  if [ "\${TOTAL_K:-0}" -le 0 ]; then say DEGRADED "$f" 'the free space on the volume could not be read; sqlite dump skipped, raw file still captured'; continue; fi`,
    `  if [ "$LIM_K" -le 0 ]; then say DEGRADED "$f" 'PVC 90% full or more — sqlite dump skipped; raw file still captured'; continue; fi`,
    // The readable part of the name is the path, shortened; the hash keeps two
    // paths that flatten to the same text (a/b.db, a_b.db) apart.
    '  rel=$(printf "%s" "${f#"$ROOT"/}" | tr "/" "_" | cut -c1-120)',
    '  h=$(printf "%s" "$f" | sha256sum | cut -c1-12)',
    `  name="predump-\${rel}-\${h}-${bid}.sqlite.sql"`,
    // A rollback-journal database (header bytes 18-19 = 1) opens read-only: a
    // read-only open never rolls back a hot journal the tenant may have
    // crafted, nor deletes the super-journal it names. A WAL database (= 2)
    // has no rollback journal to replay, and a read-only open of one would
    // leave -shm/-wal files behind that it may not delete.
    '  RO=""; [ "$(od -An -j18 -N2 -tu1 "$f" 2>/dev/null | tr -s " " | sed "s/^ //;s/ $//")" = "1 1" ] && RO=-readonly',
    // Written to a fresh, unguessable name created in ONE exclusive open
    // (set -C: O_EXCL, never through a planted symlink to a file) — the
    // dump directory is root's, but the platform's own SFTP server writes
    // anywhere on the volume — and renamed only once complete, so a dump cut
    // short never sits under the name a restore looks for. The dump's exit
    // status travels through $R (>| past noclobber): a pipe would hide it,
    // and dash has no pipefail. The rm before mv: mv onto a symlink to a directory would move
    // the dump into that directory.
    '  tmp="./.partial-$(od -An -N8 -tx1 /dev/urandom | tr -d " \\n")"',
    // $R is emptied first: a subshell that dies before writing it must not
    // leave the previous file's status behind.
    '  : >| "$R"',
    `  if ! ( set -C; ( timeout ${DUMP_TIMEOUT_S} sqlite3 $RO "$f" ".dump" </dev/null 2>/dev/null; echo $? >| "$R" ) | head -c $(( LIM_K * 1024 )) > "$tmp" ); then rm -f "$tmp"; say FAIL "$f" 'the dump file could not be created or written'; continue; fi`,
    '  RC=$(cat "$R" 2>/dev/null); SZ=$(stat -c %s "$tmp" 2>/dev/null || echo 0)',
    `  if [ "$SZ" -ge $(( LIM_K * 1024 )) ]; then rm -f "$tmp"; say DEGRADED "$f" 'the dump would fill the volume past 90%; skipped, raw file still captured'; continue; fi`,
    `  if [ "\${RC:-1}" -eq 0 ] && rm -f "./$name" && mv -f "$tmp" "./$name"; then say OK "$f" "$SZ"; else rm -f "$tmp"; say FAIL "$f" 'sqlite .dump failed (locked, corrupt or over ${DUMP_TIMEOUT_S} s)'; fi`,
    'done < "$V"',
    'say DONE "" ""',
  ].join('\n');
}

/**
 * Discover + logical-dump every SQLite file on the tenant PVC via the
 * file-manager pod the caller holds. Never throws — a discovery failure is
 * non-fatal (the raw-files floor still captures SQLite) but is reported as a
 * failed entry, never as "no SQLite files".
 */
export async function runSqliteCapture(args: SqliteCaptureArgs): Promise<SqliteCaptureResult> {
  const { execInPod } = await import('../../../shared/k8s-exec.js');
  const fmPod = args.fmPod;
  try {
    const res = await execInPod(
      args.kubeconfigPath, args.namespace, fmPod, 'file-manager',
      ['sh', '-c', buildSqliteCaptureScript(args.backupId)],
    );
    return parseSqliteCapture(res.stdout, { exitCode: res.exitCode });
  } catch (err) {
    console.warn(
      `[bundle ${args.backupId}] sqlite pre-dump failed in ${args.namespace}/${fmPod}: ${(err as Error).message}`,
    );
    return {
      entry: {
        deploymentId: '',
        deploymentName: '(sqlite files)',
        engine: 'sqlite',
        databases: [{
          name: SQLITE_DISCOVERY_ENTRY,
          status: 'failed',
          sizeBytes: 0,
          error: 'SQLite discovery could not run in the file manager; SQLite files, if any, are only in the files snapshot',
        }],
      },
      interrupted: true,
    };
  }
}

/** Waits between cleanup attempts: a killed file manager takes a while to come back. */
const PARTIAL_CLEANUP_BACKOFF_MS: readonly number[] = [5_000, 15_000];

/**
 * Remove partial SQLite dumps a cut-short capture left on the PVC, before the
 * files snapshot can take them. `podFor` is asked for the pod on every
 * attempt: after an OOM kill the container restarts in place, and the first
 * exec can land before it is back. Best-effort and never throws — the next
 * capture removes partials too.
 */
export async function removePartialSqliteDumps(args: {
  readonly namespace: string;
  readonly podFor: () => Promise<string>;
  readonly backupId: string;
  readonly kubeconfigPath?: string;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const { execInPod } = await import('../../../shared/k8s-exec.js');
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const dest = SQLITE_DUMP_DIR;
  const cmd = `if ${enterDumpDir(dest)}; then rm -f ./.partial-*; fi`;
  let lastError = '';
  for (let attempt = 0; attempt <= PARTIAL_CLEANUP_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) await sleep(PARTIAL_CLEANUP_BACKOFF_MS[attempt - 1]!);
    try {
      const pod = await args.podFor();
      const res = await execInPod(args.kubeconfigPath, args.namespace, pod, 'file-manager', ['sh', '-c', cmd]);
      if (res.exitCode === 0) return true;
      lastError = `exit ${res.exitCode}${res.stderr ? `: ${res.stderr.trim()}` : ''}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  console.warn(
    `[bundle ${args.backupId}] partial sqlite dump cleanup failed in ${args.namespace}: ${lastError}`,
  );
  return false;
}
