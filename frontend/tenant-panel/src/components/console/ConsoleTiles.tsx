import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import type { DashboardAlert, DashboardAlertAction, DashboardSection, ResourceTriad } from '@insula/api-contracts';

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
 * Opens fully ABOVE or BELOW its tile, never on top of it, and sized to its
 * own content rather than to the tile.
 *
 * Two earlier mistakes, both reported from the running panels:
 *   * it was pinned `left-3 right-3`, so it inherited the tile's width. On a
 *     four-up grid that is a ~200px column, which is not enough to read a
 *     label and a figure on one line.
 *   * it sat at `calc(100% - 8px)`, i.e. overlapping the tile by 8px, so it
 *     read as drawn OVER the card instead of attached to it.
 *
 * So: content width with sane bounds, a real gap, and a measured horizontal
 * nudge so a wide card on a right-hand tile stays inside the viewport. The
 * vertical flip stays — a card that always opens downward is off-screen for
 * any tile near the bottom of the window, which is most of them once you have
 * scrolled.
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
    const GAP = 8;
    const below = window.innerHeight - hr.bottom - GAP;
    const above = hr.top - GAP;
    const useAbove = below < needed && above > below;
    const room = useAbove ? above : below;

    // Horizontal: start flush with the tile, then pull back if the card would
    // leave the viewport. Measurable because the card is opacity-0 rather than
    // hidden — it has real dimensions before it is ever shown.
    const width = el.offsetWidth;
    let left = 0;
    const overflowRight = hr.left + width - (window.innerWidth - GAP);
    if (overflowRight > 0) left = -overflowRight;
    if (hr.left + left < GAP) left = GAP - hr.left;

    setStyle({
      left,
      ...(useAbove
        ? { bottom: `calc(100% + ${GAP}px)`, top: 'auto' }
        : { top: `calc(100% + ${GAP}px)`, bottom: 'auto' }),
      ...(needed > room ? { maxHeight: Math.max(140, room), overflowY: 'auto' } : {}),
    });
  }, []);

  return (
    <div
      ref={ref}
      style={style}
      onMouseEnter={place}
      className={clsx(
        // w-max sizes to the content; the bounds stop a long note from
        // stretching to the page width or collapsing to the tile's column.
        'pointer-events-none absolute left-0 top-full z-30 w-max min-w-[15rem] max-w-[min(22rem,calc(100vw-1rem))]',
        'rounded-xl border p-3 opacity-0 shadow-xl transition-opacity',
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

/* ── refresh ─────────────────────────────────────────────────────── */

/**
 * Re-read the dashboard now.
 *
 * Both consoles poll on their own, so this is not the only way the numbers
 * move — it is for the moment after you changed something and want to see it
 * land, rather than waiting out an interval you cannot see.
 *
 * Disabled while a fetch is in flight, because a second click cannot make the
 * first one finish sooner and a spinner that restarts reads as progress.
 */
export function RefreshButton({ onClick, busy }: {
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label="Refresh"
      className={clsx(
        'ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
        'border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
        'dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700',
        busy && 'cursor-not-allowed opacity-60',
      )}
      data-testid="dashboard-refresh"
    >
      <RefreshCw size={13} className={busy ? 'animate-spin' : undefined} />
      Refresh
    </button>
  );
}

/* ── triad bar ───────────────────────────────────────────────────── */

/**
 * Core precision is chosen from the CEILING, not from the value — so both
 * halves of "X/Y" carry the same decimals, and a cluster tile does not grow
 * noise digits to accommodate a tenant-sized one.
 *
 * Two decimals of a core is a 10-millicore quantum. On a 7.5-core cluster
 * that is 0.13% and invisible; on a 2-core tenant plan it is 0.5%, and the
 * whole tenant fits inside it — a namespace running Apache, MariaDB and nginx
 * measured 0.3 to 19 millicores on production, every one of which printed as
 * "0.00".
 */
const coreDecimalsFor = (total: number): number => (total < 4 ? 3 : 2);

const fmt = (v: number, unit: string, coreDecimals = 2): string =>
  unit === 'cores' ? v.toFixed(coreDecimals)
    : v >= 100 ? v.toFixed(0) : v.toFixed(1);

/**
 * Band styling, from the design mockup.
 *
 * IN USE is solid; COMMITTED is HATCHED, and that is the whole point of the
 * triad — solid means "being used right now", hatch means "claimed but idle".
 * Built once from the written spec as two flat tints of one hue, which read
 * as a single gradient and lost the distinction entirely.
 *
 * One entry per tone, used by BOTH the bar segment and its legend swatch, so
 * a legend cannot end up describing a colour the bar no longer draws. The
 * hatch itself lives in index.css (@layer components): it needs a light and a
 * dark gradient at two pitches, which is more than an arbitrary class should
 * carry four times over.
 */
type BarTone = 'ok' | 'warn' | 'crit';

const BAND: Record<BarTone, {
  used: string; cmt: string; swUsed: string; swCmt: string;
}> = {
  ok: {
    used: 'bg-teal-700 dark:bg-teal-400',
    cmt: 'seg-committed',
    swUsed: 'bg-teal-700 dark:bg-teal-400',
    swCmt: 'swatch-committed',
  },
  warn: {
    used: 'bg-amber-700 dark:bg-amber-400',
    cmt: 'seg-committed-warn',
    swUsed: 'bg-amber-700 dark:bg-amber-400',
    swCmt: 'swatch-committed-warn',
  },
  crit: {
    used: 'bg-red-700 dark:bg-red-400',
    cmt: 'seg-committed-crit',
    swUsed: 'bg-red-700 dark:bg-red-400',
    swCmt: 'swatch-committed-crit',
  },
};

/** The free band is the bare track, so its swatch needs an outline to exist. */
const SW_FREE = 'bg-gray-200 ring-1 ring-inset ring-gray-300 dark:bg-gray-700 dark:ring-gray-600';

function Swatch({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={clsx('inline-block h-2 w-2 shrink-0 rounded-[2px]', className)} aria-hidden="true" />
      {children}
    </span>
  );
}

export function TriadBar({ triad, label, to, vocab = 'committed', extraRows = [] }: {
  triad: ResourceTriad; label: string; to: string;
  /**
   * Appended to the hover card under the triad's own rows. Storage uses it to
   * say WHERE the disk went, which is the question "178 of 540 GB" provokes
   * and cannot answer.
   */
  extraRows?: ReadonlyArray<readonly [string, string]>;
  /**
   * Operators reserve capacity on nodes; customers have apps that reserve
   * theirs. Same number, and the word decides whether the tile reads as
   * infrastructure or as "what my plan is doing".
   */
  vocab?: 'committed' | 'reserved';
}) {
  const { inUse: measured, committed, total, unit, kind } = triad;
  /**
   * null is the ONLY thing that means "not measured". A zero is a reading, and
   * an idle workload really does use zero — 23 of 27 production tenants were
   * being told their CPU usage was unavailable while metrics-server answered
   * for every one of them.
   */
  const usageUnknown = measured === null;
  const inUse = measured ?? 0;
  const dec = coreDecimalsFor(triad.total);
  const consume = kind === 'consume';
  // Storage is consumed, not reserved: free is limit minus what is on disk,
  // and there is no reserved band to draw.
  const claimed = consume ? inUse : committed;
  const free = Math.max(0, total - claimed);
  const usedPct = total > 0 ? (inUse / total) * 100 : 0;
  const cmtPct = consume || total <= 0 ? 0 : Math.max(0, ((committed - inUse) / total) * 100);
  /**
   * Two thresholds, not one. The mockup warns at 75% of the claim; a cluster
   * past 95% is a different conversation from one at 80%, and the mockup's
   * own stylesheet carries a crit band for it.
   */
  const claimFrac = total > 0 ? claimed / total : 0;
  const warnAt = vocab === 'reserved' ? 0.75 : 0.9;
  const tone: BarTone = claimFrac >= 0.95 ? 'crit' : claimFrac >= warnAt ? 'warn' : 'ok';
  const tight = tone !== 'ok';
  const band = BAND[tone];

  return (
    <Tile
      title={label}
      to={to}
      card={(
        <HoverCard
          title={`${label} — where it goes`}
          rows={[
            ['Allocatable', `${fmt(total, unit, dec)} ${unit}`],
            ...(consume ? [] : [['Committed', `${fmt(committed, unit, dec)} ${unit} · ${Math.round((committed / (total || 1)) * 100)}%`] as const]),
            ['In use', usageUnknown ? 'not reported' : `${fmt(inUse, unit, dec)} ${unit} · ${Math.round(usedPct)}%`],
            [consume ? 'Free' : 'Schedulable left', `${fmt(free, unit, dec)} ${unit}`],
            ...extraRows,
          ]}
          note={consume
            ? 'Snapshots and replicas sit on disk without being a request.'
            : 'Requests are what the scheduler honours. Idle capacity behind a request cannot be handed to anything else.'}
        />
      )}
    >
      {/* "X/Y unit in use" on the left, free right-aligned — the two numbers
          an operator actually compares, on one line. */}
      <div className="mb-2 flex items-baseline gap-2">
        <span className="min-w-0 truncate">
          <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-gray-900 dark:text-gray-100">
            {usageUnknown ? '—' : fmt(inUse, unit, dec)}<span className="text-gray-400 dark:text-gray-500">/</span>{fmt(total, unit, dec)}
          </span>
          <span className="ml-1.5 font-mono text-xs text-gray-500 dark:text-gray-400">
            {usageUnknown ? `${unit} · usage unavailable` : `${unit} in use`}
          </span>
        </span>
        <span className={clsx(
          'ml-auto whitespace-nowrap font-mono text-xs tabular-nums',
          tone === 'crit' ? 'font-semibold text-red-700 dark:text-red-400'
            : tone === 'warn' ? 'font-semibold text-amber-700 dark:text-amber-400'
            : 'text-gray-500 dark:text-gray-400',
        )}>
          {fmt(free, unit, dec)} free
        </span>
      </div>

      {/* 12px tall, 6px radius, bare track showing through as "free" — the
          mockup's proportions. */}
      <div className="flex h-3 overflow-hidden rounded-md bg-gray-200 dark:bg-gray-700">
        <div
          className={clsx('h-full', band.used)}
          style={{ width: `${Math.min(100, usedPct).toFixed(2)}%` }}
        />
        <div
          className={clsx('h-full', band.cmt)}
          style={{ width: `${Math.min(100, cmtPct).toFixed(2)}%` }}
        />
      </div>

      {/* Colour-coded legend: every band on the bar is named, and the swatch
          is the same class the band uses so they cannot drift apart. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-gray-600 dark:text-gray-400">
        {usageUnknown ? null : (
          <Swatch className={band.swUsed}>in use {Math.round(usedPct)}%</Swatch>
        )}
        {!consume && (
          <Swatch className={band.swCmt}>
            {vocab} {Math.round((committed / (total || 1)) * 100)}%
          </Swatch>
        )}
        <Swatch className={SW_FREE}>
          {consume ? 'free' : 'schedulable'} {fmt(free, unit, dec)}
        </Swatch>
      </div>
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
/**
 * `onAction` lets a page handle an alert in place instead of navigating.
 *
 * An alert carrying `action` renders as a BUTTON when the page supplies a
 * handler for it, and as the usual link otherwise — so a surface that does not
 * implement the action still goes somewhere, and `href` never becomes dead
 * weight on the contract.
 */
export function AlertBand({ alerts, onAction }: {
  alerts: readonly DashboardAlert[];
  onAction?: (action: DashboardAlertAction, alert: DashboardAlert) => void;
}) {
  if (alerts.length === 0) return null;
  const chipClass = (a: DashboardAlert): string => clsx(
    'group relative block w-full rounded-xl border border-l-4 p-3 text-left transition-all hover:shadow-md',
    a.severity === 'critical'
      ? 'border-red-500 bg-red-50 dark:bg-red-950/40'
      : 'border-amber-500 bg-amber-50 dark:bg-amber-950/40',
  );
  const body = (a: DashboardAlert): ReactNode => (
    <>
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
    </>
  );
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
      {alerts.map((a) => {
        const handled = a.action && onAction ? a.action : null;
        return handled ? (
          <button
            key={`${a.categoryId}:${a.title}`}
            type="button"
            onClick={() => onAction?.(handled, a)}
            className={chipClass(a)}
            data-testid="alert-chip"
          >
            {body(a)}
          </button>
        ) : (
          <Link
            key={`${a.categoryId}:${a.title}`}
            to={a.href}
            className={chipClass(a)}
            data-testid="alert-chip"
          >
            {body(a)}
          </Link>
        );
      })}
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
