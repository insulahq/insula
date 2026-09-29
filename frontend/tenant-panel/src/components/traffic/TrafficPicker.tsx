/**
 * A searchable picker for a traffic scope or subject.
 *
 * Generic rather than tenant-specific (`ui/SearchableTenantSelect` already
 * covers that case) because the same control lists nodes, tenants, pods and
 * routes. Entries carry the metric they are being ranked by, so the list is a
 * ranking — you can see which tenant is the busiest before choosing one,
 * rather than picking blind from an alphabetical list.
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

export interface TrafficPickerProps {
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

export default function TrafficPicker({
  id, label, value, options, onChange, placeholder = 'Search…', allLabel, loading, disabled,
}: TrafficPickerProps) {
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
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const display = selected?.label ?? (allLabel ?? placeholder);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
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
            'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm',
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
            className="absolute z-20 mt-1 max-h-72 w-full min-w-[280px] overflow-hidden rounded-md border
              border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
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
                      'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm',
                      'hover:bg-gray-50 dark:hover:bg-gray-700/60',
                      o.key === value && 'bg-brand-50 dark:bg-brand-950/40',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{o.label}</span>
                    {o.meta && (
                      <span className="shrink-0 tabular-nums text-xs text-gray-500 dark:text-gray-400">{o.meta}</span>
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
