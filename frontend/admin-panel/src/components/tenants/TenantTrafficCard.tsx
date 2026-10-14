import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronRight, Loader2 } from 'lucide-react';
import type { TrafficFrame, TrafficSeries } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { useTrafficSeries } from '@/hooks/use-traffic';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { formatTrafficVolume } from '@/lib/format-traffic';
import { trafficTabUrl } from '@/components/traffic/traffic-url';

/**
 * Tenant detail → Traffic (7 days).
 *
 * What the tenant's sites moved through the ingress over the last week —
 * inbound (received from visitors) and outbound (served to them) — with a
 * chart of both. The same series Monitoring → Traffic draws for this tenant
 * (`scope=tenant`, one subject, both directions), so the figures here and
 * there agree; the whole card links to that view with the tenant and the
 * 7-day range already chosen.
 *
 * Inbound / outbound, the words Monitoring → Traffic uses. "Upload" and
 * "download" named the same two directions from the visitor's side, so the
 * card and the page it links to called one figure by two names.
 *
 * The chart takes whatever height the card has: the card sits beside the
 * tenant's details, and a fixed 56px strip left most of it empty.
 */

const RANGE_DAYS = 7;
const SPARK_W = 300;
const SPARK_H = 100;

// Fixed hues, matching the out/in pair on the Traffic tab's chart.
const OUTBOUND_COLOUR = '#6366f1';
const INBOUND_COLOUR = '#14b8a6';

export interface TenantTrafficSummary {
  /** Bytes the tenant's sites received. */
  readonly inbound: number;
  /** Bytes they sent. */
  readonly outbound: number;
  readonly inboundPoints: ReadonlyArray<number | null>;
  readonly outboundPoints: ReadonlyArray<number | null>;
  /** True when no point in either direction was measured. */
  readonly empty: boolean;
}

function totalOf(points: ReadonlyArray<number | null>, stepSeconds: number): number {
  return points.reduce<number>((sum, v) => (v === null ? sum : sum + v * stepSeconds), 0);
}

/**
 * The out / in series of a single-tenant frame. A single subject is drawn as
 * one line per direction, keyed `out` / `in` (a daily-rollup frame keys its
 * one line by tenant id and carries egress only — that is outbound).
 */
function directionSeries(series: readonly TrafficSeries[]): { out?: TrafficSeries; in?: TrafficSeries } {
  const out = series.find((s) => s.key === 'out' || s.key.endsWith(':out'));
  const inbound = series.find((s) => s.key === 'in' || s.key.endsWith(':in'));
  if (out || inbound) return { out, in: inbound };
  return { out: series[0] };
}

/**
 * Pure: 7-day totals per direction, from rates × step. Tolerates a malformed
 * frame (reads it as nothing measured) — this card sits on the tenant page,
 * and a bad answer from the traffic API must cost the card, not the page.
 */
export function summarizeTenantTraffic(frame: TrafficFrame): TenantTrafficSummary {
  const series = Array.isArray(frame?.series) ? frame.series : [];
  const step = Number.isFinite(frame?.stepSeconds) ? frame.stepSeconds : 0;
  const { out, in: inbound } = directionSeries(series);
  const outboundPoints = Array.isArray(out?.points) ? out.points : [];
  const inboundPoints = Array.isArray(inbound?.points) ? inbound.points : [];
  return {
    inbound: totalOf(inboundPoints, step),
    outbound: totalOf(outboundPoints, step),
    inboundPoints,
    outboundPoints,
    empty: [...outboundPoints, ...inboundPoints].every((v) => v === null),
  };
}

function polyline(points: ReadonlyArray<number | null>, ceiling: number): string {
  const n = points.length;
  return points
    .map((v, i) => (v === null
      ? null
      : `${((i / Math.max(1, n - 1)) * SPARK_W).toFixed(1)},${(SPARK_H - (v / ceiling) * (SPARK_H - 4) - 2).toFixed(1)}`))
    .filter((p): p is string => p !== null)
    .join(' ');
}

interface TenantTrafficCardProps {
  readonly namespace: string | null | undefined;
}

