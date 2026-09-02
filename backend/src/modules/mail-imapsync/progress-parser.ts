/**
 * Round-4 Phase 3: pure parser for imapsync stdout.
 *
 * Extracts the latest progress markers (message count, total, and
 * current folder) from a batched log tail. Returns null fields
 * when no patterns match — callers should NOT overwrite existing
 * progress columns with null, but only update fields that have a
 * non-null result.
 *
 * The parser is intentionally lenient because imapsync's output
 * format varies between versions and operators sometimes pipe it
 * through their own log wrappers. We prefer "match what we can,
 * skip what we can't" over "fail loudly when format changes".
 *
 * Pattern reference (from real imapsync 2.x output):
 *
 *   + Copying msg    750/1500 [Sun Jan 14 12:04:00 2024] {INBOX}
 *   + Copying msg 100/200 [INBOX]
 *
 *   From Folder [INBOX]                Size:    8388608 Messages:    1500
 *
 * Folder priority: braces on a "Copying msg" line take precedence
 * (it's what imapsync is *actively* copying right now), then the
 * bracket on the same line, then the most recent "From Folder
 * [name]" line.
 */

export interface ImapsyncProgress {
  readonly messagesTotal: number | null;
  readonly messagesTransferred: number | null;
  readonly currentFolder: string | null;
}

const COPY_LINE_REGEX = /\+\s*Copying\s+msg\s*(\d+)\s*\/\s*(\d+)/g;
const COPY_FOLDER_BRACE_REGEX = /\+\s*Copying\s+msg\s*\d+\s*\/\s*\d+.*?\{([^}]+)\}/g;
const COPY_FOLDER_BRACKET_REGEX = /\+\s*Copying\s+msg\s*\d+\s*\/\s*\d+\s*\[([^\]]+)\](?!\s*\[)/g;
const FROM_FOLDER_REGEX = /^From\s+Folder\s+\[([^\]]+)\]/gm;

function lastMatch(re: RegExp, input: string): RegExpExecArray | null {
  // RegExps must have the global flag for matchAll to work.
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    last = m;
  }
  return last;
}

function parseFolderFromCopyLine(input: string): string | null {
  // Prefer brace-style {INBOX}, then bracket-style [INBOX] if it
  // doesn't look like a date. We only consider the LATEST match.
  const lastBrace = lastMatch(new RegExp(COPY_FOLDER_BRACE_REGEX.source, 'g'), input);
  if (lastBrace) return lastBrace[1].trim();

  const lastBracket = lastMatch(new RegExp(COPY_FOLDER_BRACKET_REGEX.source, 'g'), input);
  if (lastBracket) {
    const candidate = lastBracket[1].trim();
    // Heuristic: skip ISO/date-like strings (contain a digit + colon)
    // since the timestamp bracket pattern is `[Sun Jan 14 12:04:00 2024]`.
    //
    // KNOWN LIMITATION (review HIGH-2): folder names that contain a
    // colon-and-digit pattern like `INBOX/Daily-09:00` will be
    // incorrectly filtered as dates. The brace-style pattern
    // `{INBOX/Daily-09:00}` works correctly, so imapsync 2.x output
    // is unaffected (it always emits the brace marker on Copying
    // lines). The bracket-style fallback is only hit when the log
    // is from an older imapsync version or a custom wrapper.
    if (!/\b\d{1,2}:\d{2}/.test(candidate)) return candidate;
  }
  return null;
}

export function parseImapsyncProgress(log: string): ImapsyncProgress {
  if (!log) {
    return { messagesTotal: null, messagesTransferred: null, currentFolder: null };
  }

  // Latest "+ Copying msg N/M" line
  const lastCopy = lastMatch(new RegExp(COPY_LINE_REGEX.source, 'g'), log);
  const messagesTransferred = lastCopy ? parseInt(lastCopy[1], 10) : null;
  const messagesTotal = lastCopy ? parseInt(lastCopy[2], 10) : null;

  // Folder: try to extract from the latest copy line first
  let currentFolder: string | null = parseFolderFromCopyLine(log);

  // Fallback to the most recent "From Folder [name]" header line
  if (!currentFolder) {
    const lastFrom = lastMatch(new RegExp(FROM_FOLDER_REGEX.source, 'gm'), log);
    if (lastFrom) currentFolder = lastFrom[1].trim();
  }

  return {
    messagesTotal,
    messagesTransferred,
    currentFolder,
  };
}

