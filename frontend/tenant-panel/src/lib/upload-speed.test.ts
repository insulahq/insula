import { describe, it, expect } from 'vitest';
import {
  addSpeedSample, currentSpeed, averageSpeed, percentOf, summarizeUploads,
  formatBytes, formatSpeed, formatDuration, liveSpeedLabel,
  SPEED_WINDOW_MS, type SpeedSample, type UploadTally,
} from './upload-speed';

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const TB = 1024 * GB;

/** Samples every `stepMs` from `from` to `to`, at `bytesPerSec`, on top of `base`. */
function feed(
  samples: readonly SpeedSample[], from: number, to: number, stepMs: number, bytesPerSec: number, base: number,
): readonly SpeedSample[] {
  let out = samples;
  for (let at = from; at <= to; at += stepMs) {
    out = addSpeedSample(out, { at, loaded: base + ((at - from) / 1000) * bytesPerSec });
  }
  return out;
}

describe('formatBytes', () => {
  it('uses the same 1024-based units as the file listing', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(KB)).toBe('1.0 KB');
    expect(formatBytes(1.5 * KB)).toBe('1.5 KB');
    expect(formatBytes(5 * MB)).toBe('5.0 MB');
    expect(formatBytes(2.5 * GB)).toBe('2.5 GB');
  });
  it('keeps going past GB instead of running off the unit table', () => {
    expect(formatBytes(3 * TB)).toBe('3.0 TB');
    expect(formatBytes(Number.MAX_SAFE_INTEGER)).toBe('8.0 PB');
    // Beyond the largest unit the number grows rather than the label vanishing.
    expect(formatBytes(1e21)).toBe('888178.4 PB');
  });
  it('renders a sub-byte value as zero bytes, not a negative unit index', () => {
    expect(formatBytes(0.4)).toBe('0 B');
  });
  it('renders nonsense as a dash rather than a number', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatSpeed', () => {
  it('is a byte size per second', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
    expect(formatSpeed(850 * KB)).toBe('850.0 KB/s');
    expect(formatSpeed(1.5 * MB)).toBe('1.5 MB/s');
    expect(formatSpeed(Number.NaN)).toBe('—');
  });
  it('moves up a unit at 1000 so a speed near a boundary does not flip between KB/s and MB/s', () => {
    // Seen in a real browser at a 1 MiB/s throttle: readings alternated
    // between "1022.6 KB/s" and "1.0 MB/s".
    expect(formatSpeed(1022.6 * KB)).toBe('1.0 MB/s');
    expect(formatSpeed(999 * KB)).toBe('999.0 KB/s');
    expect(formatSpeed(1000)).toBe('1.0 KB/s');
    expect(formatSpeed(999)).toBe('999 B/s');
  });
  it('leaves sizes on the listing convention even near a boundary', () => {
    expect(formatBytes(1022.6 * KB)).toBe('1022.6 KB');
  });
});

