/**
 * Time range: one control for both ends.
 *
 * A preset list, two months of calendar, a time for each end, and the
 * resulting duration — committed together. Two separate date fields let you
 * set a `to` earlier than the `from` and only find out when the chart errors;
 * here the pair is validated before it is applied, and the duration tells you
 * what you are about to ask for before you ask for it.
 *
 * Every instant shown and entered is in the reader's own zone; the API speaks
 * ISO-8601, so the conversion happens once, at the boundary.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import clsx from 'clsx';
import { utcOffsetLabel } from '@/lib/format-traffic';

export interface RangeValue {
  readonly from: Date;
  readonly to: Date;
  /** Preset key, or null when the range was chosen by hand. */
  readonly preset: string | null;
}

interface Preset { readonly key: string; readonly label: string; readonly hours: number }

export const RANGE_PRESETS: readonly Preset[] = [
  { key: '1h', label: 'Last hour', hours: 1 },
  { key: '6h', label: 'Last 6 hours', hours: 6 },
  { key: '24h', label: 'Last 24 hours', hours: 24 },
  { key: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { key: '30d', label: 'Last 30 days', hours: 24 * 30 },
  { key: '90d', label: 'Last 90 days', hours: 24 * 90 },
  { key: '1y', label: 'Last 12 months', hours: 24 * 365 },
];

/** Beyond this, only the daily rollup survives — the label says so. */
const FINE_RETENTION_HOURS = 24 * 30;

export function presetRange(key: string, now: Date = new Date()): RangeValue {
  const p = RANGE_PRESETS.find((x) => x.key === key) ?? RANGE_PRESETS[2];
  return { from: new Date(now.getTime() - p.hours * 3_600_000), to: now, preset: p.key };
}

/** `HH:mm` in LOCAL time. */
function toTimeInput(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/** Every cell of a month grid, padded to whole weeks (Monday first). */
function monthGrid(month: Date): Array<{ date: Date; inMonth: boolean }> {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  const start = new Date(first);
  start.setDate(first.getDate() - lead);
  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    return { date, inMonth: date.getMonth() === month.getMonth() };
  });
}

