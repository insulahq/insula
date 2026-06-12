/**
 * SLO tab on the Monitoring page (ADR-051 phase 3).
 *
 * SLI cards + hand-rolled SVG sparklines (repo convention — no chart
 * library) fed by the panel-ID-keyed series proxy. Rule states come
 * from the in-API evaluator; ad-hoc PromQL exploration lives in the
 * admin-gated VMUI (admin.<apex>/metrics/vmui/) — deliberately not here.
 */
import { useQuery } from '@tanstack/react-query';
import { Loader2, AlertTriangle, CheckCircle, Activity, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import { apiFetch } from '@/lib/api-client';
import type { SloStatusResponse, SloSeriesResponse } from '@insula/api-contracts';

const REFRESH_MS = 30_000;

/** Panels rendered as cards, in order. */
const PANELS: ReadonlyArray<{ id: string; label: string; format: (v: number) => string; higherIsBad: boolean }> = [
  { id: 'http-5xx-ratio', label: 'HTTP 5xx ratio (5m)', format: (v) => `${(v * 100).toFixed(2)}%`, higherIsBad: true },
  { id: 'http-p95-seconds', label: 'p95 latency', format: (v) => `${(v * 1000).toFixed(0)} ms`, higherIsBad: true },
  { id: 'cert-min-days', label: 'Cert expiry (min)', format: (v) => `${v.toFixed(0)} d`, higherIsBad: false },
  { id: 'longhorn-usage-ratio', label: 'Longhorn usage (max node)', format: (v) => `${(v * 100).toFixed(0)}%`, higherIsBad: true },
  { id: 'node-memory-ratio', label: 'Node memory (max)', format: (v) => `${(v * 100).toFixed(0)}%`, higherIsBad: true },
  { id: 'cnpg-up', label: 'system-db instances up', format: (v) => `${v.toFixed(0)}`, higherIsBad: false },
  { id: 'flux-errors-15m', label: 'Flux reconcile errors (15m)', format: (v) => `${v.toFixed(0)}`, higherIsBad: true },
  { id: 'acme-renewals-1h', label: 'ACME renewals fired (1h)', format: (v) => `${v.toFixed(0)}`, higherIsBad: true },
];

function useSloStatus() {
  return useQuery({
    queryKey: ['admin-monitoring-slo'],
    queryFn: () => apiFetch<{ data: SloStatusResponse }>('/api/v1/admin/monitoring/slo'),
    refetchInterval: REFRESH_MS,
  });
}

function useSeries(panel: string) {
  return useQuery({
    queryKey: ['admin-monitoring-series', panel],
    queryFn: () => apiFetch<{ data: SloSeriesResponse }>(`/api/v1/admin/monitoring/series?panel=${panel}&minutes=180`),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

/** Tiny dependency-free sparkline. */
function Sparkline({ points, className }: { points: ReadonlyArray<readonly [number, number]>; className?: string }) {
  if (points.length < 2) {
    return <div className="h-8 text-xs text-gray-400 dark:text-gray-500">no data yet</div>;
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const ySpan = yMax - yMin || 1;
  const xSpan = xMax - xMin || 1;
  const path = points
    .map(([x, y]) => `${(((x - xMin) / xSpan) * 100).toFixed(2)},${(30 - ((y - yMin) / ySpan) * 28 + 1).toFixed(2)}`)
    .join(' ');
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className={clsx('h-8 w-full', className)} aria-hidden>
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function PanelCard({ id, label, format }: { id: string; label: string; format: (v: number) => string }) {
  const q = useSeries(id);
  const series = q.data?.data.series ?? [];
  const flat = series.flatMap((s) => s.points);
  const last = flat.length > 0 ? flat[flat.length - 1][1] : null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
        {q.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : last != null ? format(last) : '—'}
      </div>
      <div className="mt-2 text-blue-500 dark:text-blue-400">
        <Sparkline points={series[0]?.points ?? []} />
      </div>
    </div>
  );
}

export default function SloTab() {
  const status = useSloStatus();
  const rules = status.data?.data.rules ?? [];
  const firing = rules.filter((r) => r.state === 'firing');
  const vmReachable = status.data?.data.vmReachable ?? true;

  return (
    <div className="space-y-6">
      {/* Header strip: evaluator + VM health, VMUI link */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <Activity className="h-4 w-4 text-blue-500 dark:text-blue-400" />
          <span className="text-gray-600 dark:text-gray-300">
            SLO evaluation {status.data?.data.lastEvaluationAt
              ? `— last run ${new Date(status.data.data.lastEvaluationAt).toLocaleTimeString()}`
              : '— not yet run'}
          </span>
          {!vmReachable && (
            <span className="inline-flex items-center gap-1 rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
              <AlertTriangle className="h-3 w-3" /> metrics store unreachable
            </span>
          )}
        </div>
        <a
          href="/metrics/vmui/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          Open VMUI <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* Firing alerts banner */}
      {firing.length > 0 ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900/20">
          <div className="mb-2 flex items-center gap-2 font-medium text-red-800 dark:text-red-200">
            <AlertTriangle className="h-4 w-4" /> {firing.length} SLO alert{firing.length > 1 ? 's' : ''} firing
          </div>
          <ul className="space-y-1 text-sm text-red-700 dark:text-red-300">
            {firing.map((r) => (
              <li key={r.id}>
                <span className="font-medium">[{r.severity}] {r.name}</span>
                {r.lastValue != null && <span> — value {r.lastValue}</span>}
                {r.since && <span className="text-red-500 dark:text-red-400"> since {new Date(r.since).toLocaleString()}</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300">
          <CheckCircle className="h-4 w-4" /> All SLO rules healthy
        </div>
      )}

      {/* SLI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PANELS.map((p) => (
          <PanelCard key={p.id} id={p.id} label={p.label} format={p.format} />
        ))}
      </div>

      {/* Rule table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Rule</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Severity</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400">State</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Last value</th>
              <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-gray-400">Evaluated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700/50 dark:bg-gray-900">
            {rules.map((r) => (
              <tr key={r.id} className={clsx(!r.enabled && 'opacity-50')}>
                <td className="px-4 py-2">
                  <div className="font-medium text-gray-900 dark:text-gray-100">{r.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{r.description}</div>
                </td>
                <td className="px-4 py-2">
                  <span className={clsx(
                    'rounded px-2 py-0.5 text-xs font-medium',
                    r.severity === 'critical'
                      ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
                  )}>{r.severity}</span>
                </td>
                <td className="px-4 py-2">
                  {!r.enabled ? (
                    <span className="text-xs text-gray-400 dark:text-gray-500">disabled</span>
                  ) : r.state === 'firing' ? (
                    <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                      <AlertTriangle className="h-3.5 w-3.5" /> firing
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                      <CheckCircle className="h-3.5 w-3.5" /> ok
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-gray-600 dark:text-gray-300">{r.lastValue ?? '—'}</td>
                <td className="px-4 py-2 text-gray-500 dark:text-gray-400">
                  {r.lastEvaluatedAt ? new Date(r.lastEvaluatedAt).toLocaleTimeString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
