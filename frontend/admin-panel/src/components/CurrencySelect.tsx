import { useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import { COMMON_CURRENCIES } from '@/lib/format-currency';

/**
 * Every ISO 4217 code the runtime knows, searchable.
 *
 * The picker used to be a 15-entry `<select>` of the currencies somebody
 * thought were likely, with an inert `__custom__` row for anything else — so a
 * platform billing in, say, MXN or KES could see its own currency listed as
 * "Custom" and could not select it at all from the UI. `Intl.supportedValuesOf`
 * returns the full set (300+), and `Intl.DisplayNames` gives each one a name,
 * so the list needs no maintenance as codes come and go.
 *
 * The familiar handful stays pinned at the top: a complete list is only an
 * improvement if the common case is still one click.
 */
function currencyName(code: string, display?: Intl.DisplayNames): string {
  try {
    const name = display?.of(code);
    return name && name !== code ? `${code} — ${name}` : code;
  } catch {
    return code;
  }
}

function buildCurrencyGroups(): Record<string, Array<{ code: string; label: string }>> {
  let display: Intl.DisplayNames | undefined;
  try {
    display = new Intl.DisplayNames(['en'], { type: 'currency' });
  } catch {
    display = undefined;
  }

  const all: string[] = (() => {
    try {
      // Node 18+ and all modern browsers (Chrome 99+, Safari 15.4+, Firefox 106+).
      const fn = (Intl as unknown as { supportedValuesOf?: (kind: string) => string[] }).supportedValuesOf;
      if (typeof fn === 'function') return fn('currency').slice().sort();
    } catch {
      // Fall through to the pinned set.
    }
    // Defensive fallback if the runtime lacks Intl.supportedValuesOf: at
    // minimum guarantee the common set so the UI never renders empty.
    return COMMON_CURRENCIES.map((c) => c.code);
  })();

  const common = COMMON_CURRENCIES.map((c) => ({ code: c.code, label: c.label }));
  const commonCodes = new Set(common.map((c) => c.code));
  const rest = all
    .filter((code) => !commonCodes.has(code))
    .map((code) => ({ code, label: currencyName(code, display) }));

  return { Common: common, 'All currencies': rest };
}

const CURRENCY_GROUPS = buildCurrencyGroups();

interface CurrencySelectProps {
  value: string;
  onChange: (code: string) => void;
  placeholder?: string;
  className?: string;
}

export default function CurrencySelect({
  value,
  onChange,
  placeholder = 'Select currency...',
  className = '',
}: CurrencySelectProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return CURRENCY_GROUPS;
    const q = search.toLowerCase();
    const result: Record<string, Array<{ code: string; label: string }>> = {};
    for (const [group, entries] of Object.entries(CURRENCY_GROUPS)) {
      // Search the label, not just the code: an admin who knows "rand" but not
      // "ZAR" should still find it.
      const filtered = entries.filter((c) => c.label.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
      if (filtered.length) result[group] = filtered;
    }
    return result;
  }, [search]);

  const selectedLabel = useMemo(() => {
    for (const entries of Object.values(CURRENCY_GROUPS)) {
      const hit = entries.find((c) => c.code === value);
      if (hit) return hit.label;
    }
    // A code the runtime does not know still shows as itself rather than
    // silently reading as unset.
    return value || placeholder;
  }, [value, placeholder]);

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-left text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-600"
        data-testid="currency-select-button"
      >
        {selectedLabel}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 w-full max-h-72 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg flex flex-col">
            <div className="p-2 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-2 py-1">
                <Search size={14} className="text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by code or name..."
                  className="flex-1 bg-transparent text-sm text-gray-900 dark:text-gray-100 outline-none placeholder:text-gray-400"
                  autoFocus
                  data-testid="currency-select-search"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {Object.entries(filteredGroups).map(([group, entries]) => (
                <div key={group}>
                  <div className="px-3 py-1 text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider bg-gray-50 dark:bg-gray-700/50 sticky top-0">
                    {group}
                  </div>
                  {entries.map((c) => (
                    <button
                      key={`${group}-${c.code}`}
                      type="button"
                      onClick={() => { onChange(c.code); setOpen(false); setSearch(''); }}
                      className={`w-full px-3 py-1.5 text-sm text-left hover:bg-brand-50 dark:hover:bg-brand-900/20 ${
                        c.code === value
                          ? 'text-brand-600 dark:text-brand-400 font-medium bg-brand-50/50 dark:bg-brand-900/10'
                          : 'text-gray-700 dark:text-gray-300'
                      }`}
                      data-testid={`currency-option-${c.code}`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              ))}
              {Object.keys(filteredGroups).length === 0 && (
                <p className="px-3 py-4 text-sm text-gray-400 text-center">No currencies match &quot;{search}&quot;</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