export function durationLabel(from: Date, to: Date): string {
  const mins = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  if (mins < 90) return `${mins} min`;
  const hours = mins / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} hours`;
  const days = hours / 24;
  return days < 60 ? `${days.toFixed(days < 10 ? 1 : 0)} days` : `${(days / 30).toFixed(1)} months`;
}

function fmtInstant(d: Date): string {
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export interface TrafficRangePickerProps {
  readonly value: RangeValue;
  readonly onChange: (v: RangeValue) => void;
}

export default function TrafficRangePicker({ value, onChange }: TrafficRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState<Date>(value.from);
  const [draftTo, setDraftTo] = useState<Date>(value.to);
  const [fromTime, setFromTime] = useState(() => toTimeInput(value.from));
  const [toTime, setToTime] = useState(() => toTimeInput(value.to));
  const [leftMonth, setLeftMonth] = useState(() => addMonths(value.to, -1));
  const [pickingEnd, setPickingEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraftFrom(value.from);
    setDraftTo(value.to);
    setFromTime(toTimeInput(value.from));
    setToTime(toTimeInput(value.to));
  }, [value.from, value.to]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const months = useMemo(() => [leftMonth, addMonths(leftMonth, 1)], [leftMonth]);
  const coarse = (draftTo.getTime() - draftFrom.getTime()) / 3_600_000 > FINE_RETENTION_HOURS;

  const withTime = (day: Date, hhmm: string): Date => {
    const [h, m] = hhmm.split(':').map(Number);
    const d = startOfDay(day);
    d.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0);
    return d;
  };

  const clickDay = (day: Date): void => {
    setError(null);
    if (!pickingEnd) {
      setDraftFrom(withTime(day, fromTime));
      setDraftTo(withTime(day, toTime));
      setPickingEnd(true);
      return;
    }
    const candidate = withTime(day, toTime);
    if (candidate < draftFrom) {
      // Clicking before the start restarts the selection rather than
      // producing an inverted range nobody asked for.
      setDraftFrom(withTime(day, fromTime));
      setDraftTo(withTime(day, toTime));
      setPickingEnd(true);
      return;
    }
    setDraftTo(candidate);
    setPickingEnd(false);
  };

  const apply = (): void => {
    const from = withTime(draftFrom, fromTime);
    const to = withTime(draftTo, toTime);
    if (to <= from) { setError('The end must be after the start.'); return; }
    setError(null);
    onChange({ from, to, preset: null });
    setOpen(false);
  };

  const presetLabel = RANGE_PRESETS.find((p) => p.key === value.preset)?.label;

  return (
    <div className="relative flex min-w-0 flex-col gap-[5px]">
      <span className="whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.1em]
        text-gray-500 dark:text-gray-400"
      >
        Time range
      </span>
      <div ref={boxRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="traffic-range-button"
          className="inline-flex w-full items-center gap-[9px] whitespace-nowrap rounded-[7px] border
            border-gray-300 bg-white px-[11px] py-1.5 text-[13px] text-gray-900 hover:border-brand-500
            dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        >
          <Clock size={13} className="shrink-0 text-gray-400" />
          {presetLabel && <span className="font-semibold text-brand-600 dark:text-brand-400">{presetLabel}</span>}
          <span className="tabular-nums">{fmtInstant(value.from)} → {fmtInstant(value.to)}</span>
          {coarse && <span className="font-semibold text-amber-600 dark:text-amber-400">daily rollup</span>}
          <ChevronDown size={13} className="ml-auto shrink-0 text-gray-400" />
        </button>

        {open && (
          <div
            className="absolute left-0 top-[calc(100%+6px)] z-40 flex gap-3.5 rounded-[10px] border
              border-gray-300 bg-white p-3 shadow-xl dark:border-gray-600 dark:bg-gray-800"
            role="dialog"
            aria-label="Choose a time range"
          >
            <div className="flex min-w-[132px] flex-col gap-0.5 border-r border-gray-200 pr-3 dark:border-gray-700">
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  aria-pressed={p.key === value.preset}
                  onClick={() => { setError(null); onChange(presetRange(p.key)); setOpen(false); }}
                  className={clsx(
                    'rounded-md px-2 py-[5px] text-left text-[12.5px]',
                    p.key === value.preset
                      ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700/60 dark:hover:text-gray-100',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div>
              <div className="flex gap-3.5">
                {months.map((m, mi) => (
                  <div key={m.toISOString()} className="w-[210px]">
                    <div className="mb-1.5 flex items-center justify-between">
                      {mi === 0 ? (
                        <button
                          type="button"
                          aria-label="Previous month"
                          onClick={() => setLeftMonth(addMonths(leftMonth, -1))}
                          className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md
                            border border-gray-200 text-gray-600 hover:border-gray-300 dark:border-gray-700 dark:text-gray-300"
                        >
                          <ChevronLeft size={13} />
                        </button>
                      ) : <span className="h-[22px] w-[22px]" />}
                      <span className="text-[12.5px] font-semibold text-gray-900 dark:text-gray-100">
                        {m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                      </span>
                      {mi === 1 ? (
                        <button
                          type="button"
                          aria-label="Next month"
                          onClick={() => setLeftMonth(addMonths(leftMonth, 1))}
                          className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md
                            border border-gray-200 text-gray-600 hover:border-gray-300 dark:border-gray-700 dark:text-gray-300"
                        >
                          <ChevronRight size={13} />
                        </button>
                      ) : <span className="h-[22px] w-[22px]" />}
                    </div>
                    <div className="grid grid-cols-7 gap-px">
                      {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => (
                        <div key={d} className="py-[3px] text-center text-[10px] uppercase tracking-[0.06em]
                          text-gray-500 dark:text-gray-400"
                        >
                          {d}
                        </div>
                      ))}
                      {monthGrid(m).map(({ date, inMonth }) => {
                        const d0 = startOfDay(date).getTime();
                        const f0 = startOfDay(draftFrom).getTime();
                        const t0 = startOfDay(draftTo).getTime();
                        const isStart = d0 === f0;
                        const isEnd = d0 === t0;
                        const inRange = d0 > f0 && d0 < t0;
                        const future = date > new Date();
                        return (
                          <button
                            key={date.toISOString()}
                            type="button"
                            disabled={future}
                            onClick={() => clickDay(date)}
                            className={clsx(
                              'py-[5px] text-[12px] tabular-nums',
                              isStart || isEnd
                                ? 'bg-brand-600 font-semibold text-white'
                                : inRange
                                  ? 'bg-brand-50 dark:bg-brand-950/40'
                                  : 'hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-950/40',
                              isStart && isEnd ? 'rounded-md'
                                : isStart ? 'rounded-l-md' : isEnd ? 'rounded-r-md' : 'rounded-none',
                              !inMonth && 'text-gray-400 opacity-55 dark:text-gray-500',
                              !inMonth && !isStart && !isEnd && 'hover:opacity-100',
                              future && 'cursor-not-allowed opacity-30',
                              !isStart && !isEnd && inMonth && 'text-gray-900 dark:text-gray-100',
                            )}
                          >
                            {date.getDate()}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-2.5 flex items-end gap-2.5">
                <label className="flex flex-col gap-[5px] text-[10.5px] font-semibold uppercase
                  tracking-[0.1em] text-gray-500 dark:text-gray-400"
                >
                  From
                  <input
                    type="time"
                    value={fromTime}
                    onChange={(e) => setFromTime(e.target.value)}
                    className="w-[138px] rounded-md border border-gray-300 bg-white px-2.5 py-1.5
                      text-[13px] font-normal normal-case tracking-normal text-gray-900
                      dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </label>
                <label className="flex flex-col gap-[5px] text-[10.5px] font-semibold uppercase
                  tracking-[0.1em] text-gray-500 dark:text-gray-400"
                >
                  To
                  <input
                    type="time"
                    value={toTime}
                    onChange={(e) => setToTime(e.target.value)}
                    className="w-[138px] rounded-md border border-gray-300 bg-white px-2.5 py-1.5
                      text-[13px] font-normal normal-case tracking-normal text-gray-900
                      dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </label>
                <span className="pb-1.5 text-[11px] text-gray-400">{utcOffsetLabel()}</span>
              </div>

              <div className="mt-2.5 flex items-center justify-between gap-3.5 border-t border-gray-200
                pt-2.5 dark:border-gray-700"
              >
                <span className={clsx(
                  'font-mono text-xs',
                  coarse ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400',
                )}
                >
                  {durationLabel(draftFrom, draftTo)}
                  {coarse && ' · daily rollup beyond 30 days'}
                </span>
                <div className="flex gap-2">
                  {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-[12.5px] text-gray-700
                      hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/60"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={apply}
                    className="rounded-md bg-brand-600 px-3 py-1.5 text-[12.5px] font-medium text-white
                      hover:bg-brand-700"
                  >
                    Apply
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
