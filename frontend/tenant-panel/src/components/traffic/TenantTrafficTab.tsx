/**
 * Monitoring → Traffic, tenant side.
 *
 * The allowance comes first, because it is the number this page exists to
 * explain. Everything below it is the detail behind that one figure.
 *
 * Platform-scheduled backups are absent by construction: they run inside this
 * tenant's namespace but are subtracted from the meter, so the API never
 * returns them here. Drawing them would contradict the bar at the top.
 */

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import clsx from 'clsx';
import type { TrafficMetric, TrafficScope } from '@insula/api-contracts';
import { useTenantContext } from '@/hooks/use-tenant-context';
import { useBandwidth } from '@/hooks/use-bandwidth';
import { useTrafficSeries, useTrafficSubjects } from '@/hooks/use-traffic';
import { extractOperatorError } from '@/lib/extract-operator-error';
import ErrorPanel from '@/components/ErrorPanel';
import TrafficChart from './TrafficChart';
import {
  combinedLine, TOTAL_KEY, totalLabel, totalState, trafficStats,
} from './combined-line';
import TrafficStats from './TrafficStats';
import TrafficSummaryTable from './TrafficSummaryTable';
import TrafficPicker from './TrafficPicker';
import TrafficRangePicker, { presetRange, type RangeValue } from './TrafficRangePicker';
import { formatInstant, formatTrafficRate, formatTrafficVolume } from '@/lib/format-traffic';

/** "24 hours", "7 days" — what the first tile is a total OVER. */
function spanLabel(r: { from: Date; to: Date }): string {
  const hours = Math.round((r.to.getTime() - r.from.getTime()) / 3_600_000);
  if (hours < 48) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return days < 60 ? `${days} days` : `${Math.round(days / 30)} months`;
}

/**
 * A dragged range as a query range. The last point stands for the step that
 * STARTS there, so the range runs to that step's end — otherwise zooming in
 * would drop the very spike the reader dragged across.
 */
function draggedRange(fromIso: string, toIso: string, stepSeconds: number): RangeValue {
  const to = Math.min(Date.now(), new Date(toIso).getTime() + stepSeconds * 1000);
  return { from: new Date(fromIso), to: new Date(to), preset: null };
}

const SCOPES: ReadonlyArray<{ key: TrafficScope; label: string; subjectLabel: string }> = [
  { key: 'tenant', label: 'My account', subjectLabel: 'Direction' },
  // Pod counters include traffic between this tenant's own pods — an
  // application talking to its database never leaves the cluster and is
  // not billed. This is the only view that shows it.
  { key: 'pod', label: 'Application (internal traffic)', subjectLabel: 'Application' },
  { key: 'route', label: 'My routes', subjectLabel: 'Route' },
];

const METRICS: ReadonlyArray<{ key: TrafficMetric; label: string }> = [
  { key: 'traffic', label: 'Traffic' },
  { key: 'requests', label: 'Requests' },
  { key: 'latency', label: 'Avg latency' },
];

/** Which metrics a scope can actually answer. */
function metricsFor(scope: TrafficScope): ReadonlyArray<{ key: TrafficMetric; label: string }> {
  return scope === 'pod' ? METRICS.slice(0, 1) : METRICS;
}

