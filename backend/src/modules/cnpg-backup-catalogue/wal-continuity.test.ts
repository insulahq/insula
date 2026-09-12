/**
 * A missing WAL segment caps recovery. These tests pin the detector that finds
 * out, against the shapes the real archive produces.
 *
 * Ground truth, production 2026-09-12: 5389 segments,
 * 000000010000000D00000057 → 0000000100000022000000063, span 5389, ZERO gaps,
 * one timeline, plus 19 `<seg>.00000028.backup.gz` label files that a naive
 * 24-hex regex counts as duplicate segments.
 */

import { describe, it, expect } from 'vitest';
import {
  parseWalSegment,
  analyseWalContinuity,
  DEFAULT_SEGMENTS_PER_FILE,
  type WalSegmentRef,
} from './wal-continuity.js';

const seg = (name: string, at: string | null = null): WalSegmentRef => {
  const r = parseWalSegment(name, DEFAULT_SEGMENTS_PER_FILE, at);
  if (!r) throw new Error(`fixture is not a WAL segment: ${name}`);
  return r;
};

describe('parseWalSegment', () => {
  it('parses a plain and a compressed segment', () => {
    expect(parseWalSegment('000000010000000D00000057')?.name).toBe('000000010000000D00000057');
    expect(parseWalSegment('wals/000000010000000D/000000010000000D00000057.gz')?.name)
      .toBe('000000010000000D00000057');
  });

  it('numbers segments so that FF rolls over into the next log file', () => {
    // …0000FF and …00010000 are ADJACENT with 16 MB segments. A detector that
    // compared only the low half would call every roll-over a gap.
    const a = seg('000000010000000F000000FF');
    const b = seg('000000010000001000000000');
    expect(b.segNo - a.segNo).toBe(1);
  });

  it('respects a non-default wal_segment_size', () => {
    // 64 MB segments → 64 per log file, so FF is not the roll-over point.
    const a = parseWalSegment('000000010000000F0000003F', 64)!;
    const b = parseWalSegment('000000010000001000000000', 64)!;
    expect(b.segNo - a.segNo).toBe(1);
  });

  it('rejects the non-segment files barman keeps beside the WAL', () => {
    // The production archive holds 19 of these; counting them as segments
    // produced 19 phantom "gaps" of -1 segments on the first pass.
    expect(parseWalSegment('000000010000000D0000005B.00000028.backup.gz')).toBeNull();
    expect(parseWalSegment('00000002.history')).toBeNull();
    expect(parseWalSegment('000000010000000D0000005B.partial')).toBeNull();
    expect(parseWalSegment('')).toBeNull();
  });
});

describe('analyseWalContinuity', () => {
  it('reports an unbroken archive as fully continuous', () => {
    const r = analyseWalContinuity([
      seg('000000010000000100000001', '2026-09-01T00:00:00Z'),
      seg('000000010000000100000002', '2026-09-01T00:05:00Z'),
      seg('000000010000000100000003', '2026-09-01T00:10:00Z'),
    ]);
    expect(r.gaps).toHaveLength(0);
    expect(r.segmentCount).toBe(3);
    expect(r.continuousFromSegment).toBe('000000010000000100000001');
    expect(r.continuousUntil).toBe('2026-09-01T00:10:00Z');
  });

  it('finds a hole and counts exactly what is missing', () => {
    const r = analyseWalContinuity([
      seg('000000010000000100000001'),
      seg('000000010000000100000005'),
    ]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].missingCount).toBe(3);
    expect(r.gaps[0].afterSegment).toBe('000000010000000100000001');
    expect(r.gaps[0].beforeSegment).toBe('000000010000000100000005');
  });

  it('caps the replayable run at the LAST hole, not the first segment', () => {
    // The operator's question is "how far forward can I go", and the answer is
    // bounded by the most recent break, not the oldest.
    const r = analyseWalContinuity([
      seg('000000010000000100000001', '2026-09-01T00:00:00Z'),
      seg('000000010000000100000002', '2026-09-01T00:05:00Z'),
      // hole
      seg('000000010000000100000009', '2026-09-01T01:00:00Z'),
      seg('00000001000000010000000A', '2026-09-01T01:05:00Z'),
    ]);
    expect(r.gaps).toHaveLength(1);
    expect(r.continuousFromSegment).toBe('000000010000000100000009');
    expect(r.continuousSince).toBe('2026-09-01T01:00:00Z');
    expect(r.continuousUntil).toBe('2026-09-01T01:05:00Z');
  });

  it('does not call a roll-over into the next log file a gap', () => {
    const r = analyseWalContinuity([
      seg('000000010000000F000000FE'),
      seg('000000010000000F000000FF'),
      seg('000000010000001000000000'),
      seg('000000010000001000000001'),
    ]);
    expect(r.gaps).toHaveLength(0);
  });

  it('treats a timeline change as a fork, not a hole', () => {
    // After a restore-and-promote the chain continues on a new timeline. Every
    // cluster that has ever been restored would otherwise report a false gap.
    const r = analyseWalContinuity([
      seg('000000010000000100000005'),
      seg('000000020000000100000006'),
      seg('000000020000000100000007'),
    ]);
    expect(r.gaps).toHaveLength(0);
    expect(r.timelines).toEqual([1, 2]);
  });

  it('collapses a segment listed twice rather than reading it as a gap', () => {
    const r = analyseWalContinuity([
      seg('000000010000000100000001', '2026-09-01T00:00:00Z'),
      seg('000000010000000100000001', null),
      seg('000000010000000100000002', '2026-09-01T00:05:00Z'),
    ]);
    expect(r.segmentCount).toBe(2);
    expect(r.gaps).toHaveLength(0);
  });

  it('NEVER claims continuity from a listing that was cut short', () => {
    // The trap: an unfinished walk sees fewer segments, so "no gaps found" is
    // true of a listing that read almost nothing. It must report that it does
    // not know.
    const r = analyseWalContinuity([seg('000000010000000100000001')], { truncated: true });
    expect(r.gaps).toHaveLength(0);
    expect(r.inconclusive).toBe(true);
  });

  it('handles an empty archive without inventing a range', () => {
    const r = analyseWalContinuity([]);
    expect(r.segmentCount).toBe(0);
    expect(r.continuousUntil).toBeNull();
    expect(r.oldestSegment).toBeNull();
  });

  it('reproduces the production archive: 5389 contiguous segments, no gaps', () => {
    const segs: WalSegmentRef[] = [];
    const first = seg('000000010000000D00000057');
    for (let i = 0; i < 5389; i += 1) {
      const n = first.segNo + i;
      const hi = Math.floor(n / DEFAULT_SEGMENTS_PER_FILE).toString(16).toUpperCase().padStart(8, '0');
      const lo = (n % DEFAULT_SEGMENTS_PER_FILE).toString(16).toUpperCase().padStart(8, '0');
      segs.push(seg(`00000001${hi}${lo}`));
    }
    const r = analyseWalContinuity(segs);
    expect(r.segmentCount).toBe(5389);
    expect(r.gaps).toHaveLength(0);
    expect(r.oldestSegment).toBe('000000010000000D00000057');
    expect(r.newestSegment).toBe('000000010000002200000063');
  });
});
