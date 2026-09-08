import { describe, it, expect } from 'vitest';
import { parseImapsyncProgress, parseImapsyncSummary } from './progress-parser.js';

describe('parseImapsyncProgress', () => {
  it('returns null fields for empty input', () => {
    expect(parseImapsyncProgress('')).toEqual({
      messagesTotal: null,
      messagesTransferred: null,
      currentFolder: null,
    });
  });

  it('returns null fields when no patterns match', () => {
    expect(parseImapsyncProgress('Connecting to server\nNothing to do here\n')).toEqual({
      messagesTotal: null,
      messagesTransferred: null,
      currentFolder: null,
    });
  });

  it('parses the latest "Copying msg N/M" line', () => {
    const log = `
Connecting to server
+ Copying msg 1/200 [INBOX]
+ Copying msg 2/200 [INBOX]
+ Copying msg 100/200 [INBOX]
`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(100);
    expect(result.messagesTotal).toBe(200);
  });

  it('parses bracket-style "Copying msg N/M [...] folder" lines', () => {
    const log = `+ Copying msg 42/100 [42/100] {INBOX/Subfolder}`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(42);
    expect(result.messagesTotal).toBe(100);
  });

  it('parses the most recent "From Folder [name]" line', () => {
    const log = `
From Folder [INBOX]                Size:  1234 Messages:  200
From Folder [INBOX/Sent]           Size:  5678 Messages:  50
+ Copying msg 5/250 [INBOX/Sent]
`;
    const result = parseImapsyncProgress(log);
    expect(result.currentFolder).toBe('INBOX/Sent');
  });

  it('handles partial information gracefully — only messages, no folder', () => {
    const log = `+ Copying msg 10/50`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(10);
    expect(result.messagesTotal).toBe(50);
    expect(result.currentFolder).toBeNull();
  });

  it('handles partial information gracefully — only folder, no messages', () => {
    const log = `From Folder [INBOX/Drafts]`;
    const result = parseImapsyncProgress(log);
    expect(result.currentFolder).toBe('INBOX/Drafts');
    expect(result.messagesTransferred).toBeNull();
    expect(result.messagesTotal).toBeNull();
  });

  it('uses the LAST "Copying msg" line when multiple are present', () => {
    const log = `
+ Copying msg 1/1000
+ Copying msg 100/1000
+ Copying msg 999/1000
`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(999);
    expect(result.messagesTotal).toBe(1000);
  });

  it('handles whitespace and varying number widths', () => {
    const log = `   +   Copying msg     7 /    42  [INBOX]`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(7);
    expect(result.messagesTotal).toBe(42);
  });

  it('ignores lines that look similar but are not progress markers', () => {
    const log = `
Total: 123/456 messages OK
Folder INBOX has 100/200 unread
`;
    const result = parseImapsyncProgress(log);
    // Neither line matches "Copying msg N/M" so should be null.
    expect(result.messagesTransferred).toBeNull();
    expect(result.messagesTotal).toBeNull();
  });

  // Round-4 Phase 3 review HIGH-2: documents the known limitation
  // that bracket-style folder names with a colon-and-digit pattern
  // are filtered as dates.
  it('KNOWN LIMITATION: bracket-style folder name with colon is misidentified as a date', () => {
    const log = `+ Copying msg 1/10 [INBOX/Daily-09:00]`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(1);
    expect(result.messagesTotal).toBe(10);
    // The colon in '09:00' triggers the date heuristic. The
    // brace-style pattern (which imapsync 2.x always emits) is
    // not affected — see the next test.
    expect(result.currentFolder).toBeNull();
  });

  it('brace-style folder names with a colon are NOT filtered (preferred path)', () => {
    const log = `+ Copying msg 5/10 [Sun Jan 14 12:00:00 2024] {INBOX/Daily-09:00}`;
    const result = parseImapsyncProgress(log);
    expect(result.currentFolder).toBe('INBOX/Daily-09:00');
  });

  it('parses real-world imapsync output sample', () => {
    const log = `
Host1: imap.gmail.com port 993
Host2: stalwart-mail.mail.svc.cluster.local port 143
Banner host1: * OK Gimap ready for requests
Folders to migrate: 5
From Folder [INBOX]                Size:    8388608 Messages:    1500
From Folder [Sent]                 Size:    1048576 Messages:    250
From Folder [Drafts]               Size:      32768 Messages:     12
From Folder [Trash]                Size:     524288 Messages:     45
From Folder [Spam]                 Size:     262144 Messages:    123
+ Copying msg    1/1500 [Sun Jan 14 12:00:00 2024] {INBOX}
+ Copying msg    2/1500 [Sun Jan 14 12:00:01 2024] {INBOX}
+ Copying msg  100/1500 [Sun Jan 14 12:00:30 2024] {INBOX}
+ Copying msg  500/1500 [Sun Jan 14 12:02:30 2024] {INBOX}
+ Copying msg  750/1500 [Sun Jan 14 12:04:00 2024] {INBOX}
`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(750);
    expect(result.messagesTotal).toBe(1500);
    // The "Spam" line is the LAST "From Folder" so progress-parser
    // would surface it; but the latest copy line says INBOX. The
    // current folder should reflect what imapsync is actively
    // copying — we treat the {brace} folder marker on the copy line
    // as authoritative when present.
    expect(result.currentFolder).toBe('INBOX');
  });
});