describe('liveSpeedLabel', () => {
  it('shows the live speed while bytes remain', () => {
    expect(liveSpeedLabel(MB, 4 * MB, 2 * MB)).toBe('2.0 MB/s');
  });
  it('shows nothing while the speed is not yet measurable', () => {
    expect(liveSpeedLabel(MB, 4 * MB, null)).toBeNull();
  });
  it('says Finishing once every byte is sent, whatever the decaying speed says', () => {
    expect(liveSpeedLabel(4 * MB, 4 * MB, 0)).toBe('Finishing…');
    expect(liveSpeedLabel(4 * MB, 4 * MB, null)).toBe('Finishing…');
  });
  it('does not call an empty file finished before it is', () => {
    expect(liveSpeedLabel(0, 0, null)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('shows tenths under ten seconds and whole units above', () => {
    expect(formatDuration(0)).toBe('0.0 s');
    expect(formatDuration(420)).toBe('0.4 s');
    expect(formatDuration(4_250)).toBe('4.3 s');
    expect(formatDuration(42_400)).toBe('42 s');
    expect(formatDuration(192_000)).toBe('3 min 12 s');
    expect(formatDuration(3_720_000)).toBe('1 h 2 min');
  });
  it('renders nonsense as a dash', () => {
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('averageSpeed', () => {
  it('is total bytes over elapsed time', () => {
    expect(averageSpeed(MB, 1000)).toBe(MB);
    expect(averageSpeed(10 * MB, 4000)).toBe(2.5 * MB);
  });
  it('has no value for zero elapsed time — a division by zero is not "infinitely fast"', () => {
    expect(averageSpeed(MB, 0)).toBeNull();
    expect(averageSpeed(MB, -10)).toBeNull();
  });
  it('has no value for zero bytes — an empty file was not slow', () => {
    expect(averageSpeed(0, 1000)).toBeNull();
  });
  it('stays exact for multi-terabyte uploads', () => {
    // 5 TiB over ten hours: well inside double precision.
    expect(averageSpeed(5 * TB, 36_000_000)).toBeCloseTo((5 * TB) / 36_000, 3);
  });
  it('rejects non-finite input', () => {
    expect(averageSpeed(Number.NaN, 1000)).toBeNull();
    expect(averageSpeed(MB, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('percentOf', () => {
  it('floors, so 100% means every byte landed', () => {
    expect(percentOf(0, 100)).toBe(0);
    expect(percentOf(996, 1000)).toBe(99);
    expect(percentOf(1000, 1000)).toBe(100);
  });
  it('is 0 for an empty total instead of NaN', () => {
    expect(percentOf(0, 0)).toBe(0);
  });
  it('clamps an overshoot to 100', () => {
    expect(percentOf(1100, 1000)).toBe(100);
  });
});

describe('addSpeedSample', () => {
  it('does not mutate the array it is given', () => {
    const before: readonly SpeedSample[] = [{ at: 0, loaded: 0 }];
    const after = addSpeedSample(before, { at: 100, loaded: 10 });
    expect(before).toEqual([{ at: 0, loaded: 0 }]);
    expect(after).toEqual([{ at: 0, loaded: 0 }, { at: 100, loaded: 10 }]);
  });
  it('keeps exactly one anchor at or before the window start and drops older samples', () => {
    let s: readonly SpeedSample[] = [];
    for (const at of [0, 1000, 2000, 3000, 4000]) s = addSpeedSample(s, { at, loaded: at }, 3000);
    s = addSpeedSample(s, { at: 5000, loaded: 5000 }, 3000);
    expect(s.map(x => x.at)).toEqual([2000, 3000, 4000, 5000]);
  });
  it('stays bounded over a long upload with frequent progress events', () => {
    const s = feed([{ at: 0, loaded: 0 }], 50, 600_000, 50, MB, 0);
    expect(s.length).toBeLessThanOrEqual(SPEED_WINDOW_MS / 50 + 2);
  });
});

describe('currentSpeed', () => {
  it('has no value without samples', () => {
    expect(currentSpeed([], 1000)).toBeNull();
  });
  it('withholds a reading until the measured span is long enough', () => {
    const s = addSpeedSample([{ at: 0, loaded: 0 }], { at: 500, loaded: MB });
    expect(currentSpeed(s, 500)).toBeNull();
  });
  it('measures a steady upload at its rate', () => {
    const s = feed([{ at: 0, loaded: 0 }], 100, 10_000, 100, MB, 0);
    expect(currentSpeed(s, 10_000)).toBeCloseTo(MB, 0);
  });
  it('tracks the last few seconds, not the lifetime average', () => {
    let s = feed([{ at: 0, loaded: 0 }], 100, 5_000, 100, MB, 0);
    s = feed(s, 5_100, 10_000, 100, 4 * MB, 5 * MB);
    // Lifetime average would be 2.5 MB/s; the window sees only the 4 MB/s phase.
    expect(currentSpeed(s, 10_000)).toBeCloseTo(4 * MB, -3);
  });
  it('amortises the browser first-buffer burst over the anchor at upload start', () => {
    // The first progress event can report megabytes a few ms in — that is
    // the socket buffer filling, not the link. Measured from the start
    // anchor it averages out instead of reading as hundreds of MB/s.
    let s = addSpeedSample([{ at: 0, loaded: 0 }], { at: 5, loaded: 2 * MB });
    s = addSpeedSample(s, { at: 1000, loaded: 3 * MB });
    expect(currentSpeed(s, 1000)).toBeCloseTo(3 * MB, 0);
  });
  it('decays to zero once nothing has moved for a whole window', () => {
    const s = feed([{ at: 0, loaded: 0 }], 100, 2_000, 100, MB, 0);
    expect(currentSpeed(s, 2_000)).toBeGreaterThan(0);
    // No new events (stalled link): the reading must not freeze at the last value.
    expect(currentSpeed(s, 2_000 + SPEED_WINDOW_MS + 1)).toBe(0);
    // A heartbeat sample with unchanged bytes says the same thing.
    const beat = addSpeedSample(s, { at: 6_000, loaded: s[s.length - 1].loaded });
    expect(currentSpeed(beat, 6_000)).toBe(0);
  });
  it('has no value when asked about a time before its samples', () => {
    const s = feed([{ at: 1_000, loaded: 0 }], 1_100, 3_000, 100, MB, 0);
    expect(currentSpeed(s, 500)).toBeNull();
  });
});

describe('summarizeUploads', () => {
  const tally = (over: Partial<UploadTally>): UploadTally => ({
    status: 'uploading', loaded: 0, total: 100, speed: null, startedAt: 0, ...over,
  });

  it('is empty for no uploads', () => {
    expect(summarizeUploads([])).toEqual({
      loaded: 0, total: 0, percent: 0, speed: null,
      doneCount: 0, doneBytes: 0, doneElapsedMs: null, doneAverageSpeed: null,
    });
  });

  it('adds live speeds across files uploading in parallel', () => {
    const s = summarizeUploads([
      tally({ loaded: 25, speed: 10 }),
      tally({ loaded: 50, speed: 20 }),
      tally({ status: 'done', loaded: 100, finishedAt: 1000 }),
    ]);
    expect(s.loaded).toBe(175);
    expect(s.total).toBe(300);
    expect(s.percent).toBe(58);
    expect(s.speed).toBe(30);
  });

  it('leaves failed and cancelled files out of bytes and speed', () => {
    const s = summarizeUploads([
      tally({ loaded: 40, speed: 5 }),
      tally({ status: 'error', loaded: 70, speed: 999 }),
      tally({ status: 'cancelled', loaded: 30, speed: 999 }),
    ]);
    expect(s.loaded).toBe(40);
    expect(s.total).toBe(100);
    expect(s.speed).toBe(5);
  });

  it('has no live speed while no upload has a measurable one', () => {
    expect(summarizeUploads([tally({ loaded: 10 }), tally({ loaded: 20 })]).speed).toBeNull();
  });

  it('averages completed uploads over wall-clock time, not the sum of per-file times', () => {
    const s = summarizeUploads([
      tally({ status: 'done', loaded: MB, total: MB, startedAt: 0, finishedAt: 2_000 }),
      tally({ status: 'done', loaded: 3 * MB, total: 3 * MB, startedAt: 0, finishedAt: 4_000 }),
    ]);
    expect(s.doneCount).toBe(2);
    expect(s.doneBytes).toBe(4 * MB);
    expect(s.doneElapsedMs).toBe(4_000);
    expect(s.doneAverageSpeed).toBe(MB);
    expect(s.percent).toBe(100);
  });

  it('takes the average from the same uploads it takes the time from', () => {
    // A done record without a finish time still counts towards the size,
    // but its bytes must not be divided by a span it was never part of.
    const s = summarizeUploads([
      tally({ status: 'done', loaded: MB, total: MB, startedAt: 0, finishedAt: 1_000 }),
      tally({ status: 'done', loaded: 9 * MB, total: 9 * MB, startedAt: 0 }),
    ]);
    expect(s.doneBytes).toBe(10 * MB);
    expect(s.doneElapsedMs).toBe(1_000);
    expect(s.doneAverageSpeed).toBe(MB);
  });

  it('has no average when nothing completed', () => {
    const s = summarizeUploads([
      tally({ status: 'error', loaded: 70 }),
      tally({ status: 'cancelled', loaded: 30 }),
    ]);
    expect(s.doneCount).toBe(0);
    expect(s.doneAverageSpeed).toBeNull();
    expect(s.doneElapsedMs).toBeNull();
  });
});
