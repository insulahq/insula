/**
 * The three words every capacity figure in the admin panel is told in.
 *
 *   In use     what is actually being consumed right now.
 *   Committed  what has been promised — pod requests for CPU and memory,
 *              volume sizes for disk — and cannot go to anything else even
 *              while it sits idle.
 *   Free       what is neither: total less whichever of the two is larger.
 *
 * One definition of Free for CPU, memory and disk, on every page. Kubernetes
 * calls the total "allocatable", the scheduler calls committed "requests",
 * Longhorn calls it "scheduled" — the panel says total, committed, in use and
 * free, and the hover text names the source once.
 *
 *   Cache      node memory only: the kubelet's working set less process memory,
 *              kept out of in use (which is then process memory). Mostly file
 *              cache the kernel hands back when memory runs short, so it is
 *              drawn as a band at the start of Free — Free's definition does
 *              not change. It also holds shared memory (database buffers,
 *              memory-backed volumes), which the kernel cannot hand back and
 *              the kubelet does not report apart; the words say "mostly". A
 *              node with no tenant on it used to read 8 GiB "in use" of which
 *              3.2 GiB was this.
 */
export interface TriadFigures {
  /** null when nothing measured it — not zero. */
  readonly inUse: number | null;
  readonly committed: number;
  readonly total: number;
  readonly free: number;
  /** Node memory only; null when not measured or not applicable. */
  readonly cache: number | null;
  /**
   * The part of the cache drawn inside free: all of it, unless committed
   * leaves less free than there is cache. What the band shows, and what any
   * text beside Free or the band must say — never the raw cache.
   */
  readonly cacheInFree: number | null;
  /** Share of the total in use, 0–100; 0 when not measured. */
  readonly inUsePct: number;
  /** Share of the total committed, 0–100 (capped: committing more than there is happens). */
  readonly committedPct: number;
  /** Share of the total drawn as cache, inside free (never more than free); 0 without a figure. */
  readonly cachePct: number;
}

/** The cache band and its legend swatch — one class, so they cannot drift apart. */
export const CACHE_BAND = 'bg-sky-300 dark:bg-sky-700';

const pct = (part: number, whole: number): number => (whole > 0 ? Math.min(100, (part / whole) * 100) : 0);

export function triadFigures(inUse: number | null, committed: number, total: number, cache: number | null = null): TriadFigures {
  const claimed = Math.max(inUse ?? 0, committed);
  const free = Math.max(0, total - claimed);
  // In use is measured against allocatable and the cache against the whole
  // RAM, and committed is a promise, not memory: the cache can exceed free.
  const cacheInFree = cache === null ? null : Math.min(cache, free);
  return {
    inUse,
    committed,
    total,
    free,
    cache,
    cacheInFree,
    inUsePct: inUse === null ? 0 : pct(inUse, total),
    committedPct: pct(committed, total),
    cachePct: cacheInFree === null ? 0 : pct(cacheInFree, total),
  };
}
