/**
 * Monitoring → Traffic.
 *
 * Controls are hidden when they cannot apply rather than greyed out: a
 * direction picker means nothing on a latency chart, and a disabled control
 * is still a thing to read and dismiss. What is on screen is what you can use.
 */

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import clsx from 'clsx';
import type {
  TrafficBackupMode, TrafficDirection, TrafficFrame, TrafficMetric, TrafficScope,
} from '@insula/api-contracts';
import { useTrafficSeries, useTrafficSubjects } from '@/hooks/use-traffic';
import { extractOperatorError } from '@/lib/extract-operator-error';
import ErrorPanel from '@/components/ErrorPanel';
import TrafficChart from './TrafficChart';
import {
  combinedLine, TOTAL_KEY, totalLabel, totalState, trafficStats,
} from './combined-line';
import TrafficStats from './TrafficStats';
import TrafficSummaryTable from './TrafficSummaryTable';
import TrafficPicker from '@/components/ui/SearchablePicker';
import TrafficRangePicker, { presetRange, type RangeValue } from './TrafficRangePicker';
import { formatInstant, formatTrafficRate, formatTrafficVolume } from '@/lib/format-traffic';

/** "24 hours", "7 days" — what the Total tile is a total OVER. */
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
  { key: 'cluster', label: 'Cluster', subjectLabel: 'Measurement' },
  { key: 'node', label: 'Node', subjectLabel: 'Node' },
  { key: 'tenant', label: 'Tenant', subjectLabel: 'Tenant' },
  // The ONLY view that shows internal traffic. Every other scope is what
  // crossed the network; pod counters include the database answering the
  // application inside a namespace, which never leaves the node. Named
  // for that so the two are not compared as if they measured one thing.
  { key: 'pod', label: 'Pod (internal traffic)', subjectLabel: 'Pod' },
  { key: 'route', label: 'Ingress route', subjectLabel: 'Route' },
];

/**
 * Cluster rows left off the CHART until asked for. They stay in the table with
 * their totals: the per-class node-to-node split is the detail under one row
 * already drawn, and the NIC sum counts node-to-node bytes twice — drawn by
 * default it would set the axis and flatten everything that adds up.
 */
const CLUSTER_ROWS_OFF_CHART = [
  'n2n:kubeapi', 'n2n:etcd', 'n2n:kubelet', 'n2n:tunnel', 'n2n:n2nother', 'nic:out', 'nic:in',
] as const;

/**
 * When the cluster split starts later than the NIC sum does: the instant of
 * its first measured point, or null when it covers the whole range.
 */
export function splitStart(frame: TrafficFrame): string | null {
  const n2n = frame.series.find((s) => s.key === 'wire:n2n');
  const nic = frame.series.find((s) => s.key === 'nic:out');
  if (!n2n || !nic) return null;
  const firstSplit = n2n.points.findIndex((v) => v !== null);
  const firstNic = nic.points.findIndex((v) => v !== null);
  if (firstNic === -1) return null;
  if (firstSplit === -1) return frame.to;
  return firstSplit > firstNic ? frame.times[firstSplit] ?? null : null;
}

