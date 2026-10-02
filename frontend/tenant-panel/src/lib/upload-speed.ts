/**
 * Upload speed and size math for the file manager's upload progress.
 *
 * Pure on purpose: the hook feeds it XHR progress events and timestamps, the
 * modal formats its results, and neither needs a browser to be tested.
 *
 * Sizes are 1024-based with KB/MB/GB labels — the same convention as the file
 * listing's size column, so the final size shown for an upload matches the
 * size the file then shows in the directory.
 */

/** How far back the "current" speed looks. Long enough to smooth the
 *  per-event jitter of XHR progress, short enough to follow a change. */
export const SPEED_WINDOW_MS = 3000;

/** No live reading until this much time has been measured. The browser's
 *  first progress event can report megabytes within milliseconds (the
 *  socket buffer filling, not the link), so an early reading is fiction. */
export const MIN_SPEED_SPAN_MS = 1000;

export interface SpeedSample {
  /** Monotonic milliseconds (performance.now()). */
  readonly at: number;
  /** Bytes sent so far. */
  readonly loaded: number;
}

/**
 * Append `sample`, dropping every sample that can no longer anchor the window.
 *
 * Exactly one sample at or before the window start is kept as the anchor, so
 * the measured span always covers the full window once the upload is that old.
 */
export function addSpeedSample(
  samples: readonly SpeedSample[],
  sample: SpeedSample,
  windowMs: number = SPEED_WINDOW_MS,
): readonly SpeedSample[] {
  const next = [...samples, sample];
  const cutoff = sample.at - windowMs;
  let first = 0;
  while (first + 1 < next.length && next[first + 1].at <= cutoff) first++;
  return next.slice(first);
}

/**
 * Bytes/s over the last `windowMs` as of `now`, or null while unmeasurable.
 *
 * Measured from the anchor to `now` rather than to the newest sample, so a
 * stalled upload (no progress events) decays to 0 instead of freezing at its
 * last speed.
 */
export function currentSpeed(
  samples: readonly SpeedSample[],
  now: number,
  windowMs: number = SPEED_WINDOW_MS,
  minSpanMs: number = MIN_SPEED_SPAN_MS,
): number | null {
  if (samples.length === 0) return null;
  const cutoff = now - windowMs;
  let anchor = samples[0];
  for (const s of samples) {
    if (s.at > cutoff) break;
    anchor = s;
  }
  const span = now - anchor.at;
  if (!(span >= minSpanMs)) return null;
  const bytes = samples[samples.length - 1].loaded - anchor.loaded;
  return bytes > 0 ? (bytes / span) * 1000 : 0;
}

/** Total bytes over elapsed time, in bytes/s. Null for zero bytes or zero
 *  time: an empty file was not slow, and a divide-by-zero is not fast. */
export function averageSpeed(bytes: number, elapsedMs: number): number | null {
  if (!Number.isFinite(bytes) || !Number.isFinite(elapsedMs)) return null;
  if (bytes <= 0 || elapsedMs <= 0) return null;
  return (bytes / elapsedMs) * 1000;
}

/** Floored, so 100% is only shown once every byte has landed. */
export function percentOf(loaded: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.floor((loaded / total) * 100)));
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** `bytes` in the largest unit it fills; moves up a unit once the scaled
 *  value reaches `promoteAt` (1024 never promotes early). */
function scaleBytes(bytes: number, promoteAt: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1) return '0 B';
  let i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  if (i < UNITS.length - 1 && bytes / 1024 ** i >= promoteAt) i++;
  if (i === 0) return `${Math.round(bytes)} B`;
  return `${(bytes / 1024 ** i).toFixed(1)} ${UNITS[i]}`;
}

export function formatBytes(bytes: number): string {
  return scaleBytes(bytes, 1024);
}

/** Moves up a unit at 1000 so a speed hovering at a boundary reads as
 *  "1.0 MB/s" rather than alternating with "1022.6 KB/s". */
export function formatSpeed(bytesPerSecond: number): string {
  const size = scaleBytes(bytesPerSecond, 1000);
  return size === '—' ? size : `${size}/s`;
}

/**
 * The right-hand reading of a running upload: its live speed, or
 * "Finishing…" once every byte is sent and only the server's answer is
 * outstanding. A speed there would decay to 0 and read as a stall while the
 * server (or a buffering proxy in front of it) is still writing the file.
 */
export function liveSpeedLabel(loaded: number, total: number, speed: number | null): string | null {
  if (total > 0 && loaded >= total) return 'Finishing…';
  return speed === null ? null : formatSpeed(speed);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const whole = Math.round(seconds);
  if (whole < 3600) return `${Math.floor(whole / 60)} min ${whole % 60} s`;
  return `${Math.floor(whole / 3600)} h ${Math.floor((whole % 3600) / 60)} min`;
}

/** The fields of one upload the overall line needs. */
export interface UploadTally {
  readonly status: 'uploading' | 'done' | 'error' | 'cancelled';
  readonly loaded: number;
  readonly total: number;
  readonly speed: number | null;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

export interface UploadSummary {
  /** Bytes landed across uploads that are still going or done. */
  readonly loaded: number;
  readonly total: number;
  readonly percent: number;
  /** Sum of the live speeds of parallel uploads; null when none has one. */
  readonly speed: number | null;
  readonly doneCount: number;
  readonly doneBytes: number;
  /** First start to last finish of the completed uploads. */
  readonly doneElapsedMs: number | null;
  readonly doneAverageSpeed: number | null;
}

/**
 * The overall line across several uploads.
 *
 * Failed and cancelled uploads are left out entirely: their bytes never
 * landed, and any speed they carried is not a speed anything is moving at.
 * The completed average is over wall-clock time because the uploads ran in
 * parallel — summing per-file durations would understate the throughput.
 */
export function summarizeUploads(items: readonly UploadTally[]): UploadSummary {
  const counted = items.filter(u => u.status === 'uploading' || u.status === 'done');
  const done = counted.filter(u => u.status === 'done');
  const live = counted.filter(u => u.status === 'uploading' && u.speed !== null);

  const loaded = counted.reduce((acc, u) => acc + (u.status === 'done' ? u.total : u.loaded), 0);
  const total = counted.reduce((acc, u) => acc + u.total, 0);
  const allDone = counted.length > 0 && done.length === counted.length;

  const timed = done.filter(u => u.finishedAt !== undefined);
  const doneElapsedMs = timed.length === 0
    ? null
    : Math.max(...timed.map(u => u.finishedAt as number)) - Math.min(...timed.map(u => u.startedAt));
  const doneBytes = done.reduce((acc, u) => acc + u.total, 0);
  // The average divides the bytes of exactly the uploads the span was taken from.
  const timedBytes = timed.reduce((acc, u) => acc + u.total, 0);

  return {
    loaded,
    total,
    percent: allDone ? 100 : percentOf(loaded, total),
    speed: live.length === 0 ? null : live.reduce((acc, u) => acc + (u.speed as number), 0),
    doneCount: done.length,
    doneBytes,
    doneElapsedMs,
    doneAverageSpeed: doneElapsedMs === null ? null : averageSpeed(timedBytes, doneElapsedMs),
  };
}
