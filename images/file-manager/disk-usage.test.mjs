// `df` output parsing for the tenant quota display — run via `node --test`.
//
// busybox df wraps a long device name onto its own line and indents the numbers
// on the next one. EVERY Longhorn PVC path (`/dev/longhorn/pvc-<uuid>`) is long
// enough to trigger it, so the previous "second line, second field" parse read
// the device-name line, produced NaN, and reported 0 B total / 0 B available for
// every tenant — while `du` still reported real usage, so the panel drew a quota
// bar of "70 MB used of 0 B".
//
// The fixtures below are verbatim output from a live cluster and from a
// non-wrapping filesystem, so a regression in either layout fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FM_BASE = mkdtempSync(join(tmpdir(), 'fm-df-'));
process.env.FM_NO_LISTEN = '1';
const { parseDf } = await import('./server.mjs');

test('parses WRAPPED busybox output (Longhorn PVC — the production case)', () => {
  // Captured from a live tenant pod: `df -B1 /data`.
  const out = [
    'Filesystem           1-blocks       Used Available Use% Mounted on',
    '/dev/longhorn/pvc-00dd3bb7-3afb-4bc5-bf52-6f460be2af7a',
    '                     2080374784  73768960 2006605824   4% /data',
  ].join('\n');
  assert.deepEqual(parseDf(out), { totalBytes: 2080374784, availableBytes: 2006605824 });
});

test('parses UNWRAPPED output (short device name)', () => {
  const out = [
    'Filesystem     1B-blocks      Used Available Use% Mounted on',
    '/dev/sda1     10737418240 1073741824 9663676416  10% /data',
  ].join('\n');
  assert.deepEqual(parseDf(out), { totalBytes: 10737418240, availableBytes: 9663676416 });
});

test('parses a mount point containing no spaces after a wrap', () => {
  const out = [
    'Filesystem           1-blocks       Used Available Use% Mounted on',
    '/dev/mapper/a-very-long-device-mapper-name-that-wraps',
    '                       1048576    524288    524288  50% /data',
  ].join('\n');
  assert.deepEqual(parseDf(out), { totalBytes: 1048576, availableBytes: 524288 });
});

test('reports zeroes rather than NaN on unusable output', () => {
  assert.deepEqual(parseDf(''), { totalBytes: 0, availableBytes: 0 });
  assert.deepEqual(parseDf('Filesystem 1-blocks Used Available Use% Mounted on'),
    { totalBytes: 0, availableBytes: 0 });
});

test('never returns NaN (which JSON-serialises to null and breaks the UI)', () => {
  for (const out of ['', 'garbage', 'a\nb', 'Filesystem\n/dev/x\n   1 2 3 4% /d']) {
    const { totalBytes, availableBytes } = parseDf(out);
    assert.equal(Number.isFinite(totalBytes), true, `totalBytes for ${JSON.stringify(out)}`);
    assert.equal(Number.isFinite(availableBytes), true, `availableBytes for ${JSON.stringify(out)}`);
  }
});
