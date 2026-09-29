/**
 * Console → Platform → Traffic.
 *
 * Cluster in/out over the last 24 hours, read at a glance.
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
const SPARK_H = 48;

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
      <Tile title="Traffic" to="/monitoring?tab=traffic">
        <div className="h-[62px] animate-pulse rounded bg-gray-100 dark:bg-gray-700/40" />
      </Tile>
    );
  }
  return <TrafficTileView frame={frame} />;
}

/** Split out so the rendering can be tested without a query client. */
export function TrafficTileView({ frame }: { frame: TrafficFrame }) {
  const out = frame.series.find((s) => s.key.includes('out')) ?? frame.series[0];
  const inb = frame.series.find((s) => s.key.includes('in') && s !== out);
  const step = frame.stepSeconds;

  const outTotal = out ? totalOf(out.points, step) : 0;
  const inTotal = inb ? totalOf(inb.points, step) : 0;
  const peak = frame.series.reduce((best, s) => s.points.reduce<number>(
    (b, v) => (v !== null && v > b ? v : b), best,
  ), 0);
  const ceiling = Math.max(peak * 1.15, 1);

  return (
    <Tile title="Traffic" to="/monitoring?tab=traffic">
      <div className="text-[22px] font-semibold leading-tight tracking-tight tabular-nums text-gray-900 dark:text-gray-100">
        {formatTrafficVolume(outTotal + inTotal, frame.unit)}
      </div>
      <div className="mt-0.5 flex gap-3 text-xs text-gray-600 dark:text-gray-300">
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <i className="h-2 w-2 rounded-sm" style={{ background: colourForIndex(0) }} />
          {formatTrafficVolume(outTotal, frame.unit)} out
        </span>
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <i className="h-2 w-2 rounded-sm" style={{ background: colourForIndex(1) }} />
          {formatTrafficVolume(inTotal, frame.unit)} in
        </span>
      </div>

      <svg
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[48px] w-full opacity-50"
      >
        {frame.series.map((s, i) => (
          <polyline
            key={s.key}
            points={pathFor(s.points, ceiling)}
            fill="none"
            stroke={colourForIndex(i)}
            strokeWidth={1.4}
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
