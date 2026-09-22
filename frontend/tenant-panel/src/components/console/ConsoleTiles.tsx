import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import type { DashboardAlert, DashboardSection, ResourceTriad } from '@insula/api-contracts';

/**
 * The console's tile vocabulary.
 *
 * Four patterns, each answering a different shape of question:
 *   HoverCard  detail without navigating
 *   TriadBar   in use vs committed vs free — the gap is the point
 *   MatrixTile four sub-stats at a glance
 *   AlertChip  conditional; renders only when something needs attention
 */

/* ── hover card ──────────────────────────────────────────────────── */

/**
 * Opens on whichever side has room.
 *
 * A card that always opens downward renders off-screen for any tile near the
 * bottom of the window — which is most of them once you have scrolled. So it
 * measures on open and flips; and when neither side can hold it, it caps its
 * height and scrolls rather than drawing past the edge.
 */
export function HoverCard({ title, rows, note }: {
  title: string;
  rows: ReadonlyArray<readonly [string, string]>;
  note?: string | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  const place = useCallback(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const hr = host.getBoundingClientRect();
    const needed = el.scrollHeight;
    const below = window.innerHeight - hr.bottom - 12;
    const above = hr.top - 12;
    const useAbove = below < needed && above > below;
    const room = useAbove ? above : below;
    setStyle({
      ...(useAbove ? { bottom: 'calc(100% - 8px)', top: 'auto' } : { top: 'calc(100% - 8px)' }),
      ...(needed > room ? { maxHeight: Math.max(140, room), overflowY: 'auto' } : {}),
    });
  }, []);

  return (
    <div
      ref={ref}
      style={style}
      onMouseEnter={place}
      className={clsx(
        'pointer-events-none absolute left-3 right-3 z-30 rounded-xl border p-3 opacity-0 shadow-lg transition-opacity',
        'border-gray-300 bg-white group-hover:opacity-100 group-focus-within:opacity-100',
        'dark:border-gray-600 dark:bg-gray-800',
      )}
      data-testid="hover-card"
    >
      <h4 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {title}
      </h4>
      <dl className="flex flex-col gap-1">
        {rows.map(([k, v]) => (
          // Label and value stay on one line; the LABEL is the half that gives
          // way, because a truncated number is a wrong number.
          <div key={k} className="flex flex-nowrap items-baseline justify-between gap-3">
            <dt title={k} className="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-400">{k}</dt>
            <dd className="min-w-0 shrink break-words text-right font-mono text-xs tabular-nums text-gray-900 dark:text-gray-100">{v}</dd>
          </div>
        ))}
      </dl>
      {note ? (
        <p className="mt-2 border-t border-gray-200 pt-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/* ── tile shell ──────────────────────────────────────────────────── */

export function Tile({ title, to, children, card, busy }: {
  title: string;
  to: string;
  children: ReactNode;
  card?: ReactNode;
  busy?: boolean;
}) {
  return (
    <Link
      to={to}
      aria-busy={busy || undefined}
      className={clsx(
        'group relative flex flex-col rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-all',
        'hover:border-gray-300 hover:shadow-md focus-visible:outline focus-visible:outline-2',
        'dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-600',
      )}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {title}
        </span>
        <span className="flex-1" />
        <span className="hidden whitespace-nowrap font-mono text-[10px] text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 lg:inline dark:text-gray-500">
          {to} →
        </span>
      </div>
      {children}
      {card}
    </Link>
  );
}

/* ── triad bar ───────────────────────────────────────────────────── */

const fmt = (v: number, unit: string): string =>
  unit === 'cores' ? v.toFixed(2) : v >= 100 ? v.toFixed(0) : v.toFixed(1);

export function TriadBar({ triad, label, to, note, vocab = 'committed' }: {
  triad: ResourceTriad; label: string; to: string; note?: string;
  /**
   * Operators reserve capacity on nodes; customers have apps that reserve
   * theirs. Same number, and the word decides whether the tile reads as
   * infrastructure or as "what my plan is doing".
   */
  vocab?: 'committed' | 'reserved';
}) {
  const { inUse, committed, total, unit, kind } = triad;
  const consume = kind === 'consume';
  // Storage is consumed, not reserved: free is limit minus what is on disk,
  // and there is no reserved band to draw.
  const claimed = consume ? inUse : committed;
  const free = Math.max(0, total - claimed);
  const usedPct = total > 0 ? (inUse / total) * 100 : 0;
  const cmtPct = consume || total <= 0 ? 0 : Math.max(0, ((committed - inUse) / total) * 100);
  const tight = total > 0 && claimed / total >= (vocab === 'reserved' ? 0.75 : 0.9);
  /**
   * A zero usage reading against a non-zero commitment is almost always a
   * metrics source that did not answer, not a genuinely idle cluster. Printing
   * "0.00 cores in use" states a measurement that was never taken, so the
   * headline reads em-dash and the bar falls back to the commitment.
   */
  const usageUnknown = !consume && inUse === 0 && committed > 0;

  return (
    <Tile
      title={label}
      to={to}
      card={(
        <HoverCard
          title={`${label} — where it goes`}
          rows={[
            ['Allocatable', `${fmt(total, unit)} ${unit}`],
            ...(consume ? [] : [['Committed', `${fmt(committed, unit)} ${unit} · ${Math.round((committed / (total || 1)) * 100)}%`] as const]),
            ['In use', usageUnknown ? 'not reported' : `${fmt(inUse, unit)} ${unit} · ${Math.round(usedPct)}%`],
            [consume ? 'Free' : 'Schedulable left', `${fmt(free, unit)} ${unit}`],
          ]}
          note={consume
            ? 'Snapshots and replicas sit on disk without being a request.'
            : 'Requests are what the scheduler honours. Idle capacity behind a request cannot be handed to anything else.'}
        />
      )}
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-1.5">
        <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-gray-900 dark:text-gray-100">
          {usageUnknown ? '—' : fmt(inUse, unit)}
        </span>
        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
          {usageUnknown ? `${unit} · usage unavailable` : `${unit} in use`}
        </span>
        <span className="ml-auto whitespace-nowrap font-mono text-xs text-gray-500 dark:text-gray-400">
          of {fmt(total, unit)}
        </span>
      </div>
      <div className="flex h-3 overflow-hidden rounded-md bg-gray-200 dark:bg-gray-700">
        <div
          className={clsx('h-full', tight ? 'bg-amber-500' : 'bg-teal-600 dark:bg-teal-400')}
          style={{ width: `${Math.min(100, usedPct).toFixed(2)}%` }}
        />
        <div
          className={clsx('h-full opacity-60', tight ? 'bg-amber-300' : 'bg-teal-300 dark:bg-teal-700')}
          style={{ width: `${Math.min(100, cmtPct).toFixed(2)}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px] tabular-nums text-gray-600 dark:text-gray-400">
        {usageUnknown ? null : <span>in use {Math.round(usedPct)}%</span>}
        {!consume && <span>{vocab} {Math.round((committed / (total || 1)) * 100)}%</span>}
        <span>{consume ? 'free' : 'schedulable'} {fmt(free, unit)}</span>
      </div>
      <p className="mt-2.5 border-t border-dashed border-gray-200 pt-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400">
        {note ?? (consume
          ? (tight
              ? <><b className="text-amber-600 dark:text-amber-400">{fmt(free, unit)} {unit}</b> left. Clear space or move to a larger plan.</>
              : <><b>{fmt(free, unit)} {unit}</b> still free.</>)
          : (tight
              ? <>Only <b className="text-amber-600 dark:text-amber-400">{fmt(free, unit)} {unit}</b> left to {vocab === 'reserved' ? 'reserve' : 'schedule'} — a new workload has to fit in that, not in what is idle.</>
              : <><b>{fmt(free, unit)} {unit}</b> free for another workload.</>))}
      </p>
    </Tile>
  );
}

/* ── matrix tile ─────────────────────────────────────────────────── */

export interface MatrixCell {
  k: string; v: string; sub?: string;
  tone?: 'ok' | 'warn' | 'crit';
}

export function MatrixTile({ title, to, cells, card }: {
  title: string; to: string; cells: readonly MatrixCell[]; card?: ReactNode;
}) {
  return (
    <Tile title={title} to={to} card={card}>
      <div className="grid flex-1 grid-cols-2 gap-px overflow-hidden rounded-lg bg-gray-200 dark:bg-gray-700">
        {cells.map((c) => (
          <div key={c.k} className="min-w-0 bg-white p-2.5 dark:bg-gray-800">
            <div className="truncate text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{c.k}</div>
            <div className={clsx(
              'mt-0.5 flex flex-wrap items-baseline gap-1.5 font-mono text-base font-semibold tabular-nums',
              c.tone === 'ok' && 'text-green-600 dark:text-green-400',
              c.tone === 'warn' && 'text-amber-600 dark:text-amber-400',
              c.tone === 'crit' && 'text-red-600 dark:text-red-400',
              !c.tone && 'text-gray-900 dark:text-gray-100',
            )}>
              {c.v}
              {c.sub ? <small className="min-w-0 truncate text-[11px] font-normal text-gray-500 dark:text-gray-400">{c.sub}</small> : null}
            </div>
          </div>
        ))}
      </div>
    </Tile>
  );
}

/* ── alert chip ──────────────────────────────────────────────────── */

/**
 * Conditional by construction: this renders nothing for an empty list.
 *
 * The band is REMOVED when there is nothing in it rather than shown empty —
 * a region that is usually blank is a region operators learn to skip, and
 * that is the one region that must never be skipped.
 */
export function AlertBand({ alerts }: { alerts: readonly DashboardAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
      {alerts.map((a) => (
        <Link
          key={`${a.categoryId}:${a.title}`}
          to={a.href}
          className={clsx(
            'group relative block rounded-xl border border-l-4 p-3 transition-all hover:shadow-md',
            a.severity === 'critical'
              ? 'border-red-500 bg-red-50 dark:bg-red-950/40'
              : 'border-amber-500 bg-amber-50 dark:bg-amber-950/40',
          )}
          data-testid="alert-chip"
        >
          <div className={clsx(
            'font-mono text-xl font-bold tabular-nums',
            a.severity === 'critical' ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300',
          )}>
            {a.value}
          </div>
          <div className={clsx(
            'mt-1 line-clamp-2 text-xs font-semibold',
            a.severity === 'critical' ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300',
          )}>
            {a.title}
          </div>
          <div className="mt-0.5 line-clamp-2 text-[11px] text-gray-600 dark:text-gray-400">{a.subtitle}</div>
          <HoverCard title={a.title} rows={a.detail} note={a.note} />
        </Link>
      ))}
    </div>
  );
}

/* ── section state ───────────────────────────────────────────────── */

/**
 * A tile whose source failed says so.
 *
 * Rendering nothing would be worse: an empty tile and a broken tile look
 * identical, and only one of them is worth acting on.
 */
export function SectionFallback({ title, to, section }: {
  title: string; to: string; section: DashboardSection;
}) {
  return (
    <Tile title={title} to={to}>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {section.state === 'failed' ? 'Could not be read.' : 'Not read yet.'}
      </p>
      {section.reason ? (
        <p className="mt-1 break-words font-mono text-[11px] text-amber-600 dark:text-amber-400">{section.reason}</p>
      ) : null}
    </Tile>
  );
}

/** Skeletons take the geometry of what they stand in for, so nothing reflows. */
export function TileSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div
      aria-busy="true"
      className="flex flex-col rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
    >
      <div className="mb-2.5 h-3 w-20 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
      <div className="mb-2 h-7 w-2/5 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
      <div className="h-3 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="mt-2 h-3 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
      ))}
    </div>
  );
}
