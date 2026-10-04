/**
 * A searchable picker: type to filter, each entry with right-aligned
 * secondary text (a metric, a status, a count).
 *
 * Born for the Traffic tab (nodes, tenants, pods, routes ranked by the metric
 * on screen); also the Recover Tenant tenant and target-node pickers. Search
 * matches the label and the secondary text.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2, Search } from 'lucide-react';
import clsx from 'clsx';

export interface PickerOption {
  readonly key: string;
  readonly label: string;
  /** Right-aligned secondary text — usually the metric total. */
  readonly meta?: string;
}

export interface SearchablePickerProps {
  readonly id: string;
  readonly label: string;
  readonly value: string | null;
  readonly options: readonly PickerOption[];
  readonly onChange: (key: string | null) => void;
  readonly placeholder?: string;
  /** Adds an entry that clears the selection. */
  readonly allLabel?: string;
  readonly loading?: boolean;
  readonly disabled?: boolean;
}

export default function SearchablePicker({
  id, label, value, options, onChange, placeholder = 'Search…', allLabel, loading, disabled,
}: SearchablePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const selected = options.find((o) => o.key === value) ?? null;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Filter on the TYPED query only. Filtering on the displayed value means
    // that once something is selected the list collapses to one entry and the
    // control looks broken.
    return q ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.meta ?? '').toLowerCase().includes(q)) : options;
  }, [options, query]);

  const display = selected?.label ?? (allLabel ?? placeholder);

  return (
    <div className="relative flex min-w-0 flex-col gap-[5px]">
      <label htmlFor={id} className="whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.1em] text-gray-500 dark:text-gray-400">
        {label}
      </label>
      <div ref={boxRef} className="relative">
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => { if (!disabled) { setQuery(''); setOpen((o) => !o); } }}
          className={clsx(
            // min-width, not full-width: the control sizes to its content
            // within a wrapping row instead of stretching to fill it.
            'flex w-full min-w-[232px] items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[13px]',
            'border-gray-300 bg-white text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100',
            disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-gray-400 dark:hover:border-gray-500',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{display}</span>
          {loading
            ? <Loader2 size={14} className="animate-spin text-gray-400" />
            : <ChevronDown size={14} className="shrink-0 text-gray-400" />}
        </button>

        {open && (
          <div
            className="absolute z-20 mt-1 max-h-72 w-max min-w-full max-w-[460px] overflow-hidden rounded-lg
              border border-gray-300 bg-white shadow-lg dark:border-gray-600 dark:bg-gray-800"
            role="listbox"
          >
            <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 dark:border-gray-700">
              <Search size={14} className="text-gray-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={placeholder}
                className="w-full bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400
                  dark:text-gray-100"
              />
            </div>
            <ul className="max-h-60 overflow-y-auto overscroll-contain
              [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5
              [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300
              dark:[&::-webkit-scrollbar-thumb]:bg-gray-600"
            >
              {loading && (
                <li className="flex items-center gap-2 px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </li>
              )}
              {!loading && allLabel && (
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === null}
                    onClick={() => { onChange(null); setOpen(false); }}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm
                      hover:bg-gray-50 dark:hover:bg-gray-700/60"
                  >
                    <span className="text-gray-900 dark:text-gray-100">{allLabel}</span>
                  </button>
                </li>
              )}
              {!loading && shown.map((o) => (
                <li key={o.key}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.key === value}
                    onClick={() => { onChange(o.key); setOpen(false); }}
                    className={clsx(
                      'flex w-full items-center justify-between gap-[18px] whitespace-nowrap rounded px-2.5 py-1.5',
                      'text-left text-[13px] hover:bg-brand-50 hover:text-brand-500',
                      'dark:hover:bg-brand-950 dark:hover:text-brand-300',
                      o.key === value && 'bg-brand-50 text-brand-500 dark:bg-brand-950 dark:text-brand-300',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.meta && (
                      <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-gray-500 dark:text-gray-400">
                        {o.meta}
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {!loading && shown.length === 0 && (
                <li className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">No match.</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