// ─── Final summary (terminal jobs) ───────────────────────────────────────
//
// Everything above parses PROGRESS from `+ Copying msg N/M` lines, which only
// exist while messages are moving. On completion those numbers are whatever
// the last copy line happened to say — they are not the run's result, and a
// run that transferred nothing emits no copy line at all, so a finished job
// showed the operator no outcome whatsoever.
//
// imapsync ends every run with a `++++ Statistics` block. That block is the
// authoritative result and is what this reads. Sample from a real 2.319 run
// (DinD, 2026-09-02):
//
//   ++++ Statistics
//   Transfer time                           : 0.2 sec
//   Folders synced                          : 9/9 synced
//   Messages transferred                    : 4
//   Messages skipped                        : 0
//   Total bytes transferred                 : 352 (0.344 KiB)
//   Detected 0 errors
//   Exiting with return value 0 (EX_OK: successful termination)
//
// The block sits at the END of the output, so a log TAIL contains it even
// when the head has been dropped.

export interface ImapsyncSummary {
  readonly messagesTransferred: number | null;
  readonly messagesSkipped: number | null;
  readonly foldersSynced: number | null;
  readonly foldersTotal: number | null;
  readonly bytesTransferred: number | null;
  readonly transferTimeSeconds: number | null;
  readonly errors: number | null;
  /** One line, ready to render. Null when no Statistics block is present. */
  readonly line: string | null;
}

const EMPTY_SUMMARY: ImapsyncSummary = {
  messagesTransferred: null, messagesSkipped: null, foldersSynced: null,
  foldersTotal: null, bytesTransferred: null, transferTimeSeconds: null,
  errors: null, line: null,
};

/** `Label : value` — imapsync pads labels with spaces to a fixed column. */
function statValue(log: string, label: string): string | null {
  const re = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.+)$`, 'm');
  const m = re.exec(log);
  return m ? m[1].trim() : null;
}

function firstInt(raw: string | null): number | null {
  if (raw === null) return null;
  const m = /-?\d+/.exec(raw.replace(/,/g, ''));
  return m ? Number(m[0]) : null;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function humanDuration(sec: number): string {
  if (sec < 1) return '<1s';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/** Pluralise without the "1 messages" wart. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/**
 * Parse the final Statistics block and render a one-line result.
 *
 * Deliberately reports skipped messages: imapsync silently skips messages it
 * cannot identify (no Message-ID / Date — "void (noheader)"), and a run that
 * reports success while quietly skipping half the mailbox is exactly the kind
 * of outcome an operator must not have to dig through logs to discover.
 */
export function parseImapsyncSummary(logTail: string | null | undefined): ImapsyncSummary {
  if (!logTail || !/\+\+\+\+ Statistics/.test(logTail)) return EMPTY_SUMMARY;

  const transferred = firstInt(statValue(logTail, 'Messages transferred'));
  const skipped = firstInt(statValue(logTail, 'Messages skipped'));
  const bytes = firstInt(statValue(logTail, 'Total bytes transferred'));
  const timeSec = ((): number | null => {
    const raw = statValue(logTail, 'Transfer time');
    if (raw === null) return null;
    const m = /([\d.]+)/.exec(raw);
    return m ? Number(m[1]) : null;
  })();

  // "9/9 synced"
  let foldersSynced: number | null = null;
  let foldersTotal: number | null = null;
  const foldersRaw = statValue(logTail, 'Folders synced');
  if (foldersRaw) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(foldersRaw);
    if (m) { foldersSynced = Number(m[1]); foldersTotal = Number(m[2]); }
    else foldersSynced = firstInt(foldersRaw);
  }

  const errM = /Detected\s+(\d+)\s+errors?/.exec(logTail);
  const errors = errM ? Number(errM[1]) : null;

  const parts: string[] = [];
  parts.push(transferred === null ? 'Finished' : `Transferred ${count(transferred, 'message')}`);
  if (foldersSynced !== null) parts.push(`across ${count(foldersSynced, 'folder')}`);
  if (bytes !== null && bytes > 0) parts.push(`(${humanBytes(bytes)})`);
  if (timeSec !== null) parts.push(`in ${humanDuration(timeSec)}`);

  let line = parts.join(' ');
  const trailer: string[] = [];
  if (skipped) trailer.push(`${count(skipped, 'message')} skipped`);
  if (errors) trailer.push(`${count(errors, 'error')}`);
  if (trailer.length > 0) line += ` — ${trailer.join(', ')}`;

  return {
    messagesTransferred: transferred,
    messagesSkipped: skipped,
    foldersSynced,
    foldersTotal,
    bytesTransferred: bytes,
    transferTimeSeconds: timeSec,
    errors,
    line,
  };
}