function initialHidden(): Set<string> {
  return new Set([TOTAL_KEY, ...CLUSTER_ROWS_OFF_CHART]);
}

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
  // The combined line starts OFF: it is there to be asked for, and drawn by
  // default it would set the axis and push every row down to the floor.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(initialHidden);
  const [focus, setFocus] = useState<string | null>(null);
  const resetRows = (): void => { setHidden(initialHidden()); setFocus(null); };

  // Traefik has no per-pod dimension, so those questions are not offered.
  const metricsForScope = metricsFor(scope);
  const effectiveMetric: TrafficMetric = metricsForScope.some((m) => m.key === metric) ? metric : 'traffic';
  // Always separated on a cluster traffic view — no selector, because the
  // split is not an opinion the operator should have to hold.
  const effectiveBackups: TrafficBackupMode = effectiveMetric === 'traffic' && scope === 'cluster'
    ? 'separate'
    : 'included';
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
    // Pods no longer need a tenant first: with none chosen the list is every
    // pod, ranked. Gating it on a tenant is what left the default pod view
    // with an error and no way forward.
    needsSubjectList,
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
  // A breakdown across subjects offers a combined Total; a cluster view does
  // not — its rows are the wire and subsets of it, which do not add up.
  const breakdown = !singleSubject;
  const total = frame ? totalState(frame, hidden, breakdown) : null;
  // Tiles, spike markers, the Total line and each row's share all read this
  // one line, so they cannot disagree. Hiding a row is a way of asking "what
  // does this look like without that", so it follows the rows shown.
  const combined = useMemo(() => (frame ? combinedLine(frame, hidden) : null), [frame, hidden]);
  const stats = useMemo(() => (frame ? trafficStats(frame, hidden) : null), [frame, hidden]);

  const operatorError = error ? extractOperatorError(error) : null;

  return (
    // `p-5` inset, like every other Monitoring tab: the tab strip sits inside
    // a card, and a panel with no padding runs its content into the border.
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-end gap-x-3.5 gap-y-2.5">
        <div className="min-w-[320px]"><TrafficRangePicker value={range} onChange={setRange} /></div>

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
              resetRows();
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
              allLabel="All tenants"
              onChange={(k) => { setSubject(k); setPod(null); resetRows(); }}
            />
          </div>
        )}

        {needsSubjectList && (
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
                resetRows();
              }}
            />
          </div>
        )}

        <Segmented
          label="Metric"
          value={effectiveMetric}
          options={metricsForScope}
          onChange={(m) => { setMetric(m); resetRows(); }}
        />

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

      {frame && scope !== 'cluster' && effectiveBackups !== 'included'
        && !frame.series.some((sx) => sx.kind === 'backup-class') && (
        // Splitting and seeing one lonely "Serving traffic" row is ambiguous:
        // it could mean no backups ran, or that the split is broken. Say which.
        <p className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600
          dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300"
        >
          No platform-scheduled backup traffic in this range.
        </p>
      )}

      {frame && scope === 'cluster' && splitStart(frame) && (
        // The split comes from per-node counters that exist only from the
        // upgrade that added them; before that, the rows that add up are
        // gaps and only the NIC sum reaches back. Say so instead of letting a
        // Total over part of the range pass for all of it.
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800
          dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
        >
          The internet / node-to-node split is measured from {formatInstant(splitStart(frame)!)}. Before that
          only <strong>All NICs</strong> was measured, and it counts traffic between nodes twice.
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
        <TrafficStats stats={[
          {
            key: 'total',
            label: frame.unit === 'milliseconds' ? 'Average' : 'Total',
            value: frame.unit === 'milliseconds'
              ? formatTrafficRate(stats.avg, frame.unit)
              : formatTrafficVolume(stats.total, frame.unit),
            // The rows the Total adds up exist only from the split's start;
            // "over 24 hours" would claim the whole range for them.
            sub: frame.resolution === 'daily'
              ? 'daily rollup'
              : (scope === 'cluster' && splitStart(frame) ? `since ${formatInstant(splitStart(frame)!)}` : `over ${spanLabel(range)}`),
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
          frame.resolution === 'daily'
            ? {
              key: 'resolution',
              label: 'Resolution',
              value: '1 day',
              sub: 'UTC days · spikes averaged out',
              alert: true,
            }
            : {
              key: 'spikes',
              label: 'Spikes flagged',
              value: String(stats.spikes.length),
              sub: stats.spikes.length ? 'click a marker to zoom' : 'none in this range',
              alert: stats.spikes.length > 0,
            },
        ]}
        />
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
                subjectLabel={effectiveBackups === 'included' || scope === 'cluster' ? scopeMeta.subjectLabel : 'Class'}
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
