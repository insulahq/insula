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
 */
export interface TriadFigures {
  /** null when nothing measured it — not zero. */
  readonly inUse: number | null;
  readonly committed: number;
  readonly total: number;
  readonly free: number;
  /** Share of the total in use, 0–100; 0 when not measured. */
  readonly inUsePct: number;
  /** Share of the total committed, 0–100 (capped: committing more than there is happens). */
  readonly committedPct: number;
}

const pct = (part: number, whole: number): number => (whole > 0 ? Math.min(100, (part / whole) * 100) : 0);

export function triadFigures(inUse: number | null, committed: number, total: number): TriadFigures {
  const claimed = Math.max(inUse ?? 0, committed);
  return {
    inUse,
    committed,
    total,
    free: Math.max(0, total - claimed),
    inUsePct: inUse === null ? 0 : pct(inUse, total),
    committedPct: pct(committed, total),
  };
}
