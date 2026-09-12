/**
 * Which points in time this archive can ACTUALLY restore to.
 *
 * WHY THIS EXISTS
 * ---------------
 * Point-in-time recovery replays the write-ahead log forward from a base
 * backup, and the log is a strictly sequential chain: Postgres asks the archive
 * for segment N+1, and if the archive cannot produce it, replay STOPS there.
 * Recovery does not skip a hole and carry on — there is no such thing as
 * replaying "the rest". A single absent segment therefore caps recovery at the
 * last segment before it, and a `recovery_target_time` past that point fails
 * with *"recovery ended before configured recovery target was reached"*.
 *
 * So "we keep 30 days of WAL" does not mean "we can restore to any moment in
 * the last 30 days". It means that only while the chain is unbroken. Reporting
 * the retention window as the recovery window — which the panel did — invites
 * an operator to attempt a restore that cannot succeed, at the worst possible
 * moment.
 *
 * WAL SEGMENT NAMES
 * -----------------
 * 24 hex characters: `TTTTTTTT` timeline, `XXXXXXXX` high half of the segment
 * number, `YYYYYYYY` low half. With the default 16 MB segment size there are
 * 256 segments per high-half value (0x100000000 / 16MiB), so the sequence runs
 * …0000FF → …00010000. That divisor changes with `wal_segment_size`, which is
 * why it is a parameter here rather than a constant: inferring it from the
 * names would mean guessing, and guessing wrong turns a normal roll-over into a
 * phantom gap (or hides a real one).
 *
 * Verified against the production archive 2026-09-12: 5389 segments,
 * 000000010000000D00000057 → 000000010000002200000063, span 5389, zero gaps.
 */

/** Default `wal_segment_size` of 16 MB → 256 segments per high-half value. */
export const DEFAULT_SEGMENTS_PER_FILE = 256;

export interface WalSegmentRef {
  /** The 24-hex segment name, without any compression suffix. */
  readonly name: string;
  readonly timeline: number;
  /** Absolute segment number within the timeline. */
  readonly segNo: number;
  /** Upload time, when the listing carried one. */
  readonly at: string | null;
}

export interface WalGap {
  /** Last segment present before the hole. */
  readonly afterSegment: string;
  /** First segment present after the hole. */
  readonly beforeSegment: string;
  /** How many segments are absent between them. */
  readonly missingCount: number;
  readonly timeline: number;
}

/**
 * Parse a WAL object key into a segment reference.
 *
 * Returns null for everything that is not a WAL segment — barman also stores
 * backup labels (`<seg>.<offset>.backup[.gz]`), timeline histories
 * (`<8hex>.history`) and partial segments (`.partial`). Counting a
 * `.backup` label as its own segment produces phantom duplicates, which is
 * exactly what a first pass over the production archive did.
 */
export function parseWalSegment(
  key: string,
  segmentsPerFile: number = DEFAULT_SEGMENTS_PER_FILE,
  at: string | null = null,
): WalSegmentRef | null {
  const base = key.split('/').pop() ?? key;
  const m = /^([0-9A-F]{24})(?:\.(?:gz|lz4|zst|bz2|snappy|xz))?$/.exec(base);
  if (!m) return null;
  const name = m[1];
  const timeline = parseInt(name.slice(0, 8), 16);
  const hi = parseInt(name.slice(8, 16), 16);
  const lo = parseInt(name.slice(16, 24), 16);
  if (!Number.isFinite(timeline) || !Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return { name, timeline, segNo: hi * segmentsPerFile + lo, at };
}

export interface ContinuityReport {
  readonly segmentCount: number;
  readonly timelines: readonly number[];
  readonly gaps: readonly WalGap[];
  /** Oldest / newest segment present, by segment number. */
  readonly oldestSegment: string | null;
  readonly newestSegment: string | null;
  /**
   * Upload time of the newest segment in the UNBROKEN run that reaches the
   * newest segment. Recovery cannot pass beyond this point, whatever the
   * retention setting says.
   */
  readonly continuousSince: string | null;
  readonly continuousUntil: string | null;
  /** First segment of that unbroken run — where the usable chain starts. */
  readonly continuousFromSegment: string | null;
  /**
   * True when the listing that produced these segments was cut short. Gap
   * findings are then UNRELIABLE IN BOTH DIRECTIONS: absent segments may simply
   * not have been read, so "no gaps" must never be claimed from a partial walk.
   */
  readonly inconclusive: boolean;
}

/**
 * Find holes in the chain and the span that is actually replayable.
 *
 * Gaps are computed WITHIN a timeline. A timeline change is a fork, not a hole:
 * after a restore-and-promote the new timeline continues from the fork point
 * and the `.history` file records where. Treating that boundary as a gap would
 * cry wolf on every cluster that has ever been restored. The report lists the
 * timelines it saw so a caller can say so.
 */
export function analyseWalContinuity(
  segments: readonly WalSegmentRef[],
  opts: { readonly truncated?: boolean } = {},
): ContinuityReport {
  const truncated = opts.truncated ?? false;

  // Deduplicate: the same segment can appear under two keys (compressed and
  // not) and would otherwise read as a zero-length gap.
  const byKey = new Map<string, WalSegmentRef>();
  for (const s of segments) {
    const k = `${s.timeline}/${s.segNo}`;
    const prev = byKey.get(k);
    if (!prev || (prev.at === null && s.at !== null)) byKey.set(k, s);
  }
  const sorted = [...byKey.values()].sort(
    (a, b) => (a.timeline - b.timeline) || (a.segNo - b.segNo),
  );

  if (sorted.length === 0) {
    return {
      segmentCount: 0, timelines: [], gaps: [],
      oldestSegment: null, newestSegment: null,
      continuousSince: null, continuousUntil: null, continuousFromSegment: null,
      inconclusive: truncated,
    };
  }

  const gaps: WalGap[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.timeline !== cur.timeline) continue; // fork, not a hole
    const missing = cur.segNo - prev.segNo - 1;
    if (missing > 0) {
      gaps.push({
        afterSegment: prev.name,
        beforeSegment: cur.name,
        missingCount: missing,
        timeline: cur.timeline,
      });
    }
  }

  // Walk back from the newest segment to the start of its unbroken run — that
  // run is what a restore can actually replay through.
  let runStart = sorted.length - 1;
  for (let i = sorted.length - 1; i > 0; i -= 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.timeline !== cur.timeline || cur.segNo !== prev.segNo + 1) break;
    runStart = i - 1;
  }

  const timesInRun = sorted.slice(runStart).map((s) => s.at).filter((t): t is string => t !== null);

  return {
    segmentCount: sorted.length,
    timelines: [...new Set(sorted.map((s) => s.timeline))].sort((a, b) => a - b),
    gaps,
    oldestSegment: sorted[0].name,
    newestSegment: sorted[sorted.length - 1].name,
    continuousFromSegment: sorted[runStart].name,
    continuousSince: timesInRun.length > 0 ? timesInRun[0] : null,
    continuousUntil: timesInRun.length > 0 ? timesInRun[timesInRun.length - 1] : null,
    inconclusive: truncated,
  };
}
