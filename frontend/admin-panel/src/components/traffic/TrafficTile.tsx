/**
 * Console → Platform → Traffic.
 *
 * Cluster traffic over the last 24 hours, read at a glance: internet and
 * between-node traffic, each byte counted once.
 *
 * The sparkline is positioned OUT OF FLOW along the card's lower edge. In an
 * auto-fit grid every row stretches to its tallest card, so a chart added in
 * flow silently raises the height of every tile beside it — measured at +62px
 * on the four-tile Platform row. Out of flow it costs the grid nothing and
 * this card measures exactly like its neighbours.
 *
 * Not interactive on purpose: the whole tile is one link, and a tooltip that
 * follows the pointer fights the click target it sits inside. The exact time
 * of a spike is one click away on the tab this links to.
 */

import { useMemo } from 'react';
import type { TrafficFrame } from '@insula/api-contracts';
import { Tile } from '@/components/console/ConsoleTiles';
import { useTrafficSeries } from '@/hooks/use-traffic';
import { formatTrafficRate, formatTrafficVolume } from '@/lib/format-traffic';
import { colourForIndex } from './TrafficChart';

const SPARK_W = 260;
// Tall enough to use the card rather than hug its bottom edge. Out of flow,
// so growing it costs the grid nothing (see the note above).
const SPARK_H = 66;

function pathFor(points: ReadonlyArray<number | null>, ceiling: number): string {
  const n = points.length;
  return points
    .map((v, i) => (v === null
      ? null
      : `${((i / Math.max(1, n - 1)) * SPARK_W).toFixed(1)},${(SPARK_H - (v / ceiling) * (SPARK_H - 3) - 1.5).toFixed(1)}`))
    .filter((p): p is string => p !== null)
    .join(' ');
}

function totalOf(points: ReadonlyArray<number | null>, stepSeconds: number): number {
  let t = 0;
  for (const v of points) if (v !== null) t += v * stepSeconds;
  return t;
}

export default function TrafficTile() {
  const { from, to } = useMemo(() => {
    const now = new Date();
    return { from: new Date(now.getTime() - 24 * 3_600_000), to: now };
  }, []);

  const { data: frame, isLoading } = useTrafficSeries({
    from, to, scope: 'cluster', metric: 'traffic', direction: 'both', backups: 'included',
  });

  if (isLoading || !frame) {
    return (
      <Tile title="Traffic" to="/monitoring/traffic">
        <div className="h-[62px] animate-pulse rounded bg-gray-100 dark:bg-gray-700/40" />
      </Tile>
    );
  }
  return <TrafficTileView frame={frame} />;
}

/** Point-wise sum; null only where every input is unmeasured. */
function addPoints(series: ReadonlyArray<TrafficFrame['series'][number]>): Array<number | null> {
  const n = series[0]?.points.length ?? 0;
  return Array.from({ length: n }, (_, i) => {
    const vals = series.map((s) => s.points[i]).filter((v): v is number => v !== null && v !== undefined);
    return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
  });
}

const measured = (points: ReadonlyArray<number | null>): boolean => points.some((v) => v !== null);

interface TileLine { readonly key: string; readonly label: string; readonly points: Array<number | null> }

/**
 * Which lines the tile draws, and what its legend calls them.
 *
 * The cluster frame's `wire` rows are internet out, internet in and
 * node-to-node — each byte once, so they add up to the real total. The tile
 * shows that total, split the way an operator asks about it: what went to the
 * internet, and what moved between the nodes.
 *
 * Where those rows hold nothing yet (a range before the per-node counters
 * existed, or a cluster not upgraded) it falls back to a direction pair — the
 * NIC sum, or an older frame's wire pair — rather than an empty card.
 */
function tileLines(frame: TrafficFrame): { lines: TileLine[]; split: boolean } {
  const wire = frame.series.filter((s) => s.group === 'wire');
  const internet = wire.filter((s) => s.key.startsWith('wire:internet:'));
  const n2n = wire.find((s) => s.key === 'wire:n2n');
  if (internet.length > 0 && n2n && [...internet, n2n].some((s) => measured(s.points))) {
    return {
      split: true,
      lines: [
        { key: 'internet', label: 'internet', points: addPoints(internet) },
        { key: 'n2n', label: 'between nodes', points: [...n2n.points] },
      ],
    };
  }
  // Selected by GROUP, not by whether the key happens to contain "in" or
  // "out": other keys contain those substrings too.
  const nic = frame.series.filter((s) => s.group === 'nic');
  const pair = nic.length > 0 ? nic : (wire.length > 0 ? wire : frame.series.slice(0, 2));
  const out = pair.find((s) => s.key.startsWith('out') || s.key.endsWith(':out')) ?? pair[0];
  const inb = pair.find((s) => s !== out);
  return {
    split: false,
    lines: [
      ...(out ? [{ key: out.key, label: 'out', points: [...out.points] }] : []),
      ...(inb ? [{ key: inb.key, label: 'in', points: [...inb.points] }] : []),
    ],
  };
}

/** Split out so the rendering can be tested without a query client. */
export function TrafficTileView({ frame }: { frame: TrafficFrame }) {
  // The cluster frame carries a dozen series (the wire, its node-to-node split,
  // tenants, backups, the NIC sum). Drawing all of them under a two-entry
  // legend was both wrong and unreadable, and a ceiling taken across them
  // squashed the lines that matter against the baseline.
  const { lines } = tileLines(frame);
  const step = frame.stepSeconds;
  const totals = lines.map((l) => totalOf(l.points, step));
  const grand = totals.reduce((a, t) => a + t, 0);
  // Peak over what is DRAWN, so the sparkline uses the card's full height
  // and the footer figure describes the line above it.
  const peak = lines.reduce((best, l) => l.points.reduce<number>(
    (b, v) => (v !== null && v > b ? v : b), best,
  ), 0);
  const ceiling = Math.max(peak * 1.08, 1);

  return (
    <Tile title="Traffic" to="/monitoring/traffic">
      <div className="text-[22px] font-semibold leading-tight tracking-tight tabular-nums text-gray-900 dark:text-gray-100">
        {formatTrafficVolume(grand, frame.unit)}
      </div>
      <div className="mt-0.5 flex gap-3 text-xs text-gray-600 dark:text-gray-300">
        {lines.map((l, i) => (
          <span key={l.key} className="inline-flex items-center gap-1.5 tabular-nums">
            <i className="h-2 w-2 rounded-sm" style={{ background: colourForIndex(i) }} />
            {formatTrafficVolume(totals[i], frame.unit)} {l.label}
          </span>
        ))}
      </div>

      <svg
        data-testid="traffic-tile-spark"
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[66px] w-full opacity-60"
      >
        {lines.map((l, i) => (
          <polyline
            key={l.key}
            points={pathFor(l.points, ceiling)}
            fill="none"
            stroke={colourForIndex(i)}
            strokeWidth={2.4}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      <div className="relative z-10 mt-auto flex justify-between gap-3 pt-2.5 text-[11px] text-gray-500 tabular-nums dark:text-gray-400">
        <span>peak {formatTrafficRate(peak, frame.unit)}</span>
        <span>last 24 hours</span>
      </div>
    </Tile>
  );
}
