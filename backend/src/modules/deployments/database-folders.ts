/**
 * File work on the protected database folder (roadmap R48).
 *
 * The file-manager container sees `database/` as an empty read-only folder, so
 * everything the platform does there runs in the `platform-files` container of
 * the same pod (file-manager/protected-folder.ts). Every operation is one fixed
 * shell script with its paths passed as arguments — never interpolated — and
 * every path is relative to the volume root and validated here first.
 *
 * Moves are `rename(2)` on the one volume: instant, no copy, no extra space.
 * A move refuses a path any of whose components is a symlink, a destination
 * that exists, and a source that is not a real directory; and it checks after
 * the rename that the destination is a real directory. A folder moved INTO the
 * protected folder also has its hard links broken (each multiply-linked file is
 * replaced by a copy), so a second name the tenant made for a file outside no
 * longer reaches the live one.
 */
import { DATABASE_ROOT, KEPT_DATABASES_ROOT } from '@insula/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { execInPod, type ExecResult } from '../../shared/k8s-exec.js';
import { withFileManagerLease } from '../file-manager/lease.js';
import { FM_PLATFORM_CONTAINER } from '../file-manager/protected-folder.js';

export type PlatformFilesRun = (argv: readonly string[]) => Promise<ExecResult>;

/** Runs `fn` with the file manager held up and a runner for its platform container. */
export async function withPlatformFiles<T>(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  purpose: string,
  fn: (run: PlatformFilesRun, podName: string) => Promise<T>,
): Promise<T> {
  return withFileManagerLease(k8s, namespace, purpose, (podName) =>
    fn((argv) => execInPod(kubeconfigPath, namespace, podName, FM_PLATFORM_CONTAINER, argv), podName));
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const MAX_SEGMENTS = 6;

/** A volume-relative path the platform may operate on: plain segments, no dot-names. */
export function isPlatformPath(path: string): boolean {
  const segs = path.split('/');
  return segs.length >= 1 && segs.length <= MAX_SEGMENTS && segs.every((s) => SEGMENT.test(s));
}

function assertPlatformPath(path: string): void {
  if (!isPlatformPath(path)) throw new Error(`not a plain volume path: ${JSON.stringify(path)}`);
}

/**
 * Settings a PostgreSQL configuration file may not carry into an attached
 * folder: a shell command the server runs, code it loads at start (before the
 * hardening pass could clear it), or another file pulled in. The same lists as
 * pg-hardening.ts (COMMAND_SETTINGS, LOADING_SETTINGS), plus includes.
 */
export const PG_UNSAFE_FILE_SETTINGS = [
  'archive_command', 'archive_cleanup_command', 'restore_command', 'recovery_end_command', 'ssl_passphrase_command',
  'archive_library', 'shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries',
  'dynamic_library_path', 'jit_provider', 'include', 'include_if_exists', 'include_dir',
  // Where the server reads its access rules and other files from, and where
  // its socket lives — the platform's own login depends on both.
  'config_file', 'hba_file', 'ident_file', 'data_directory', 'external_pid_file',
  'unix_socket_directories', 'unix_socket_group', 'unix_socket_permissions',
] as const;

/** `[Aa][Rr]…`: setting names are case-insensitive, and not every sed knows a case flag. */
function anyCase(word: string): string {
  return [...word].map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join('');
}
const PG_UNSAFE_SETTINGS_RE = PG_UNSAFE_FILE_SETTINGS.map(anyCase).join('|');
/**
 * pg_hba.conf lines that let a client in without the password the platform
 * controls — any non-local rule whose method is not scram-sha-256, md5,
 * password or reject — and includes. The reset init container puts the
 * platform's local rules first on every start.
 */
const PG_HBA_UNSAFE_RE = `^[[:space:]]*(${['host', 'hostssl', 'hostnossl', 'hostgssenc', 'hostnogssenc'].map(anyCase).join('|')})[[:space:]].*[[:space:]](${['trust', 'ident', 'peer', 'cert', 'gss', 'sspi', 'ldap', 'radius', 'pam', 'bsd', 'oauth'].map(anyCase).join('|')})([[:space:]]|$)`;
const PG_HBA_INCLUDE_RE = `^[[:space:]]*(${['include', 'include_if_exists', 'include_dir'].map(anyCase).join('|')})[[:space:]]`;

/**
 * The operations. `$1` names one; the rest are volume-relative paths. Exit
 * codes: 0 done, 3 a component is a symlink or not a directory (or a file
 * resolves where it may not), 4 the source is missing, 5 the destination
 * exists, 6 the operation failed, 7 bad input, 8 a hard link is left, 9 the
 * folder holds hard-linked files (not moved, or moved back), 10 moved but
 * hard links are left and it could not be moved back.
 */
export const FOLDER_OPS_SH = String.raw`set -u
check_path() {
  rest=$1; p=/data
  while [ -n "$rest" ]; do
    seg=${'$'}{rest%%/*}
    case "$rest" in */*) rest=${'$'}{rest#*/} ;; *) rest= ;; esac
    case "$seg" in ''|.|..) echo "bad path"; exit 7 ;; esac
    p=$p/$seg
    if [ -L "$p" ]; then echo "symlink: $p"; exit 3; fi
    if [ -e "$p" ] && [ ! -d "$p" ]; then echo "not a directory: $p"; exit 3; fi
  done
}
parent_of() { case "$1" in */*) echo "${'$'}{1%/*}" ;; *) echo "" ;; esac; }
kind_of() { if [ -L "$1" ]; then echo link; elif [ -d "$1" ]; then echo dir; elif [ -e "$1" ]; then echo other; else echo missing; fi; }
# Each multiply-linked file under $1 becomes a copy of its own: a second name
# made elsewhere no longer reaches it. The copy goes to a fresh name from mktemp
# (created exclusively), never to a name the folder could already hold. Fails
# when a file could not be copied apart (a full volume) or one is left.
unlink_all() {
  find "$1" -xdev -type f -links +1 -exec sh -c 'for f; do t=$(mktemp "$f.XXXXXX") && cp -p -- "$f" "$t" && mv -f -- "$t" "$f" || { rm -f -- "$t"; exit 1; }; done' sh {} + || return 1
  [ -z "$(find "$1" -xdev -type f -links +1 | head -n 1)" ]
}
op=$1; shift
case "$op" in
move|move-in)
  src=$1; dst=$2
  check_path "$src"; check_path "$dst"
  [ -d "/data/$src" ] || { echo "missing: $src"; exit 4; }
  if [ -e "/data/$dst" ] || [ -L "/data/$dst" ]; then echo "exists: $dst"; exit 5; fi
  par=$(parent_of "$dst")
  if [ -n "$par" ]; then mkdir -p -- "/data/$par" || exit 6; check_path "$par"; fi
  if [ "$op" = move-in ] && [ -n "$(find "/data/$src" -xdev -type f -links +1 2>/dev/null | head -n 1)" ]; then
    echo "hard links"; exit 9
  fi
  mv -n -T -- "/data/$src" "/data/$dst" || { echo "move failed"; exit 6; }
  if [ -L "/data/$dst" ] || [ ! -d "/data/$dst" ] || [ -e "/data/$src" ]; then echo "move did not land"; exit 6; fi
  if [ "$op" = move-in ] && ! unlink_all "/data/$dst"; then
    # A second name made between the check and the move (or no space to
    # copy it apart): the folder goes back rather than run with it.
    if mv -n -T -- "/data/$dst" "/data/$src" && [ ! -e "/data/$dst" ]; then echo "hard links; moved back"; exit 9; fi
    echo "hard links; could not move back"; exit 10
  fi
  echo ok ;;
can-move)
  src=$1; dst=$2
  check_path "$src"; check_path "$dst"
  [ -d "/data/$src" ] || { echo "missing: $src"; exit 4; }
  if [ -e "/data/$dst" ] || [ -L "/data/$dst" ]; then echo "exists: $dst"; exit 5; fi
  echo ok ;;
unlink)
  check_path "$1"
  unlink_all "/data/$1" || { echo "hard links remain"; exit 8; }
  echo ok ;;
state)
  printf '%s %s\n' "$(kind_of "/data/$1")" "$(kind_of "/data/$2")" ;;
stage)
  # Read a tenant's file for an import into dst (in an instance's folder):
  # opened once, checked by where the open descriptor really points, and
  # read from that descriptor — swapping the path afterwards changes nothing.
  src=$1; dst=$2; mode=$3; own=${'$'}{4:-}
  [ -f "/data/$src" ] || { echo "missing"; exit 4; }
  exec 3<"/data/$src" || { echo "missing"; exit 4; }
  r=$(readlink /proc/self/fd/3) || { echo "missing"; exit 4; }
  case "$r" in
    /data/${DATABASE_ROOT}|/data/${DATABASE_ROOT}/*)
      if [ -z "$own" ]; then echo "protected"; exit 3; fi
      case "$r" in "/data/$own"/*) ;; *) echo "protected"; exit 3 ;; esac ;;
    /data/*) ;;
    *) echo "outside"; exit 3 ;;
  esac
  check_path "$(parent_of "$dst")"
  if [ -e "/data/$dst" ] || [ -L "/data/$dst" ]; then echo "exists"; exit 5; fi
  set -C
  case "$mode" in
    copy) cat <&3 > "/data/$dst" ;;
    gunzip) gunzip -c <&3 > "/data/$dst" ;;
    *) echo "bad mode"; exit 7 ;;
  esac || { rm -f -- "/data/$dst"; echo "copy failed"; exit 6; }
  echo ok ;;
sanitize)
  check_path "$1"
  d=/data/$1
  [ -d "$d" ] || { echo "missing"; exit 4; }
  find "$d" -maxdepth 3 -type f \( -name postgresql.conf -o -name postgresql.auto.conf \) \
    -exec sed -i -E '/^[[:space:]]*(${PG_UNSAFE_SETTINGS_RE})([[:space:]]|=)/d' {} + || { echo "sanitize failed"; exit 6; }
  find "$d" -maxdepth 3 -type f -name pg_hba.conf \
    -exec sed -i -E -e '/${PG_HBA_UNSAFE_RE}/d' -e '/${PG_HBA_INCLUDE_RE}/d' {} + || { echo "sanitize failed"; exit 6; }
  find "$d" -maxdepth 2 -type f -name mysqld-auto.cnf -delete || { echo "sanitize failed"; exit 6; }
  echo ok ;;
size)
  # In parallel, each under its own time limit: a folder not measured in
  # time reads as unknown rather than holding up the page.
  for p in "$@"; do
    (
      if [ -d "/data/$p" ] && [ ! -L "/data/$p" ]; then
        k=$(timeout 30 du -sk -- "/data/$p" 2>/dev/null | cut -f1); printf '%s\t%s\n' "${'$'}{k:--}" "$p"
      else printf '%s\t%s\n' - "$p"; fi
    ) &
  done
  wait ;;
list)
  [ -d /data/${DATABASE_ROOT} ] || exit 0
  for a in /data/${DATABASE_ROOT}/* /data/${DATABASE_ROOT}/.[!.]*; do
    [ -e "$a" ] || [ -L "$a" ] || continue
    if [ -d "$a" ] && [ ! -L "$a" ]; then
      for b in "$a"/* "$a"/.[!.]*; do
        [ -e "$b" ] || [ -L "$b" ] || continue
        printf '%s\n' "${'$'}{b#/data/}"
      done
    else printf '%s\n' "${'$'}{a#/data/}"; fi
  done ;;
remove)
  check_path "$1"
  [ -e "/data/$1" ] || exit 0
  rm -rf -- "/data/$1" || exit 6
  echo ok ;;
*) echo "unknown op"; exit 7 ;;
esac
`;

function opsArgv(op: string, ...args: string[]): string[] {
  return ['sh', '-c', FOLDER_OPS_SH, 'folder-ops', op, ...args];
}

export type MoveOutcome =
  | { readonly ok: true }
  /**
   * `links`: the folder holds hard-linked files (a second name elsewhere would
   * still reach a live file) and was not moved, or was moved back. `stranded`:
   * moved, links left, and it could not be moved back — the instance must not
   * start on it.
   */
  | { readonly ok: false; readonly reason: 'symlink' | 'missing' | 'exists' | 'links' | 'stranded' | 'failed'; readonly detail: string };

function moveOutcome(r: ExecResult): MoveOutcome {
  if (r.exitCode === 0) return { ok: true };
  if (r.exitCode === 9) return { ok: false, reason: 'links', detail: 'hard-linked files' };
  if (r.exitCode === 10) return { ok: false, reason: 'stranded', detail: `${r.stdout} ${r.stderr}`.trim().slice(0, 300) };
  const detail = `${r.stdout} ${r.stderr}`.trim().slice(0, 300);
  const reason = r.exitCode === 3 ? 'symlink' : r.exitCode === 4 ? 'missing' : r.exitCode === 5 ? 'exists' : 'failed';
  return { ok: false, reason, detail };
}

/**
 * Renames `src` to `dst`. `intoProtected` breaks the hard links of what was
 * moved (use it for every move into `database/`).
 */
export async function moveFolder(run: PlatformFilesRun, src: string, dst: string, intoProtected: boolean): Promise<MoveOutcome> {
  assertPlatformPath(src);
  assertPlatformPath(dst);
  return moveOutcome(await run(opsArgv(intoProtected ? 'move-in' : 'move', src, dst)));
}

/** Whether `src` could move to `dst` now: the move's own checks, without moving. */
export async function canMoveFolder(run: PlatformFilesRun, src: string, dst: string): Promise<MoveOutcome> {
  assertPlatformPath(src);
  assertPlatformPath(dst);
  return moveOutcome(await run(opsArgv('can-move', src, dst)));
}

/** Copies apart every multiply-linked file under `path`; false when one is left. */
export async function unlinkInPlace(run: PlatformFilesRun, path: string): Promise<boolean> {
  assertPlatformPath(path);
  return (await run(opsArgv('unlink', path))).exitCode === 0;
}

/** Folder sizes in bytes (null: missing, a symlink, or unreadable). */
export async function folderSizes(run: PlatformFilesRun, paths: readonly string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const valid = paths.filter(isPlatformPath);
  for (const p of paths) out.set(p, null);
  if (valid.length === 0) return out;
  const r = await run(opsArgv('size', ...valid));
  for (const line of r.stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const kb = Number(line.slice(0, tab));
    out.set(line.slice(tab + 1), Number.isFinite(kb) ? kb * 1024 : null);
  }
  return out;
}

/** Bytes as the file manager's /folder-size formats them, so both sources read alike. */
export function formatFolderBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

/** Entries two levels under `database/` (`database/<engine>/<name>`), plus anything else at the first level. */
export async function listProtectedEntries(run: PlatformFilesRun): Promise<string[]> {
  const r = await run(opsArgv('list'));
  if (r.exitCode !== 0) throw new Error(`listing ${DATABASE_ROOT}/ failed: ${r.stderr.slice(0, 200)}`);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function removeFolder(run: PlatformFilesRun, path: string): Promise<void> {
  assertPlatformPath(path);
  const r = await run(opsArgv('remove', path));
  if (r.exitCode !== 0) throw new Error(`removing ${path} failed: ${`${r.stdout} ${r.stderr}`.trim().slice(0, 200)}`);
}

export type StageOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: 'missing' | 'protected' | 'exists' | 'failed' };

/**
 * Copies (or gunzips) a tenant's file into `dst`, a path in an instance's
 * folder, for an import. The file must resolve outside the protected folder —
 * or into `ownFolder`, the platform's own dump in that instance's folder. The
 * check and the read use one open descriptor, so a path swapped to a symlink
 * after the check is never read.
 */
export async function stageTenantFile(
  run: PlatformFilesRun, file: string, dst: string, mode: 'copy' | 'gunzip', ownFolder?: string,
): Promise<StageOutcome> {
  const clean = file.replace(/^\/+/, '');
  if (clean === '' || clean.split('/').some((s) => s === '' || s === '.' || s === '..')) return { ok: false, reason: 'missing' };
  assertPlatformPath(dst);
  if (ownFolder !== undefined) assertPlatformPath(ownFolder);
  const r = await run(opsArgv('stage', clean, dst, mode, ...(ownFolder ? [ownFolder] : [])));
  if (r.exitCode === 0) return { ok: true };
  const reason = r.exitCode === 3 ? 'protected' : r.exitCode === 4 ? 'missing' : r.exitCode === 5 ? 'exists' : 'failed';
  return { ok: false, reason };
}

export type FolderKind = 'dir' | 'missing' | 'link' | 'other';

/** What sits at two paths — for finishing a move that landed before its bookkeeping did. */
export async function folderState(run: PlatformFilesRun, a: string, b: string): Promise<readonly [FolderKind, FolderKind]> {
  assertPlatformPath(a);
  assertPlatformPath(b);
  const r = await run(opsArgv('state', a, b));
  const [x, y] = r.stdout.trim().split(/\s+/) as [FolderKind?, FolderKind?];
  return [x ?? 'missing', y ?? 'missing'];
}

/**
 * Before an attached folder's first start: PostgreSQL configuration files lose
 * the settings that run commands, load code or include other files
 * (PG_UNSAFE_FILE_SETTINGS), and MySQL's persisted settings
 * (`mysqld-auto.cnf`) go. The reset init container and the hardening pass do
 * the rest once the server runs.
 */
export async function sanitizeDataFolder(run: PlatformFilesRun, path: string): Promise<void> {
  assertPlatformPath(path);
  const r = await run(opsArgv('sanitize', path));
  if (r.exitCode !== 0) throw new Error(`cleaning ${path} failed (exit ${r.exitCode})`);
}

/** `kept-databases/<name>`, or with a time suffix when that is taken. */
export function keptFolderCandidates(name: string, now: Date = new Date()): string[] {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return [`${KEPT_DATABASES_ROOT}/${name}`, `${KEPT_DATABASES_ROOT}/${name}-${stamp}`, `${KEPT_DATABASES_ROOT}/${name}-${stamp}-2`];
}

/** Moves `src` out of the protected folder to a free `kept-databases/<name>…`. */
export async function moveToKept(run: PlatformFilesRun, src: string, name: string): Promise<{ readonly ok: true; readonly path: string } | (MoveOutcome & { ok: false })> {
  let last: MoveOutcome = { ok: false, reason: 'exists', detail: 'no free name' };
  for (const candidate of keptFolderCandidates(name)) {
    last = await moveFolder(run, src, candidate, false);
    if (last.ok) return { ok: true, path: candidate };
    if (last.reason !== 'exists') return last;
  }
  return last as MoveOutcome & { ok: false };
}
