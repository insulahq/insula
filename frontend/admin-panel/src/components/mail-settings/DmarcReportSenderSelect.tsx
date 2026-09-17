import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Search, Check, ShieldOff, ChevronDown } from 'lucide-react';
import type { DmarcReportSenderOption } from '@insula/api-contracts';

interface DmarcReportSenderSelectProps {
  readonly options: readonly DmarcReportSenderOption[];
  /** Currently selected address, or null for "reporting off". */
  readonly value: string | null;
  readonly onChange: (address: string | null) => void;
  readonly disabled?: boolean;
}

/**
 * Picks the address outbound DMARC aggregate reports are sent FROM.
 *
 * Filtering is local: the whole list arrives with the mail settings (one
 * postmaster address per email-enabled domain), so there is nothing to debounce
 * and no spinner state that can disagree with what is on screen.
 *
 * Searching matches the tenant and domain as well as the address, because every
 * option's local part is the literal word "postmaster" — a search box that only
 * matched the address would match everything, always.
 */
export default function DmarcReportSenderSelect({
  options,
  value,
  onChange,
  disabled = false,
}: DmarcReportSenderSelectProps) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.address.toLowerCase().includes(q) ||
        o.domainName.toLowerCase().includes(q) ||
        o.tenantName.toLowerCase().includes(q),
    );
  }, [options, query]);

  const selected = options.find((o) => o.address === value) ?? null;

  const choose = useCallback(
    (address: string | null) => {
      onChange(address);
      setQuery('');
      setIsOpen(false);
    },
    [onChange],
  );

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // The selected address can stop being selectable — its tenant gets
  // suspended, or the domain's email is switched off. The backend resets the
  // setting to disabled on its next pass; until then, say so rather than
  // rendering a blank box that reads as "off".
  const selectionIsStale = value !== null && selected === null;

  return (
    <div ref={containerRef} className="relative w-full max-w-md" data-testid="dmarc-sender-select">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-left text-sm text-gray-900 dark:text-gray-100 disabled:cursor-not-allowed disabled:opacity-60 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        data-testid="dmarc-sender-trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="flex min-w-0 items-center gap-2">
          {value === null ? (
            <>
              <ShieldOff size={14} className="shrink-0 text-gray-400" />
              <span className="text-gray-500 dark:text-gray-400">
                Reporting disabled — no reports are sent
              </span>
            </>
          ) : selectionIsStale ? (
            <span className="truncate text-amber-700 dark:text-amber-400">
              {value} — no longer available
            </span>
          ) : (
            <span className="truncate">
              {selected?.address}
              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                {selected?.isSystemTenant ? 'Platform' : selected?.tenantName}
              </span>
            </span>
          )}
        </span>
        <ChevronDown size={14} className="ml-2 shrink-0 text-gray-400" />
      </button>

      {isOpen && (
        <div
          className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
          data-testid="dmarc-sender-dropdown"
          role="listbox"
        >
          <div className="relative border-b border-gray-100 dark:border-gray-700 p-2">
            <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by tenant or domain…"
              className="w-full rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 py-1.5 pl-7 pr-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              data-testid="dmarc-sender-search"
            />
          </div>

          <ul className="max-h-64 overflow-y-auto py-1">
            {/* Disable stays pinned above the search results: it is the safe
                choice and the one an operator reaches for in a hurry, so it
                must never be something you have to search for. */}
            <li>
              <button
                type="button"
                onClick={() => choose(null)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700/50"
                data-testid="dmarc-sender-option-disabled"
                role="option"
                aria-selected={value === null}
              >
                <ShieldOff size={14} className="shrink-0 text-gray-400" />
                <span className="text-gray-700 dark:text-gray-300">Disable DMARC reporting</span>
                {value === null && <Check size={14} className="ml-auto text-brand-600" />}
              </button>
            </li>

            {options.length === 0 && (
              <li
                className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400"
                data-testid="dmarc-sender-no-options"
              >
                No eligible addresses. Reports are sent from a domain's{' '}
                <code className="font-mono">postmaster@</code>, so one active tenant needs a
                mail-enabled domain before reporting can be switched on.
              </li>
            )}

            {options.length > 0 && filtered.length === 0 && (
              <li
                className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400"
                data-testid="dmarc-sender-no-matches"
              >
                No address matches “{query}”.
              </li>
            )}

            {filtered.map((o) => (
              <li key={o.address}>
                <button
                  type="button"
                  onClick={() => choose(o.address)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  data-testid={`dmarc-sender-option-${o.address}`}
                  role="option"
                  aria-selected={o.address === value}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                      {o.address}
                    </span>
                    <span className="truncate text-xs text-gray-500 dark:text-gray-400">
                      {o.isSystemTenant ? 'Platform (system tenant)' : o.tenantName}
                    </span>
                  </span>
                  {o.address === value && (
                    <Check size={14} className="ml-auto shrink-0 text-brand-600" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
