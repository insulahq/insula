/**
 * Small building blocks shared by the tenant page's tabs, so every card,
 * meter and badge on it reads the same.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

const CHIP: Record<Tone, string> = {
  neutral: 'border border-gray-200 text-gray-700 dark:border-gray-600 dark:text-gray-300',
  ok: 'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  warn: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  bad: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  info: 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300',
};

export function Chip({ tone = 'neutral', dot = false, children, title, testId }: {
  readonly tone?: Tone;
  readonly dot?: boolean;
  readonly children: ReactNode;
  readonly title?: string;
  readonly testId?: string;
}) {
  return (
    <span
      className={clsx('inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium', CHIP[tone])}
      title={title}
      data-testid={testId}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Card({ title, actions, children, className, bodyClassName, testId, id }: {
  readonly title?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly testId?: string;
  readonly id?: string;
}) {
  return (
    <section
      id={id}
      className={clsx('min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800', className)}
      data-testid={testId}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-5 py-3.5 dark:border-gray-700">
          {typeof title === 'string'
            ? <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
            : title}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName ?? 'p-5'}>{children}</div>
    </section>
  );
}

export function Meter({ pct, tone, label }: { readonly pct: number | null; readonly tone?: Tone; readonly label?: string }) {
  const v = pct == null || !Number.isFinite(pct) ? 0 : Math.max(0, Math.min(100, pct));
  const t = tone ?? (v >= 90 ? 'bad' : v >= 80 ? 'warn' : 'info');
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <div
        className={clsx('h-full rounded-full', {
          'bg-brand-500 dark:bg-brand-400': t === 'info' || t === 'neutral',
          'bg-green-600 dark:bg-green-500': t === 'ok',
          'bg-amber-500': t === 'warn',
          'bg-red-600 dark:bg-red-500': t === 'bad',
        })}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}

/**
 * A figure with an optional meter. With `to` the whole tile is a link to
 * where the figure is acted on.
 */
export function UsageTile({ label, value, of, pct, note, noteTone, to, testId }: {
  readonly label: string;
  readonly value: ReactNode;
  readonly of?: ReactNode;
  readonly pct?: number | null;
  readonly note?: ReactNode;
  readonly noteTone?: Tone;
  readonly to?: string;
  readonly testId?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2 text-[13px] font-medium text-gray-600 dark:text-gray-400">
        <span>{label}</span>
        <span className="inline-flex items-center gap-0.5">
          {pct != null && Number.isFinite(pct) && `${Math.round(pct)}%`}
          {to && <ChevronRight size={14} aria-hidden="true" />}
        </span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">{value}</span>
        {of && <span className="text-[13px] text-gray-500 dark:text-gray-400">{of}</span>}
      </div>
      {pct !== undefined && <div className="mt-2.5"><Meter pct={pct} /></div>}
      {note && (
        <div className={clsx('mt-2 text-xs', noteTone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400')}>
          {note}
        </div>
      )}
    </>
  );
  const cls = 'block min-w-0 rounded-xl border border-gray-200 bg-white px-4 py-4 shadow-sm dark:border-gray-700 dark:bg-gray-800';
  return to
    ? <Link to={to} className={clsx(cls, 'hover:border-brand-500 hover:ring-1 hover:ring-brand-500 dark:hover:border-brand-400')} data-testid={testId}>{body}</Link>
    : <div className={cls} data-testid={testId}>{body}</div>;
}

export function KV({ rows }: { readonly rows: ReadonlyArray<readonly [ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-x-4 gap-y-3 text-[13px]">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-gray-500 dark:text-gray-400">{k}</dt>
          <dd className="min-w-0 break-words text-gray-900 dark:text-gray-100">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A small "see more" link to another admin page or tab. */
export function GoLink({ to, children, testId }: { readonly to: string; readonly children: ReactNode; readonly testId?: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:underline dark:text-brand-400" data-testid={testId}>
      {children} <ChevronRight size={14} aria-hidden="true" />
    </Link>
  );
}

export function formatGb(gb: number | null | undefined, digits = 1): string {
  if (gb == null || !Number.isFinite(gb)) return '—';
  if (gb >= 1000) return `${(gb / 1000).toFixed(digits)} TB`;
  if (gb < 1) return `${Math.round(gb * 1000)} MB`;
  return `${gb.toFixed(digits)} GB`;
}

export function formatMb(mb: number | null | undefined): string {
  if (mb == null || !Number.isFinite(mb)) return '—';
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${Math.round(mb)} MB`;
}
