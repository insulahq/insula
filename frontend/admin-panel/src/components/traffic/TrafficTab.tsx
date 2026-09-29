/**
 * Monitoring → Traffic.
 *
 * Controls are hidden when they cannot apply rather than greyed out: a
 * direction picker means nothing on a latency chart, and a disabled control
 * is still a thing to read and dismiss. What is on screen is what you can use.
 */

import { useMemo, useState } from 'react';
import { Activity, ArrowUpDown, Gauge, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import type {
  TrafficBackupMode, TrafficDirection, TrafficMetric, TrafficScope,
} from '@insula/api-contracts';
import { useTrafficSeries, useTrafficSubjects } from '@/hooks/use-traffic';
import { extractOperatorError } from '@/lib/extract-operator-error';
import ErrorPanel from '@/components/ErrorPanel';
import StatCard from '@/components/ui/StatCard';
import TrafficChart from './TrafficChart';
import TrafficSummaryTable from './TrafficSummaryTable';
import TrafficPicker from './TrafficPicker';
import TrafficRangePicker, { presetRange, type RangeValue } from './TrafficRangePicker';
import {
  formatInstant, formatTrafficRate, formatTrafficVolume, utcOffsetLabel,
} from '@/lib/format-traffic';

const SCOPES: ReadonlyArray<{ key: TrafficScope; label: string; subjectLabel: string }> = [
  { key: 'cluster', label: 'Cluster', subjectLabel: 'Direction' },
  { key: 'node', label: 'Node', subjectLabel: 'Node' },
  { key: 'tenant', label: 'Tenant', subjectLabel: 'Tenant' },
  { key: 'pod', label: 'Pod', subjectLabel: 'Pod' },
  { key: 'route', label: 'Ingress route', subjectLabel: 'Route' },
];

const METRICS: ReadonlyArray<{ key: TrafficMetric; label: string }> = [
  { key: 'traffic', label: 'Traffic' },
  { key: 'requests', label: 'Requests' },
  { key: 'latency', label: 'Avg latency' },
];

function Segmented<T extends string>({
  label, value, options, onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ key: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </span>
      <div className="inline-flex rounded-md border border-gray-300 dark:border-gray-600" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={o.key === value}
            onClick={() => onChange(o.key)}
            className={clsx(
              'px-3 py-2 text-sm first:rounded-l-md last:rounded-r-md',
              o.key === value
                ? 'bg-brand-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700/60',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Which metrics a scope can actually answer. */
function metricsFor(scope: TrafficScope): ReadonlyArray<{ key: TrafficMetric; label: string }> {
  return scope === 'pod' ? METRICS.slice(0, 1) : METRICS;
}

export default function TrafficTab() {
  const [range, setRange] = useState<RangeValue>(() => presetRange('24h'));
  const [scope, setScope] = useState<TrafficScope>('cluster');
  const [subject, setSubject] = useState<string | null>(null);
  const [pod, setPod] = useState<string | null>(null);
  const [metric, setMetric] = useState<TrafficMetric>('traffic');
  const [direction, setDirection] = useState<TrafficDirection>('both');
  const [backups, setBackups] = useState<TrafficBackupMode>('included');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  // Traefik has no per-pod dimension, so those questions are not offered.
  const metricsForScope = metricsFor(scope);
  const effectiveMetric: TrafficMetric = metricsForScope.some((m) => m.key === metric) ? metric : 'traffic';
  const showBackups = effectiveMetric === 'traffic' && scope === 'cluster';
  const effectiveBackups: TrafficBackupMode = showBackups ? backups : 'included';
  const singleSubject = scope === 'cluster' || (scope === 'pod' ? Boolean(pod) : Boolean(subject));
  const showDirection = effectiveMetric === 'traffic' && !singleSubject && effectiveBackups === 'included';
  // A single subject shows both directions as two lines. A BREAKDOWN shows one
  // line per subject, so it picks a direction: "both" would draw two lines per
  // subject and let the top-N fold rank lines instead of subjects.
  const effectiveDirection: TrafficDirection = showDirection
    ? (direction === 'both' ? 'out' : direction)
    : 'both';

  const seriesParams = {
    from: range.from,
    to: range.to,
    scope,
    subject: subject ?? undefined,
    pod: pod ?? undefined,
    metric: effectiveMetric,
    direction: effectiveDirection,
    backups: effectiveBackups,
  };
  const { data: frame, isLoading, error } = useTrafficSeries(seriesParams);

  const needsSubjectList = scope !== 'cluster';
  const { data: subjects, isLoading: subjectsLoading } = useTrafficSubjects(
    { from: range.from, to: range.to, scope: scope === 'pod' ? 'pod' : scope, subject: scope === 'pod' ? (subject ?? undefined) : undefined, metric: effectiveMetric },
    needsSubjectList && (scope !== 'pod' || Boolean(subject)),
  );

  // Pods live under a tenant, so the tenant picker has to come first.
  const { data: tenantList, isLoading: tenantsLoading } = useTrafficSubjects(
    { from: range.from, to: range.to, scope: 'tenant', metric: 'traffic' },
    scope === 'pod',
  );

  const options = useMemo(
    () => (subjects ?? []).map((s) => ({
      key: s.key, label: s.name, meta: formatTrafficVolume(s.value, s.unit),
    })),
    [subjects],
  );
  const tenantOptions = useMemo(
    () => (tenantList ?? []).map((s) => ({
      key: s.key, label: s.name, meta: formatTrafficVolume(s.value, s.unit),
    })),
    [tenantList],
  );

  const scopeMeta = SCOPES.find((s) => s.key === scope) ?? SCOPES[0];
  const stacked = Boolean(frame) && frame!.unit !== 'milliseconds';

  const stats = useMemo(() => {
    if (!frame) return null;
    const step = frame.stepSeconds;
    const perIndex = frame.times.map((_, i) => frame.series.reduce((a, s) => {
      const v = s.points[i];
      return v === null || v === undefined ? a : a + v;
    }, 0));
    const measured = perIndex.filter((_, i) => frame.series.some((s) => s.points[i] !== null));
    const peak = measured.length ? Math.max(...measured) : 0;
    const peakAt = frame.times[perIndex.indexOf(peak)];
    const avg = measured.length ? measured.reduce((a, v) => a + v, 0) / measured.length : 0;
    const total = perIndex.reduce((a, v) => a + v, 0) * step;
    return { peak, peakAt, avg, total };
  }, [frame]);

  const operatorError = error ? extractOperatorError(error) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[280px] flex-1"><TrafficRangePicker value={range} onChange={setRange} /></div>

        <div className="min-w-[180px]">
          <TrafficPicker
            id="traffic-scope"
            label="Break down by"
            value={scope}
            options={SCOPES.map((s) => ({ key: s.key, label: s.label }))}
            onChange={(k) => {
              const next = (k as TrafficScope) ?? 'cluster';
              setScope(next);
              setSubject(null);
              setPod(null);
              setHidden(new Set());
              // Pod scope cannot answer a request or latency question, so a
              // metric carried over from another scope would leave the button
              // highlighted on something the chart is not showing.
              if (!metricsFor(next).some((m) => m.key === metric)) setMetric('traffic');
            }}
          />
        </div>

        {scope === 'pod' && (
          <div className="min-w-[220px]">
            <TrafficPicker
              id="traffic-tenant"
              label="Tenant"
              value={subject}
              options={tenantOptions}
              loading={tenantsLoading}
              allLabel="Choose a tenant"
              onChange={(k) => { setSubject(k); setPod(null); setHidden(new Set()); }}
            />
          </div>
        )}

        {needsSubjectList && (scope !== 'pod' || Boolean(subject)) && (
          <div className="min-w-[220px]">
            <TrafficPicker
              id="traffic-subject"
              label={scopeMeta.subjectLabel}
              value={scope === 'pod' ? pod : subject}
              options={options}
              loading={subjectsLoading}
              allLabel={`All ${scopeMeta.subjectLabel.toLowerCase()}s`}
              onChange={(k) => {
                if (scope === 'pod') setPod(k); else setSubject(k);
                setHidden(new Set());
              }}
            />
          </div>
        )}

        <Segmented
          label="Metric"
          value={effectiveMetric}
          options={metricsForScope}
          onChange={(m) => { setMetric(m); setHidden(new Set()); }}
        />

        {showBackups && (
          <Segmented
            label="Backups"
            value={backups}
            options={[
              { key: 'included' as const, label: 'Included' },
              { key: 'separate' as const, label: 'Separate' },
              { key: 'only' as const, label: 'Only' },
            ]}
            onChange={(b) => { setBackups(b); setHidden(new Set()); }}
          />
        )}

        {showDirection && (
          <Segmented
            label="Direction"
            value={effectiveDirection}
            options={[
              { key: 'out' as const, label: 'Out' },
              { key: 'in' as const, label: 'In' },
            ]}
            onChange={setDirection}
          />
        )}
      </div>

      {operatorError && <ErrorPanel error={operatorError} />}

      {frame && effectiveBackups !== 'included'
        && !frame.series.some((sx) => sx.kind === 'backup-class') && (
        // Splitting and seeing one lonely "Serving traffic" row is ambiguous:
        // it could mean no backups ran, or that the split is broken. Say which.
        <p className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600
          dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300"
        >
          No platform-scheduled backup traffic in this range.
        </p>
      )}

      {frame?.clamped && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800
          dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        >
          Showing from {formatInstant(frame.from)} — detailed metrics are kept for 30 days, and only
          per-tenant traffic is rolled up beyond that.
        </p>
      )}

      {stats && frame && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={frame.unit === 'milliseconds' ? 'Average' : 'Total'}
            value={frame.unit === 'milliseconds'
              ? formatTrafficRate(stats.avg, frame.unit)
              : formatTrafficVolume(stats.total, frame.unit)}
            subtitle={frame.resolution === 'daily' ? 'daily rollup' : 'over the selected range'}
            icon={ArrowUpDown}
            accent="brand"
          />
          <StatCard
            title="Peak"
            value={formatTrafficRate(stats.peak, frame.unit)}
            subtitle={stats.peakAt ? formatInstant(stats.peakAt) : '—'}
            icon={Activity}
          />
          <StatCard
            title="Average"
            value={formatTrafficRate(stats.avg, frame.unit)}
            subtitle={stats.avg > 0 ? `${(stats.peak / stats.avg).toFixed(1)}× peak-to-mean` : '—'}
            icon={Gauge}
          />
          <StatCard
            title="Resolution"
            value={frame.resolution === 'daily' ? '1 day' : `${Math.round(frame.stepSeconds / 60)} min`}
            subtitle={frame.resolution === 'daily'
              ? 'UTC days · spikes averaged out'
              : `${utcOffsetLabel()} · your time`}
            icon={Activity}
            accent={frame.resolution === 'daily' ? 'amber' : undefined}
          />
        </div>
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
              stacked={stacked}
              onZoom={(centre) => {
                const c = new Date(centre).getTime();
                const half = Math.max(1, (range.to.getTime() - range.from.getTime()) / 8);
                setRange({ from: new Date(c - half), to: new Date(c + half), preset: null });
              }}
            />
            <div className="mt-3">
              <TrafficSummaryTable
                frame={frame}
                hidden={hidden}
                subjectLabel={effectiveBackups === 'included' ? scopeMeta.subjectLabel : 'Class'}
                onToggle={(key) => setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key); else next.add(key);
                  return next;
                })}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
