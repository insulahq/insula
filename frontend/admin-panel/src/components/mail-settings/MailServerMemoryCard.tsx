import { useMemo, useState, type MouseEvent } from 'react';
import { AlertTriangle, Loader2, MemoryStick } from 'lucide-react';
import type { MailServerMemoryPoint, MailServerMemoryResponse } from '@insula/api-contracts';
import MailSectionCard from '@/components/MailSectionCard';
import ErrorPanel from '@/components/ErrorPanel';
import { useMailServerMemory } from '@/hooks/use-mail-server-memory';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { formatVolumeBytes } from '@/lib/format-bytes';
import { formatLocalInstant, formatTimestamp } from '@/lib/format-timestamp';

/**
 * Email → Settings: Stalwart's process memory against its container limit,
 * with the last 7 days as hourly peaks.
 *
 * Stalwart's heap grows over days until the kernel OOM-kills it at the limit
 * (ADR-046), so the shape of the week matters more than the number now: a
 * steady climb means a kill is coming, a single spike means something else.
 * The graph is scaled to the limit, so its top edge is where the kill
 * happens, and the dashed line is where the `stalwart-memory-near-limit`
 * alert fires.
 *
 * Backend: GET /admin/mail/server/memory (mail-admin/stalwart-memory.ts).
 */

const CHART_W = 600;
const CHART_H = 72;
/** Above this share of the limit the next allocation burst can be the kill. */
const CRITICAL_RATIO = 0.95;

type Level = 'ok' | 'warning' | 'critical';

export function memoryLevel(ratio: number | null, alertRatio: number | null): Level {
  if (ratio === null) return 'ok';
  if (ratio >= CRITICAL_RATIO) return 'critical';
  if (alertRatio !== null && ratio >= alertRatio) return 'warning';
  return 'ok';
}

const LEVEL_BAR: Record<Level, string> = {
  ok: 'bg-emerald-500 dark:bg-emerald-400',
  warning: 'bg-amber-500 dark:bg-amber-400',
  critical: 'bg-red-500 dark:bg-red-400',
};

const LEVEL_TEXT: Record<Level, string> = {
  ok: 'text-gray-900 dark:text-gray-100',
  warning: 'text-amber-700 dark:text-amber-300',
  critical: 'text-red-700 dark:text-red-300',
};

/** A bucket is labelled by the end of its hour; this names the whole hour ("… 07:00–08:00"). */
export function hourLabel(endEpoch: number, stepSeconds: number): string {
  const end = formatTimestamp(new Date(endEpoch * 1000));
  return `${formatTimestamp(new Date((endEpoch - stepSeconds) * 1000))}–${end.slice(-5)}`;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)} %`;
}

function ratioOf(bytes: number | null, limit: number | null): number | null {
  return bytes !== null && limit !== null && limit > 0 ? bytes / limit : null;
}

/** Width of the tick drawn for an hour with no measured neighbour, in chart units. */
const TICK_W = 10;

/**
 * Polylines for the measured runs; an unmeasured hour breaks the line. A run
 * of one hour (the first hour after metrics start, or an hour between gaps)
 * would be a one-point polyline, which draws nothing, so it becomes a short
 * horizontal tick at its value.
 */
export function chartSegments(points: ReadonlyArray<MailServerMemoryPoint>, ceiling: number): string[] {
  const n = points.length;
  const segments: string[] = [];
  let run: Array<readonly [number, number]> = [];
  const flush = () => {
    if (run.length === 1) {
      // Centred on the hour, shifted inward at an edge so it keeps its full
      // width: the newest hour always sits on the right edge.
      const [x, y] = run[0];
      const x0 = Math.min(Math.max(0, x - TICK_W / 2), CHART_W - TICK_W);
      run = [[x0, y], [x0 + TICK_W, y]];
    }
    if (run.length > 0) segments.push(run.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
    run = [];
  };
  points.forEach((p, i) => {
    if (p.bytes === null) {
      flush();
      return;
    }
    const x = (i / Math.max(1, n - 1)) * CHART_W;
    const y = CHART_H - Math.min(1, p.bytes / ceiling) * (CHART_H - 2) - 1;
    run.push([x, y]);
  });
  flush();
  return segments;
}

export default function MailServerMemoryCard() {
  const q = useMailServerMemory();
  const data = q.data?.data;

  let summary: string;
  if (q.isLoading) summary = 'Loading…';
  else if (q.isError || !data) summary = 'Unavailable';
  else if (!data.available) summary = 'No samples yet';
  else summary = summaryLine(data);

  return (
    <MailSectionCard
      icon={MemoryStick}
      title="Mail server memory"
      summary={summary}
      dataTestId="mail-section-memory"
      storageKey="mail-memory"
      defaultOpen
    >
      {q.isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading mail-server memory…
        </div>
      )}
      {q.isError && (
        <ErrorPanel error={extractOperatorError(q.error)} onRetry={() => void q.refetch()} retryPending={q.isFetching} testId="mail-memory-error" />
      )}
      {data && !data.available && (
        <p
          className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 text-sm text-gray-500 dark:text-gray-400"
          data-testid="mail-memory-unavailable"
        >
          {data.reason}
        </p>
      )}
      {data?.available && <MemoryBody data={data} />}
    </MailSectionCard>
  );
}

function summaryLine(data: MailServerMemoryResponse): string {
  const ratio = ratioOf(data.currentBytes, data.limitBytes);
  const now = data.currentBytes === null ? 'no current sample' : formatVolumeBytes(data.currentBytes);
  const limit = data.limitBytes === null ? '' : ` of ${formatVolumeBytes(data.limitBytes)}`;
  const share = ratio === null ? '' : ` (${percent(ratio)})`;
  return `${now}${limit}${share} • 7-day peak ${formatVolumeBytes(data.peakBytes)}`;
}

function MemoryBody({ data }: { readonly data: MailServerMemoryResponse }) {
  const ratio = ratioOf(data.currentBytes, data.limitBytes);
  const level = memoryLevel(ratio, data.alertRatio);
  const peakRatio = ratioOf(data.peakBytes, data.limitBytes);

  return (
    <div className="space-y-3" data-testid="mail-memory-body">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="text-sm text-gray-500 dark:text-gray-400">
          <span className={`text-2xl font-semibold tabular-nums ${LEVEL_TEXT[level]}`} data-testid="mail-memory-current">
            {data.currentBytes === null ? 'No current sample' : formatVolumeBytes(data.currentBytes)}
          </span>
          {data.limitBytes !== null && (
            <span className="ml-2" data-testid="mail-memory-limit">
              of {formatVolumeBytes(data.limitBytes)} limit{ratio !== null && ` · ${percent(ratio)}`}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400" data-testid="mail-memory-peak">
          7-day peak {formatVolumeBytes(data.peakBytes)}{peakRatio !== null && ` (${percent(peakRatio)})`}
        </div>
      </div>

      {ratio !== null && (
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"
          role="meter"
          aria-label="Mail server memory used of its limit"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
        >
          <div className={`h-full ${LEVEL_BAR[level]}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
      )}

      <MemoryChart data={data} />

      {data.lastOomKill && (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300" data-testid="mail-memory-last-oom">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {data.lastOomKill.inferred
            ? `Last killed at ${formatLocalInstant(data.lastOomKill.at)}, most likely for running out of memory (the system reported only a forced stop).`
            : `Last killed for running out of memory at ${formatLocalInstant(data.lastOomKill.at)}.`}
        </p>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Process memory only: the mail store&apos;s disk cache is left out, because the kernel frees it before it kills
        anything. Network buffers also count toward the limit but are not in this figure; they are usually tens of MB, so
        the kill can come a little before 100 %. At the limit Stalwart is killed and restarts, dropping every open mail
        connection.
      </p>
    </div>
  );
}