// ─── Final summary ────────────────────────────────────────────────────────
//
// Fixture is VERBATIM from a real imapsync 2.319 run against Stalwart 0.16
// on the DinD stack, 2026-09-02 — including imapsync's trailing spaces after
// some values, which a hand-written fixture would have quietly omitted.
const REAL_STATS = `Host1: folder [spam] selected 1 messages, duplicates 0
++++ Statistics
Transfer started on                     : Wednesday 02 September 2026-09-02 13:01:55 +0000 UTC
Transfer ended on                       : Wednesday 02 September 2026-09-02 13:01:55 +0000 UTC
Transfer time                           : 0.2 sec
Folders synced                          : 9/9 synced
Folders deleted on host2                : 0 
Messages transferred                    : 4 
Messages skipped                        : 0
Total bytes transferred                 : 352 (0.344 KiB)
Detected 0 errors
Exiting with return value 0 (EX_OK: successful termination) 0/50 nb_errors/max_errors PID 1`;

describe('parseImapsyncSummary', () => {
  it('parses a real 2.319 Statistics block', () => {
    const s = parseImapsyncSummary(REAL_STATS);
    expect(s.messagesTransferred).toBe(4);
    expect(s.messagesSkipped).toBe(0);
    expect(s.foldersSynced).toBe(9);
    expect(s.foldersTotal).toBe(9);
    expect(s.bytesTransferred).toBe(352);
    expect(s.errors).toBe(0);
    expect(s.line).toBe('Transferred 4 messages across 9 folders (352 B) in <1s');
  });

  it('returns nulls when there is no Statistics block', () => {
    expect(parseImapsyncSummary('some unrelated output').line).toBeNull();
    expect(parseImapsyncSummary(null).line).toBeNull();
    expect(parseImapsyncSummary('').line).toBeNull();
  });

  it('surfaces skipped messages — a "success" that moved nothing must say so', () => {
    const log = REAL_STATS
      .replace('Messages transferred                    : 4 ', 'Messages transferred                    : 0 ')
      .replace('Messages skipped                        : 0', 'Messages skipped                        : 4');
    const s = parseImapsyncSummary(log);
    expect(s.messagesSkipped).toBe(4);
    expect(s.line).toContain('4 messages skipped');
  });

  it('surfaces a non-zero error count', () => {
    const s = parseImapsyncSummary(REAL_STATS.replace('Detected 0 errors', 'Detected 3 errors'));
    expect(s.errors).toBe(3);
    expect(s.line).toContain('3 errors');
  });

  it('formats large runs readably', () => {
    const log = REAL_STATS
      .replace('Transfer time                           : 0.2 sec', 'Transfer time                           : 4512.7 sec')
      .replace('Messages transferred                    : 4 ', 'Messages transferred                    : 18342 ')
      .replace('Total bytes transferred                 : 352 (0.344 KiB)', 'Total bytes transferred                 : 2411724800 (2.246 GiB)');
    expect(parseImapsyncSummary(log).line)
      .toBe('Transferred 18,342 messages across 9 folders (2.2 GiB) in 1h 15m');
  });

  it('does not say "1 messages" or "1 folders"', () => {
    const log = REAL_STATS
      .replace('Messages transferred                    : 4 ', 'Messages transferred                    : 1 ')
      .replace('Folders synced                          : 9/9 synced', 'Folders synced                          : 1/1 synced');
    const line = parseImapsyncSummary(log).line ?? '';
    expect(line).toContain('1 message ');
    expect(line).toContain('1 folder ');
    expect(line).not.toContain('1 messages');
    expect(line).not.toContain('1 folders');
  });
});

