import type { DashboardSection } from '@insula/api-contracts';

/**
 * One tile's worth of data, and the state of the source that produced it.
 *
 * The dashboard fans out to a dozen sources. Awaiting them together with a
 * bare `Promise.all` means the slowest decides when the page renders and any
 * single rejection empties all of it — which is how a mail server that is
 * merely slow takes the capacity tiles down with it.
 *
 * So every source is wrapped: it gets its own deadline, its own failure, and
 * its own `state`. A failed section still renders as a tile carrying an
 * explicit reason, because an empty tile and a broken tile look the same to
 * the person reading them, and only one of those is worth acting on.
 */
export interface Section<T> extends DashboardSection {
  data: T | null;
}

/** Sources that have not answered in this long are treated as failed. */
export const SECTION_TIMEOUT_MS = 2_500;

export function ok<T>(data: T, observedAt = new Date().toISOString()): Section<T> {
  return { state: 'ok', reason: null, observedAt, data };
}

export function failed<T>(reason: string): Section<T> {
  return { state: 'failed', reason, observedAt: null, data: null };
}

/**
 * Run a source with a deadline and convert any outcome into a Section.
 *
 * `label` names the source in the operator-facing reason, so a failed tile
 * says which dependency let it down rather than "error".
 */
export async function collect<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; logger?: { warn?(...a: unknown[]): void } } = {},
): Promise<Section<T>> {
  const timeoutMs = opts.timeoutMs ?? SECTION_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not answer within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return ok(value);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.logger?.warn?.({ section: label, err: reason }, 'dashboard section failed');
    return failed<T>(reason);
  } finally {
    // Always clear it: a pending timer keeps the event loop alive and, worse,
    // its rejection lands unhandled after the caller has already returned.
    if (timer) clearTimeout(timer);
  }
}

/** Sections whose state is worth telling the reader about. */
export function degradedSections(
  sections: Record<string, DashboardSection>,
): string[] {
  return Object.entries(sections)
    .filter(([, s]) => s && s.state !== 'ok')
    .map(([name]) => name);
}