export default function TenantTrafficCard({ namespace }: TenantTrafficCardProps) {
  // Fixed on mount: a range rebuilt every render would change the query key
  // (it carries the instants) and refetch forever.
  const [range] = useState(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - RANGE_DAYS * 86_400_000), to };
  });
  const { data: frame, isLoading, error } = useTrafficSeries({
    from: range.from,
    to: range.to,
    scope: 'tenant',
    subject: namespace ?? undefined,
    metric: 'traffic',
    direction: 'both',
    backups: 'included',
  }, Boolean(namespace));

  const href = trafficTabUrl({ scope: 'tenant', subject: namespace ?? undefined, range: '7d' });
  const operatorError = error ? extractOperatorError(error) : null;
  const summary = frame ? summarizeTenantTraffic(frame) : null;

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800" data-testid="tenant-traffic-card">
      <Link
        to={href}
        className="group -m-2 flex flex-1 flex-col rounded-lg p-2 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-gray-700/40"
        title="Open Monitoring → Traffic for this tenant, last 7 days"
        data-testid="tenant-traffic-link"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Traffic (7 days)</h2>
          <ChevronRight size={18} className="text-gray-400 transition-transform group-hover:translate-x-0.5 dark:text-gray-500" />
        </div>

        {!namespace && (
          <p className="text-sm text-gray-500 dark:text-gray-400">No namespace yet — traffic is measured once the tenant is provisioned.</p>
        )}
        {namespace && isLoading && (
          <div className="flex min-h-[96px] flex-1 items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        )}
        {summary && frame && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Figure
                label="Inbound"
                hint="Received from visitors"
                value={formatTrafficVolume(summary.inbound, frame.unit)}
                colour={INBOUND_COLOUR}
                icon={<ArrowDown size={12} />}
                testId="tenant-traffic-inbound"
              />
              <Figure
                label="Outbound"
                hint="Served to visitors"
                value={formatTrafficVolume(summary.outbound, frame.unit)}
                colour={OUTBOUND_COLOUR}
                icon={<ArrowUp size={12} />}
                testId="tenant-traffic-outbound"
              />
            </div>
            <Spark summary={summary} />
            {summary.empty && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">No traffic measured in the last 7 days.</p>
            )}
          </>
        )}
      </Link>
      {operatorError && (
        <div className="mt-3">
          <ErrorPanel error={operatorError} compact testId="tenant-traffic-error" />
        </div>
      )}
    </div>
  );
}

function Figure({ label, hint, value, colour, icon, testId }: {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly colour: string;
  readonly icon: ReactNode;
  readonly testId: string;
}) {
  return (
    <div title={hint}>
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
        <span className="inline-flex h-4 w-4 items-center justify-center rounded text-white" style={{ background: colour }}>{icon}</span>
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-gray-900 dark:text-gray-100" data-testid={testId}>{value}</div>
    </div>
  );
}

function Spark({ summary }: { readonly summary: TenantTrafficSummary }) {
  const peak = [...summary.outboundPoints, ...summary.inboundPoints]
    .reduce<number>((max, v) => (v !== null && v > max ? v : max), 0);
  const ceiling = Math.max(peak * 1.08, 1);
  return (
    // flex-1 takes the card's spare height; min-h keeps a chart when the card
    // stands alone (stacked on a narrow screen) and has none to give. The SVG
    // is laid over the box rather than sized as a flex item: its viewBox gives
    // it an intrinsic height, which would set the box's height instead of
    // following it.
    <div className="relative mt-3 min-h-[56px] flex-1" data-testid="tenant-traffic-chart">
      <svg
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full rounded bg-gray-50 dark:bg-gray-900/40"
        data-testid="tenant-traffic-spark"
      >
        {[
          { key: 'inbound', points: summary.inboundPoints, colour: INBOUND_COLOUR },
          { key: 'outbound', points: summary.outboundPoints, colour: OUTBOUND_COLOUR },
        ].map((l) => (
          <polyline
            key={l.key}
            points={polyline(l.points, ceiling)}
            fill="none"
            stroke={l.colour}
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  );
}