function MemoryChart({ data }: { readonly data: MailServerMemoryResponse }) {
  const [hover, setHover] = useState<number | null>(null);
  const ceiling = data.limitBytes ?? (data.peakBytes !== null ? data.peakBytes * 1.1 : 1);
  const segments = useMemo(() => chartSegments(data.points, ceiling), [data.points, ceiling]);
  const n = data.points.length;
  // An override above 100 % would put the line off the chart: pin it to the top.
  const alertY = data.alertRatio !== null && data.limitBytes !== null
    ? CHART_H - Math.min(1, data.alertRatio) * (CHART_H - 2) - 1
    : null;
  const hasHistory = data.points.some((p) => p.bytes !== null);

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || n === 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    setHover(Math.round(frac * (n - 1)));
  };

  const hovered = hover !== null ? data.points[hover] : null;
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px] text-gray-500 dark:text-gray-400" data-testid="mail-memory-chart-readout">
        <span>
          {hovered
            ? `${hourLabel(hovered.t, data.stepSeconds)} · ${hovered.bytes === null ? 'no sample' : formatVolumeBytes(hovered.bytes)}`
            : 'Last 7 days, highest value per hour'}
        </span>
        {data.limitBytes !== null && <span>limit {formatVolumeBytes(data.limitBytes)}</span>}
      </div>
      <div
        className="relative h-[72px] w-full cursor-crosshair rounded border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label={`Mail server memory over the last 7 days, peak ${formatVolumeBytes(data.peakBytes)}`}
          data-testid="mail-memory-chart"
        >
          {alertY !== null && (
            <line
              x1={0} x2={CHART_W} y1={alertY} y2={alertY}
              className="stroke-amber-500 dark:stroke-amber-400"
              strokeWidth={1}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
              data-testid="mail-memory-alert-line"
            />
          )}
          {segments.map((pts, i) => (
            <polyline
              key={i}
              points={pts}
              fill="none"
              className="stroke-brand-500 dark:stroke-brand-400"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              data-testid="mail-memory-line"
            />
          ))}
          {hover !== null && (
            <line
              x1={(hover / Math.max(1, n - 1)) * CHART_W}
              x2={(hover / Math.max(1, n - 1)) * CHART_W}
              y1={0} y2={CHART_H}
              className="stroke-gray-400 dark:stroke-gray-500"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {!hasHistory && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-gray-400 dark:text-gray-500">
            The graph fills in hour by hour.
          </span>
        )}
        {alertY !== null && data.alertRatio !== null && (
          <span
            className="pointer-events-none absolute right-1 text-[10px] leading-none text-amber-700 dark:text-amber-300"
            style={{ top: `calc(${(alertY / CHART_H) * 100}% - 11px)` }}
          >
            alert {percent(data.alertRatio)}
          </span>
        )}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-gray-400 dark:text-gray-500">
        <span>7 days ago</span>
        <span>now</span>
      </div>
    </div>
  );
}
