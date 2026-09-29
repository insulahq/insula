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
import { Activity, ArrowUpDown, Gauge, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import type { TrafficMetric, TrafficScope } from '@insula/api-contracts';
import { useTenantContext } from '@/hooks/use-tenant-context';
import { useBandwidth } from '@/hooks/use-bandwidth';
import { useTrafficSeries, useTrafficSubjects } from '@/hooks/use-traffic';
import { extractOperatorError } from '@/lib/extract-operator-error';
import ErrorPanel from '@/components/ErrorPanel';
import TrafficChart from './TrafficChart';
import TrafficSummaryTable from './TrafficSummaryTable';
import TrafficPicker from './TrafficPicker';
import TrafficRangePicker, { presetRange, type RangeValue } from './TrafficRangePicker';
import {
  formatInstant, formatTrafficRate, formatTrafficVolume, utcOffsetLabel,
} from '@/lib/format-traffic';

const SCOPES: ReadonlyArray<{ key: TrafficScope; label: string; subjectLabel: string }> = [
  { key: 'tenant', label: 'My account', subjectLabel: 'Direction' },
  { key: 'pod', label: 'Application', subjectLabel: 'Application' },
  { key: 'route', label: 'My routes', subjectLabel: 'Route' },
];

const METRICS: ReadonlyArray<{ key: TrafficMetric; label: string }> = [
  { key: 'traffic', label: 'Traffic' },
  { key: 'requests', label: 'Requests' },
  { key: 'latency', label: 'Avg latency' },
];

export default function TenantTrafficTab() {
  const { tenantId } = useTenantContext();
  const id = tenantId ?? '';
  const { data: bandwidthData } = useBandwidth();
  const bandwidth = bandwidthData?.data;

  const [range, setRange] = useState<RangeValue>(() => presetRange('7d'));
  const [scope, setScope] = useState<TrafficScope>('tenant');
  const [subject, setSubject] = useState<string | null>(null);
  const [metric, setMetric] = useState<TrafficMetric>('traffic');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const metricsForScope = scope === 'pod' ? METRICS.slice(0, 1) : METRICS;
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

  const scopeMeta = SCOPES.find((s) => s.key === scope) ?? SCOPES[0];
  const stacked = Boolean(frame) && frame!.unit !== 'milliseconds';
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

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[280px] flex-1"><TrafficRangePicker value={range} onChange={setRange} /></div>
        <div className="min-w-[180px]">
          <TrafficPicker
            id="tenant-traffic-scope"
            label="Break down by"
            value={scope}
            options={SCOPES.map((s) => ({ key: s.key, label: s.label }))}
            onChange={(k) => { setScope((k as TrafficScope) ?? 'tenant'); setSubject(null); setHidden(new Set()); }}
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
              onChange={(k) => { setSubject(k); setHidden(new Set()); }}
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
                onClick={() => { setMetric(m.key); setHidden(new Set()); }}
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
            <TrafficChart frame={frame} hidden={hidden} stacked={stacked} />
            <div className="mt-3">
              <TrafficSummaryTable
                frame={frame}
                hidden={hidden}
                subjectLabel={scopeMeta.subjectLabel}
                onToggle={(key) => setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key); else next.add(key);
                  return next;
                })}
              />
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <Gauge size={12} /> Times shown in your own timezone ({utcOffsetLabel()}).
            </p>
          </>
        )}
      </div>
    </div>
  );
}
