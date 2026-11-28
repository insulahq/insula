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
 *   - Discovery leaves out folders whose SQLite files are not a hosted app's
 *     databases (NOT_DATABASE_FOLDERS): dependency trees, and the files a
 *     Nextcloud's users keep in it. They stay in the files snapshot as files.
 *     On production these were Composer test fixtures and a user's music
 *     project files, each tracked and alerted on like a database.
 *   - sqlite3 runs as the file's owner, never as root, and opens the tenant's
 *     file read-only: nothing is replayed in place, and what SQLite does with
 *     a journal is only what the tenant's own app could do. A database with
 *     an unfinished transaction left behind (a hot rollback journal) is
 *     dumped from a copy, rolled back there, also as the owner.
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
 * Folders discovery does not descend into: what is in them is not a hosted
 * app's database, and it stays in the files snapshot as a file.
 *   - `dependencies`: a package manager's copy of other people's code, test
 *     fixtures included (Composer's `vendor/rubix/ml/tests/test.sqlite`).
 *   - `nextcloudUser`: `<data directory>/<user>/<folder>`, the files a
 *     Nextcloud or ownCloud user uploads, their old versions and their trash.
 *   - `nextcloudData`: `<data directory>/<folder>`, group folders and the
 *     updater's backups of Nextcloud's own code.
 * A Nextcloud data directory is the one holding `.ocdata`, the marker
 * Nextcloud itself checks for, so a `files` folder anywhere else (Drupal keeps
 * its database in `sites/default/files/.ht.sqlite`) is still searched.
 * Nextcloud's own database (`<data directory>/<name>.db`) and its apps' data
 * (`appdata_*`) are still found.
 */
export const NOT_DATABASE_FOLDERS = {
  dependencies: ['node_modules', 'vendor', 'bower_components', '.git'],
  nextcloudUser: ['files', 'files_versions', 'files_trashbin', 'uploads'],
  nextcloudData: ['__groupfolders', 'updater-*'],
} as const;

/** find(1) operands that match a NOT_DATABASE_FOLDERS folder, for `\( … \) -prune`. */
function notDatabaseFolders(): string {
  const names = (list: readonly string[]): string => list.map((n) => `-name "${n}"`).join(' -o ');
  const { dependencies, nextcloudUser, nextcloudData } = NOT_DATABASE_FOLDERS;
  return [
    `-type d \\( ${names(dependencies)} \\)`,
    `-type d \\( ${names(nextcloudUser)} \\) -exec test -e {}/../../.ocdata \\;`,
    `-type d \\( ${names(nextcloudData)} \\) -exec test -e {}/../.ocdata \\;`,
  ].join(' -o ');
}

/**
 * A hot journal that changed this recently, or whose database did, may belong
 * to a transaction still being written: a copy of the pair could catch them
 * mid-write, so it waits for the next bundle.
 */
const HOT_JOURNAL_QUIET_S = 600;

/** The rollback-journal magic: a journal ending in it names a super-journal (a multi-database transaction). */
const JOURNAL_MAGIC_HEX = 'd9d505f920a163d7';

/** What a copy folder holds: the copy, its journal, and what SQLite may add on open. */
const COPY_ENTRIES = 'db db-journal db-wal db-shm';

/** Bound on copying a database and its journal for a rollback, in seconds (a FIFO would block `cat` forever). */
const COPY_TIMEOUT_S = 600;

/**
 * Run as the copy's owner in the copy folder (`db`, `db-journal`): the checks
 * that decide, on the copy's own bytes, then the dump of the copy, which
 * sqlite3 rolls back on open. Exit 10: the journal is not hot after all (it
 * was committed while copied; dump the file in place instead), 11: it names
 * a super-journal, 12: not a rollback-journal database, 13: a link.
 * No single quote: it is a single-quoted shell word in the script.
 */
export const ON_COPY_SCRIPT = [
  '[ ! -L ./db ] && [ ! -L ./db-journal ] || exit 13',
  '[ "$(od -An -tu1 -N1 ./db-journal | tr -d " ")" != 0 ] || exit 10',
  '[ "$(od -An -j18 -N2 -tu1 ./db | tr -s " " | sed "s/^ //;s/ $//")" = "1 1" ] || exit 12',
  `[ "$(tail -c 8 ./db-journal | od -An -tx1 | tr -d " \\n")" != ${JOURNAL_MAGIC_HEX} ] || exit 11`,
  'exec sqlite3 -nofollow ./db .dump',
].join('; ');

const DEGRADED_SUPER = 'an unfinished transaction spanning several databases is pending; dump skipped, raw file still captured';
const DEGRADED_NOT_ROLLBACK = 'an unfinished transaction is pending on a database not in rollback-journal mode; dump skipped, raw file still captured';

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
    // Dumps, copies and their folders are root's (or the owner's) alone: the
    // dump directory is passable (0711) and dump names are predictable.
    'umask 077',
    `ROOT='${root}'`,
    `DEST='${dest}'`,
    "NL='",
    "'",
    `DEADLINE=$(( $(date +%s) + ${budget} ))`,
    // printf, not echo: a backslash in a tenant's file name must not reach the protocol.
    "say() { printf '%s|%s|%s\\n' \"$1\" \"$2\" \"$3\"; }",
    'rnd() { od -An -N8 -tx1 /dev/urandom | tr -d " \\n"; }',
    'ME=$(id -u)',
    // sqlite3 never runs as root on the tenant's files: it runs as the file's
    // owner, so what SQLite does there — replay a journal and delete the
    // super-journal it names, create -shm/-wal files — is what the tenant's
    // own app could do. (Not root, as in the tests: already unprivileged.)
    'as() { u=$1; g=$2; shift 2; if [ "$ME" -eq 0 ] && [ "$u" -ne 0 ]; then setpriv --reuid="$u" --regid="$g" --clear-groups "$@"; else "$@"; fi; }',
    // In the file's real directory — its inode, not its path — or not at all:
    // a directory swapped for a symlink after the walk is refused.
    'here() { cd -P "$P" 2>/dev/null && [ "$(pwd -P)" = "$P" ]; }',
    // The dump into $tmp (one exclusive open), its exit status into $R.
    `todump() { : >| "$R"; ( set -C; ( "$@" </dev/null 2>/dev/null; echo $? >| "$R" ) | head -c $(( LIM_K * 1024 )) > "$tmp" ); }`,
    // Read-only, so nothing is replayed in place (a hot journal is refused),
    // and -nofollow, so the database is not a link. A read-only WAL open
    // still creates and writes -wal/-shm: for a root-owned file (opened as
    // root) neither may be a link, which would point those writes elsewhere.
    `inplace() { here && { [ "$U" -ne 0 ] || { [ ! -L "./$B-wal" ] && [ ! -L "./$B-shm" ]; }; } && as "$U" "$G" timeout ${DUMP_TIMEOUT_S} sqlite3 -nofollow -readonly "./$B" .dump; }`,
    // An unfinished transaction: copy the database, then its journal, into a
    // folder of the dump directory, and roll the copy back on open. The copy,
    // the checks and the rollback all run as the owner (a root-owned file's
    // copy is rolled back as nobody), and every decision is made on the
    // copy's bytes — the tenant's own can change between a check and a read.
    // Each file is opened once and the open descriptor checked — a regular
    // file at the very path — so a link swapped in after any earlier check
    // is refused: for a root-owned file this copy runs as root.
    `copy() { here && as "$U" "$G" timeout ${COPY_TIMEOUT_S} sh -c 'set -C; exec 3< "./$1" 4< "./$1-journal" || exit 1; [ -f /proc/self/fd/3 ] && [ -f /proc/self/fd/4 ] && [ "$(readlink /proc/self/fd/3)" = "$3/$1" ] && [ "$(readlink /proc/self/fd/4)" = "$3/$1-journal" ] || exit 1; cat <&3 > "$2/db" && cat <&4 > "$2/db-journal"' copy "$B" "$DREAL/\${SCR#./}" "$P"; }`,
    `ONCOPY='${ON_COPY_SCRIPT}'`,
    `oncopy() { cd -P "$SCR" 2>/dev/null && [ "$(pwd -P)" = "$DREAL/\${SCR#./}" ] && as "$RU" "$RG" timeout ${DUMP_TIMEOUT_S} sh -c "$ONCOPY"; }`,
    // Copy folders are the owner's to write, and busybox rm -r follows a
    // folder swapped for a link mid-walk: so only the entries a copy has are
    // removed, from inside the folder, then the folder itself.
    `rmcopy() { ( cd -P "$1" 2>/dev/null && [ "$(pwd -P)" = "$DREAL/\${1#./}" ] && rm -f ${COPY_ENTRIES} ); rmdir "$1" 2>/dev/null; }`,
    'dropcopy() { [ -n "$SCR" ] && rmcopy "$SCR"; SCR=""; }',
    'mkdir -p "$DEST" 2>/dev/null || true',
    // The tenant owns everything under the volume, including this path: a
    // symlink or a swapped directory here would point root's writes and
    // deletes elsewhere.
    `if ! { ${enterDumpDir('$DEST')}; }; then say FAIL '${discovery}' 'the dump directory is not a plain directory on the volume; nothing was dumped'; exit 0; fi`,
    // Root's, and nobody else may list, create, swap or remove an entry in it
    // while root writes there. Others may pass through it, to the copy folder
    // made for the file's owner (copy()), whose name they cannot guess.
    `if [ "$ME" -eq 0 ] && ! chown 0:0 .; then say FAIL '${discovery}' 'the dump directory could not be secured; nothing was dumped'; exit 0; fi`,
    `if ! chmod 0711 .; then say FAIL '${discovery}' 'the dump directory could not be secured; nothing was dumped'; exit 0; fi`,
    'DREAL=$(pwd -P)',
    // Prune this tenant's stale sqlite predumps from the LIVE PVC — older
    // bundles keep their own copy inside their restic snapshot — and any
    // partial dump a killed capture left behind.
    'rm -f ./predump-*.sqlite.sql ./.partial-* 2>/dev/null; for d in ./.partial-*.d; do [ -d "$d" ] && [ ! -L "$d" ] && rmcopy "$d"; done',
    `T=$(mktemp) && R=$(mktemp) && V=$(mktemp) || { say FAIL '${discovery}' 'no temporary file for the file list'; exit 0; }`,
    'trap \'rm -f "$T" "$R" "$V"\' EXIT',
    // Discover candidate SQLite files (bounded), skipping our own dump dir,
    // any path with a newline in it (it would split into two list lines) and
    // the NOT_DATABASE_FOLDERS — pruned in the walk, so they neither cost the
    // walk nor take places in the 200.
    // The image's GNU find matches on the file type the directory listing
    // already carries; busybox find lstat()s every entry, and the inode cache
    // that fills charges to the file manager's memory limit. On a volume of
    // 481k files it filled 239 MB of 256 MiB, and a dump write — which cannot
    // reclaim that cache — got the file manager OOM-killed.
    `( timeout ${budget} find "$ROOT" \\( -path "$DEST" -o -path "*$NL*" -o ${notDatabaseFolders()} \\) -prune -o -type f \\( -iname "*.sqlite" -o -iname "*.db" -o -iname "*.sqlite3" \\) -print 2>/dev/null; echo $? > "$R" ) | head -n 201 > "$T"`,
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
    '  SCR=""',
    `  if [ "$(date +%s)" -ge "$DEADLINE" ]; then say FAIL "$f" 'the capture ran out of time (${budget} s); the raw file is still in the files snapshot'; continue; fi`,
    // Announced above, so it was a SQLite file a moment ago.
    `  if ! ${isSqlite}; then say FAIL "$f" 'the file changed or vanished before its dump'; continue; fi`,
    `  if [ -L "$f" ] || [ ! -f "$f" ]; then say FAIL "$f" 'the file is no longer a regular file'; continue; fi`,
    '  P=${f%/*}; B=${f##*/}; U=$(stat -c %u "$f" 2>/dev/null); G=$(stat -c %g "$f" 2>/dev/null)',
    `  case "$U:$G" in *[!0-9:]*|:*|*:) say FAIL "$f" 'its owner could not be read'; continue ;; esac`,
    // Header bytes 18-19: "1 1" a rollback-journal database, "2 2" WAL.
    '  MODE=$(od -An -j18 -N2 -tu1 "$f" 2>/dev/null | tr -s " " | sed "s/^ //;s/ $//")',
    '  J="$f-journal"; HOT=""',
    `  if [ -L "$J" ] || { [ -e "$J" ] && [ ! -f "$J" ]; }; then say DEGRADED "$f" 'its rollback journal is not a regular file; dump skipped, raw file still captured'; continue; fi`,
    // SQLite's own test (pager.c hasHotJournal): a journal whose first byte is
    // zero is finished. journal_mode=PERSIST leaves one behind every commit.
    // These checks of the tenant's files only choose the way in: the copy is
    // checked again (ONCOPY), and the read-only open refuses a hot journal.
    '  [ -s "$J" ] && [ "$(od -An -tu1 -N1 "$J" 2>/dev/null | tr -d " ")" != 0 ] && HOT=1',
    '  if [ -n "$HOT" ]; then',
    `    if [ "$MODE" != "1 1" ]; then say DEGRADED "$f" '${DEGRADED_NOT_ROLLBACK}'; continue; fi`,
    `    if [ "$(tail -c 8 "$J" 2>/dev/null | od -An -tx1 | tr -d " \\n")" = ${JOURNAL_MAGIC_HEX} ]; then say DEGRADED "$f" '${DEGRADED_SUPER}'; continue; fi`,
    '    NOW=$(date +%s); JT=$(stat -c %Y "$J" 2>/dev/null || echo "$NOW"); FT=$(stat -c %Y "$f" 2>/dev/null || echo "$NOW")',
    `    if [ $(( NOW - JT )) -lt ${HOT_JOURNAL_QUIET_S} ] || [ $(( NOW - FT )) -lt ${HOT_JOURNAL_QUIET_S} ]; then say DEGRADED "$f" 'a transaction is in progress (its rollback journal changed in the last ${HOT_JOURNAL_QUIET_S / 60} minutes); dump skipped, raw file still captured'; continue; fi`,
    '  fi',
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
    // Written to a fresh, unguessable name created in ONE exclusive open
    // (set -C: O_EXCL, never through a planted symlink to a file) — the
    // dump directory is root's, but the platform's own SFTP server writes
    // anywhere on the volume — and renamed only once complete, so a dump cut
    // short never sits under the name a restore looks for. The dump's exit
    // status travels through $R (>| past noclobber): a pipe would hide it,
    // and dash has no pipefail. The rm before mv: mv onto a symlink to a directory would move
    // the dump into that directory.
    '  tmp="./.partial-$(rnd)"',
    '  if [ -n "$HOT" ]; then',
    '    COPY_K=$(( ( $(stat -c %s "$f" 2>/dev/null || echo 0) + $(stat -c %s "$J" 2>/dev/null || echo 0) ) / 1024 + 1 ))',
    `    if [ "$COPY_K" -ge "$LIM_K" ]; then say DEGRADED "$f" 'an unfinished transaction is pending and there is no room to roll it back on a copy without filling the volume past 90%; dump skipped, raw file still captured'; continue; fi`,
    '    LIM_K=$(( LIM_K - COPY_K )); SCR="./.partial-$(rnd).d"; BEFORE=$(stat -c "%s %Y" "$f" "$J" 2>/dev/null)',
    `    if ! mkdir -m 0700 "$SCR" 2>/dev/null || { [ "$ME" -eq 0 ] && [ "$U" -ne 0 ] && ! chown "$U:$G" "$SCR"; }; then dropcopy; say FAIL "$f" 'no folder to copy it into'; continue; fi`,
    // Unchanged while copied, or the pair may not belong together.
    `    if ! ( copy ) 2>/dev/null || [ "$(stat -c "%s %Y" "$f" "$J" 2>/dev/null)" != "$BEFORE" ]; then dropcopy; say DEGRADED "$f" 'an unfinished transaction is pending and the file changed while it was copied to roll it back; dump skipped, raw file still captured'; continue; fi`,
    '    RU=$U; RG=$G',
    '    if [ "$ME" -eq 0 ] && [ "$U" -eq 0 ]; then RU=65534; RG=65534; chown -h 65534:65534 "$SCR" "$SCR/db" "$SCR/db-journal" 2>/dev/null || { dropcopy; say FAIL "$f" \'the copy could not be handed to nobody\'; continue; }; fi',
    `    if ! todump oncopy; then rm -f "$tmp"; dropcopy; say FAIL "$f" 'the dump file could not be created or written'; continue; fi`,
    '    RC=$(cat "$R" 2>/dev/null); dropcopy',
    '    case "$RC" in',
    // Finished after all (committed while it was copied): the read-only open is right.
    '      10) rm -f "$tmp"; HOT="" ;;',
    `      11) rm -f "$tmp"; say DEGRADED "$f" '${DEGRADED_SUPER}'; continue ;;`,
    `      12) rm -f "$tmp"; say DEGRADED "$f" '${DEGRADED_NOT_ROLLBACK}'; continue ;;`,
    `      13) rm -f "$tmp"; say DEGRADED "$f" 'its rollback journal is not a regular file; dump skipped, raw file still captured'; continue ;;`,
    '    esac',
    '  fi',
    '  if [ -z "$HOT" ]; then',
    `    if ! todump inplace; then rm -f "$tmp"; say FAIL "$f" 'the dump file could not be created or written'; continue; fi`,
    '    RC=$(cat "$R" 2>/dev/null)',
    '  fi',
    '  SZ=$(stat -c %s "$tmp" 2>/dev/null || echo 0)',
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
  // As the capture's own sweep: files first, then each copy folder's known
  // entries, from inside it — never a recursive delete (see rmcopy).
  const cmd = `if ${enterDumpDir(dest)}; then rm -f ./.partial-* 2>/dev/null; for d in ./.partial-*.d; do [ -d "$d" ] && [ ! -L "$d" ] && ( cd -P "$d" && [ "$(pwd -P)" = "${dest}/\${d#./}" ] && rm -f ${COPY_ENTRIES} ); rmdir "$d" 2>/dev/null; done; true; fi`;
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
