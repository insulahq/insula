/**
 * The mailbox restore's operator-facing counts.
 *
 * Regression guard: the executor read its summary through `tailJobLog`, which
 * fetches N lines and returns only the LAST one. The script's final line is
 * `MAILBOXES_RESTORED total=N`, which is not JSON, so every restore reported
 * `imported=0` however much it restored — and a non-zero `failed` was never
 * surfaced. Caught by restoring a real mailbox on DEV: 110 messages landed and
 * the cart said `imported=0`.
 *
 * The fixture below is the verbatim tail of that DEV restore Job.
 */
import { describe, it, expect } from 'vitest';
import { parseMailboxRestoreSummary } from './mailboxes-by-address.js';

const REAL_JOB_LOG = [
  'Restoring carol@example.test from snapshot 1b64ca947a3ffd8922ed4f2e85ac574bfd176f187c0652541ba2ee2317229073...',
  'restoring snapshot 1b64ca94 of [/capture/carol@example.test] at 2026-09-22 20:25:39 +0000 UTC by root@t to /tmp/restic-out',
  'Summary: Restored 141 files/dirs (9.635 MiB) in 0:00',
  'Restoring carol@example.test via IMAP (mode=merge-skip-duplicates workers=16)...',
  'imap-restore: source=carol@example.test target=carol@example.test entries=115 mode=merge-skip-duplicates',
  "imap-restore: created folder 'ADR061-E2E'",
  "imap-restore: dedup: 'ADR061-E2E' has 0 existing message-ids on target",
  "imap-restore: folder='ADR061-E2E' workers=4 imported=110 skipped_dedup=0 skipped_oversize=0 failed=0",
  '{"address": "carol@example.test", "imported": 110, "skipped": 0, "skippedDedup": 0, "skippedOversize": 0, "failed": 0, "mailboxesCreated": ["ADR061-E2E"], "elapsedSeconds": 1.9, "engine": "imap"}',
  '{"kind":"aux","address":"carol@example.test","elapsed_s":0.018,"mode":"merge-skip-duplicates","outcome":{"sieve":{"input":0}}}',
  'AUX_RESTORED addr=carol@example.test mode=merge-skip-duplicates',
  'MAILBOX_RESTORED addr=carol@example.test mode=merge-skip-duplicates',
  'MAILBOXES_RESTORED total=1',
].join('\n');

describe('parseMailboxRestoreSummary', () => {
  it('reports what the Job actually imported', () => {
    const s = parseMailboxRestoreSummary(REAL_JOB_LOG);
    expect(s.imported).toBe(110);
    expect(s.failed).toBe(0);
    expect(s.mailboxesCreated).toBe(1);
    expect(s.elapsedMs).toBe(1900);
  });

  it('is not fooled by the aux summary, which carries no `imported`', () => {
    const auxOnly = '{"kind":"aux","address":"a@example.test","outcome":{}}';
    expect(parseMailboxRestoreSummary(auxOnly).imported).toBe(0);
  });

  it('sums across several mailboxes and surfaces failures', () => {
    const log = [
      '{"address": "a@example.test", "imported": 10, "skipped": 1, "failed": 2, "mailboxesCreated": ["INBOX"], "elapsedSeconds": 1}',
      '{"address": "b@example.test", "imported": 5, "skipped": 0, "failed": 0, "mailboxesCreated": [], "elapsedSeconds": 3}',
      'MAILBOXES_RESTORED total=2',
    ].join('\n');
    const s = parseMailboxRestoreSummary(log);
    expect(s.imported).toBe(15);
    expect(s.failed).toBe(2);
    expect(s.skippedTotal).toBe(1);
    // Longest mailbox, not the sum — this is wall-clock, not work.
    expect(s.elapsedMs).toBe(3000);
  });

  it('returns zeroes for a log that carries only the final marker', () => {
    // This is exactly what tailJobLog handed the executor, and why every
    // restore read as "imported=0".
    expect(parseMailboxRestoreSummary('MAILBOXES_RESTORED total=1').imported).toBe(0);
  });
});
