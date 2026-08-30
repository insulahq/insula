/**
 * `restic stats --json` parsing.
 *
 * This is the only honest source of a tenant's repository size. The columns we
 * already had answer different questions and must never be relabelled as this
 * one — see repo-stats.ts. So the parse needs to be right, and a restic version
 * we do not understand must degrade to 0 rather than NaN: NaN serialises to
 * null over JSON and would render as an empty cell, which reads as "no
 * backups" rather than "we could not measure it".
 */
import { describe, it, expect } from 'vitest';
import { parseResticStats } from './restic-driver.js';

describe('parseResticStats', () => {
  it('parses a raw-data stats payload', () => {
    // Shape emitted by `restic stats --mode raw-data --json`.
    const out = JSON.stringify({
      total_size: 184812405,
      total_file_count: 12043,
      total_blob_count: 9981,
      snapshots_count: 7,
    });
    expect(parseResticStats(out)).toEqual({
      totalSizeBytes: 184812405,
      totalFileCount: 12043,
      snapshotCount: 7,
    });
  });

  it('tolerates surrounding whitespace / trailing newline', () => {
    const out = '\n  {"total_size": 42, "total_file_count": 1, "snapshots_count": 1}  \n';
    expect(parseResticStats(out).totalSizeBytes).toBe(42);
  });

  it('reports 0 rather than NaN for fields a newer restic renamed', () => {
    const out = JSON.stringify({ something_else: 5 });
    const stats = parseResticStats(out);
    expect(stats.totalSizeBytes).toBe(0);
    expect(Number.isFinite(stats.totalSizeBytes)).toBe(true);
    expect(Number.isFinite(stats.totalFileCount)).toBe(true);
    expect(Number.isFinite(stats.snapshotCount)).toBe(true);
  });

  it('never returns NaN for a non-numeric field', () => {
    const out = JSON.stringify({ total_size: 'a lot', total_file_count: null });
    const stats = parseResticStats(out);
    expect(stats.totalSizeBytes).toBe(0);
    expect(stats.totalFileCount).toBe(0);
  });

  it('throws on empty output rather than reporting a 0-byte repo', () => {
    // A silent 0 would look like an empty repository, which is a very
    // different operational statement from "the command produced nothing".
    expect(() => parseResticStats('')).toThrow(/no output/i);
    expect(() => parseResticStats('   ')).toThrow(/no output/i);
  });

  it('throws with a truncated excerpt on unparseable output', () => {
    expect(() => parseResticStats('Fatal: unable to open repo')).toThrow(/unparseable/i);
  });
});