// ─── Real imapsync output (the format the shipped image actually emits) ──
//
// Captured from a REAL 120-message transfer on the DEV cluster
// (2026-09-08, job status succeeded, 5 folders). The image emits NO
// `+ Copying msg N/M` line at all — every pattern above was written
// against a format this build never produces, so messages_total stayed
// NULL for the whole run and the tenant-panel progress bar, which
// requires it, could never render.
//
// The real markers are a decreasing "N/M msgs left" counter (present on
// both the per-message line and the standalone ETA line) and a
// `Folder N/M [name] -> [name]` header.
describe('parseImapsyncProgress — real imapsync "msgs left" output', () => {
  const REAL_LOG = `++++ Looping on each one of 5 folders to sync
ETA: Tuesday 08 September 2026 14:44:22 +0000 UTC  0 s  120/120 msgs left
Folder     1/5 [Deleted Items]                     -> [Deleted Items]
Folder     3/5 [INBOX]                             -> [INBOX]
msg INBOX/1 {606}             copied to INBOX/1          9.53 msgs/s  5.638 KiB/s 0.592 KiB copied ETA: Tuesday 08 September 2026 14:44:35 +0000 UTC  13 s  119/120 msgs left
msg INBOX/2 {606}             copied to INBOX/2          17.31 msgs/s  10.241 KiB/s 1.184 KiB copied ETA: Tuesday 08 September 2026 14:44:29 +0000 UTC  7 s  118/120 msgs left
msg INBOX/12 {606}            copied to INBOX/12         58.19 msgs/s  34.434 KiB/s 7.102 KiB copied ETA: Tuesday 08 September 2026 14:44:24 +0000 UTC  2 s  108/120 msgs left
`;

  it('derives transferred and total from the "msgs left" counter', () => {
    const result = parseImapsyncProgress(REAL_LOG);
    // 108 of 120 still to go => 12 done.
    expect(result.messagesTotal).toBe(120);
    expect(result.messagesTransferred).toBe(12);
  });

  it('reports the folder currently being copied', () => {
    expect(parseImapsyncProgress(REAL_LOG).currentFolder).toBe('INBOX');
  });

  it('reports 0 transferred before the first message moves', () => {
    const log = `++++ Looping on each one of 5 folders to sync
ETA: Tuesday 08 September 2026 14:44:22 +0000 UTC  0 s  120/120 msgs left
Folder     1/5 [Deleted Items]                     -> [Deleted Items]
`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTotal).toBe(120);
    expect(result.messagesTransferred).toBe(0);
    expect(result.currentFolder).toBe('Deleted Items');
  });

  it('does not mistake the folder counter for the message counter', () => {
    // `Folder 3/5` and `Host1 folder 3/5 [...] Messages: 120` must not be
    // read as progress — only the "msgs left" counter is progress.
    const log = `Host1 folder     3/5 [INBOX]                             Size:       72720 Messages:    120 Biggest:       606
Folder     3/5 [INBOX]                             -> [INBOX]
`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTotal).toBeNull();
    expect(result.messagesTransferred).toBeNull();
    expect(result.currentFolder).toBe('INBOX');
  });

  it('still prefers the "Copying msg" format when a log has both', () => {
    const log = `+ Copying msg 50/200 {INBOX}
ETA: Tuesday 08 September 2026 14:44:22 +0000 UTC  0 s  120/120 msgs left
`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(50);
    expect(result.messagesTotal).toBe(200);
  });
});