export default function TenantTrafficTab() {
  const { tenantId } = useTenantContext();
  const id = tenantId ?? '';
  const { data: bandwidthData } = useBandwidth();
  const bandwidth = bandwidthData?.data;

  const [range, setRange] = useState<RangeValue>(() => presetRange('7d'));
  const [scope, setScope] = useState<TrafficScope>('tenant');
  const [subject, setSubject] = useState<string | null>(null);
  const [metric, setMetric] = useState<TrafficMetric>('traffic');
  // The combined line starts OFF — see the admin tab.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set([TOTAL_KEY]));
  const [focus, setFocus] = useState<string | null>(null);
  const resetRows = (): void => { setHidden(new Set([TOTAL_KEY])); setFocus(null); };

  const metricsForScope = metricsFor(scope);
  const effectiveMetric: TrafficMetric = metricsForScope.some((m) => m.key === metric) ? metric : 'traffic';

  const { data: frame, isLoading, error } = useTrafficSeries(id, {
    from: range.from,
    to: range.to,
    scope,
    pod: scope === 'pod' ? (subject ?? undefined) : undefined,
    subject: scope === 'route' ? (subject ?? undefined) : undefined,
    metric: effectiveMetric,
    direction: 'both',
    backups: 'included',
  }, Boolean(id));

  const { data: subjects, isLoading: subjectsLoading } = useTrafficSubjects(
    id,
    { from: range.from, to: range.to, scope, metric: effectiveMetric },
    Boolean(id) && scope !== 'tenant',
  );

  const options = useMemo(
    () => (subjects ?? []).map((s) => ({ key: s.key, label: s.name, meta: formatTrafficVolume(s.value, s.unit) })),
    [subjects],
  );

  // One combined line feeds the tiles, the spike markers, the Total line and
  // each row's share, so none of them can disagree. It follows the rows shown.
  const combined = useMemo(() => (frame ? combinedLine(frame, hidden) : null), [frame, hidden]);
  const stats = useMemo(() => {
    if (!frame) return null;
    const base = trafficStats(frame, hidden);
    if (!base) return null;
    const sumOf = (name: string): number | null => {
      const s = frame.series.find((x) => x.name === name && !hidden.has(x.key));
      return s ? s.points.reduce<number>((a, v) => a + (v ?? 0), 0) * frame.stepSeconds : null;
    };
    return { ...base, out: sumOf('Outbound'), in: sumOf('Inbound') };
  }, [frame, hidden]);

  const scopeMeta = SCOPES.find((s) => s.key === scope) ?? SCOPES[0];
  // A breakdown across applications or routes offers a combined Total; the
  // account view is one subject's two directions, which it would just repeat.
  const singleSubject = scope === 'tenant' || Boolean(subject);
  const total = frame ? totalState(frame, hidden, !singleSubject) : null;
  const operatorError = error ? extractOperatorError(error) : null;

  const pct = bandwidth
    ? Math.min(100, Math.round((bandwidth.usedGb / Math.max(1, bandwidth.limitGb)) * 100))
    : 0;

  return (
    <div className="space-y-4">
      {bandwidth && (
        <div
          className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
          data-testid="traffic-allowance"
        >
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Included traffic this month
            </span>
            <span className="tabular-nums text-sm text-gray-900 dark:text-gray-100">
              {bandwidth.usedGb.toFixed(bandwidth.usedGb >= 10 ? 0 : 1)} GB of {bandwidth.limitGb} GB
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className={clsx('h-2.5 rounded-full transition-all',
                pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-brand-500')}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Backups scheduled by the platform are not counted, and are not drawn below. A backup you
            start yourself is your traffic and appears in both.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-x-3.5 gap-y-2.5">
        <div className="min-w-[320px]"><TrafficRangePicker value={range} onChange={setRange} /></div>
        <div className="min-w-[180px]">
          <TrafficPicker
            id="tenant-traffic-scope"
            label="Break down by"
            value={scope}
            options={SCOPES.map((s) => ({ key: s.key, label: s.label }))}
            onChange={(k) => {
              const next = (k as TrafficScope) ?? 'tenant';
              setScope(next);
              setSubject(null);
              resetRows();
              if (!metricsFor(next).some((m) => m.key === metric)) setMetric('traffic');
            }}
          />
        </div>
        {scope !== 'tenant' && (
          <div className="min-w-[220px]">
            <TrafficPicker
              id="tenant-traffic-subject"
              label={scopeMeta.subjectLabel}
              value={subject}
              options={options}
              loading={subjectsLoading}
              allLabel={`All ${scopeMeta.subjectLabel.toLowerCase()}s`}
              onChange={(k) => { setSubject(k); resetRows(); }}
            />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Metric
          </span>
          <div className="inline-flex rounded-md border border-gray-300 dark:border-gray-600" role="group" aria-label="Metric">
            {metricsForScope.map((m) => (
              <button
                key={m.key}
                type="button"
                aria-pressed={m.key === effectiveMetric}
                onClick={() => { setMetric(m.key); resetRows(); }}
                className={clsx(
                  'px-3 py-2 text-sm first:rounded-l-md last:rounded-r-md',
                  m.key === effectiveMetric
                    ? 'bg-brand-600 text-white'
                    : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700/60',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {operatorError && <ErrorPanel error={operatorError} />}

      {frame && stats && (
        <TrafficStats stats={[
          frame.unit === 'bytes' && stats.out !== null && stats.in !== null
            ? {
              key: 'outin',
              label: 'Out / In',
              value: `${formatTrafficVolume(stats.out, frame.unit)} / ${formatTrafficVolume(stats.in, frame.unit)}`,
              sub: `over ${spanLabel(range)}`,
            }
            : {
              key: 'total',
              label: frame.unit === 'milliseconds' ? 'Average' : 'Total',
              value: frame.unit === 'milliseconds'
                ? formatTrafficRate(stats.avg, frame.unit)
                : formatTrafficVolume(stats.total, frame.unit),
              sub: `over ${spanLabel(range)}`,
            },
          {
            key: 'peak',
            label: frame.resolution === 'daily' ? 'Peak (daily)' : 'Peak',
            value: formatTrafficRate(stats.peak, frame.unit),
            sub: stats.peakAt ? formatInstant(stats.peakAt) : '—',
          },
          {
            key: 'average',
            label: 'Average',
            value: formatTrafficRate(stats.avg, frame.unit),
            sub: stats.avg > 0 ? `${(stats.peak / stats.avg).toFixed(1)}× peak-to-mean` : '—',
          },
          {
            key: 'spikes',
            label: 'Spikes flagged',
            value: String(stats.spikes.length),
            sub: stats.spikes.length ? 'click a marker to zoom' : 'none in this range',
            alert: stats.spikes.length > 0,
          },
        ]}
        />
      )}

      {frame?.clamped && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800
          dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        >
          Showing from {formatInstant(frame.from)} — detailed metrics are kept for 30 days.
        </p>
      )}
      {frame?.resolution === 'daily' && (
        <p className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600
          dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300"
        >
          Daily rollup — one point per UTC day, so short spikes are averaged out.
        </p>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        {isLoading && (
          <div className="flex h-[260px] items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        )}
        {!isLoading && frame && (
          <>
            <TrafficChart
              frame={frame}
              hidden={hidden}
              focusKey={focus}
              combined={total?.offered ? combined : null}
              showTotal={Boolean(total?.drawn)}
              spikeIndices={stats?.spikes}
              onZoom={(centre) => {
                const c = new Date(centre).getTime();
                const half = Math.max(1, (range.to.getTime() - range.from.getTime()) / 8);
                setRange({ from: new Date(c - half), to: new Date(c + half), preset: null });
              }}
              onRangeSelect={(a, b) => setRange(draggedRange(a, b, frame.stepSeconds))}
            />
            <div className="mt-3">
              <TrafficSummaryTable
                frame={frame}
                hidden={hidden}
                subjectLabel={scopeMeta.subjectLabel}
                total={total?.offered && combined ? {
                  name: totalLabel(frame.unit),
                  points: combined,
                  off: !total.drawn,
                  disabled: !total.usable,
                } : null}
                focusKey={focus}
                onFocus={setFocus}
                onToggle={(key) => {
                  setFocus(null);
                  setHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(key)) next.delete(key); else next.add(key);
                    return next;
                  });
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
