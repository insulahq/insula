/**
 * Time range: presets plus an explicit from/to.
 *
 * One control for both ends. Two separate date fields let you set a `to`
 * earlier than the `from` and only find out when the chart errors; here the
 * pair is committed together and validated before it is applied.
 *
 * Every instant shown and entered is in the reader's own zone. The API speaks
 * ISO-8601 with an offset, so the conversion happens once, at the boundary.
 */

import { useEffect, useRef, useState } from 'react';
import { Clock, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { utcOffsetLabel } from '@/lib/format-traffic';

export interface RangeValue {
  readonly from: Date;
  readonly to: Date;
  /** Preset key, or null when the range was typed in. */
  readonly preset: string | null;
}

interface Preset {
  readonly key: string;
  readonly label: string;
  readonly hours: number;
}

export const RANGE_PRESETS: readonly Preset[] = [
  { key: '1h', label: 'Last hour', hours: 1 },
  { key: '6h', label: 'Last 6 hours', hours: 6 },
  { key: '24h', label: 'Last 24 hours', hours: 24 },
  { key: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { key: '30d', label: 'Last 30 days', hours: 24 * 30 },
  { key: '90d', label: 'Last 90 days', hours: 24 * 90 },
  { key: '1y', label: 'Last 12 months', hours: 24 * 365 },
];

export function presetRange(key: string, now: Date = new Date()): RangeValue {
  const p = RANGE_PRESETS.find((x) => x.key === key) ?? RANGE_PRESETS[2];
  return { from: new Date(now.getTime() - p.hours * 3_600_000), to: now, preset: p.key };
}

/** `YYYY-MM-DDTHH:mm` in LOCAL time, which is what a datetime-local wants. */
export function toLocalInput(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function labelFor(v: RangeValue): string {
  const preset = RANGE_PRESETS.find((p) => p.key === v.preset);
  if (preset) return preset.label;
  const fmt = (d: Date): string => d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return `${fmt(v.from)} → ${fmt(v.to)}`;
}

export interface TrafficRangePickerProps {
  readonly value: RangeValue;
  readonly onChange: (v: RangeValue) => void;
}

export default function TrafficRangePicker({ value, onChange }: TrafficRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(() => toLocalInput(value.from));
  const [draftTo, setDraftTo] = useState(() => toLocalInput(value.to));
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraftFrom(toLocalInput(value.from));
    setDraftTo(toLocalInput(value.to));
  }, [value.from, value.to]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const applyCustom = (): void => {
    const from = new Date(draftFrom);
    const to = new Date(draftTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      setError('Enter both a start and an end.');
      return;
    }
    if (to <= from) {
      setError('The end must be after the start.');
      return;
    }
    setError(null);
    onChange({ from, to, preset: null });
    setOpen(false);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        Time range
      </span>
      <div ref={boxRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="traffic-range-button"
          className="flex w-full items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2
            text-left text-sm text-gray-900 hover:border-gray-400 dark:border-gray-600 dark:bg-gray-800
            dark:text-gray-100 dark:hover:border-gray-500"
        >
          <Clock size={14} className="shrink-0 text-gray-400" />
          <span className="min-w-0 flex-1 truncate">{labelFor(value)}</span>
          <span className="shrink-0 text-[10px] text-gray-400">{utcOffsetLabel()}</span>
          <ChevronDown size={14} className="shrink-0 text-gray-400" />
        </button>

        {open && (
          <div className="absolute z-20 mt-1 w-[320px] rounded-md border border-gray-200 bg-white p-3
            shadow-lg dark:border-gray-700 dark:bg-gray-800"
          >
            <div className="grid grid-cols-2 gap-1">
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => { setError(null); onChange(presetRange(p.key)); setOpen(false); }}
                  className={clsx(
                    'rounded px-2 py-1.5 text-left text-sm',
                    p.key === value.preset
                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300'
                      : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/60',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-700">
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  From
                  <input
                    type="datetime-local"
                    value={draftFrom}
                    onChange={(e) => setDraftFrom(e.target.value)}
                    className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm
                      text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  To
                  <input
                    type="datetime-local"
                    value={draftTo}
                    onChange={(e) => setDraftTo(e.target.value)}
                    className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm
                      text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  />
                </label>
              </div>
              {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
              <button
                type="button"
                onClick={applyCustom}
                className="mt-2 w-full rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white
                  hover:bg-brand-700"
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
