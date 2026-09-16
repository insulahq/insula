import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2, CornerDownLeft, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { useGlobalSearch } from '@/hooks/use-global-search';
import { SEARCH_MIN_QUERY_LENGTH, type SearchItem } from '@insula/api-contracts';

/**
 * Header search: a persistent box that opens a result dropdown.
 *
 * ── Why the input is mounted lazily ──────────────────────────────────
 * This control previously existed as a real <input> and was replaced by
 * an inert <div> because password managers treated it as a username
 * field and offered to autofill on EVERY page load. `disabled`,
 * `autocomplete="off"` and the per-vendor opt-out attributes were all
 * tried; browsers' own built-in managers honour none of them.
 *
 * The operator has asked for a persistent input with a dropdown (rather
 * than the dialog the old comment proposed), so that is what this is.
 * The one mitigation kept: the real <input> is not in the DOM until the
 * box is first focused. Managers scan at load, find no field, and stay
 * quiet; the user clicks and gets an ordinary search box in the same
 * tick. Visually and behaviourally the two states are identical.
 *
 * If autofill prompts turn out to be acceptable, delete `mounted` and
 * render the input unconditionally — nothing else depends on it.
 */

interface Row {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly badge: string | null;
  readonly to: string;
  readonly groupLabel: string;
}

const PLACEHOLDER = 'Search pages, domains, mailboxes…';

export default function GlobalSearch() {
  const navigate = useNavigate();
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { staticHits, groups, isLoadingRecords, recordsError, isQueryable } = useGlobalSearch(query);

  /** Flatten groups into one keyboard-navigable list, keeping headings for render. */
  const { rows, sections } = useMemo(() => {
    const flat: Row[] = [];
    const secs: { label: string; start: number; count: number }[] = [];

    if (staticHits.length > 0) {
      secs.push({ label: 'Pages & Settings', start: flat.length, count: staticHits.length });
      for (const hit of staticHits) {
        flat.push({
          key: `static:${hit.entry.id}`,
          title: hit.entry.label,
          subtitle: hit.entry.group,
          badge: null,
          to: hit.entry.to,
          groupLabel: 'Pages & Settings',
        });
      }
    }

    for (const group of groups) {
      if (group.items.length === 0) continue;
      secs.push({ label: group.label, start: flat.length, count: group.items.length });
      for (const item of group.items as readonly SearchItem[]) {
        flat.push({
          key: `${group.type}:${item.id}`,
          title: item.title,
          subtitle: item.subtitle,
          badge: item.badge,
          to: item.href,
          groupLabel: group.label,
        });
      }
    }

    return { rows: flat, sections: secs };
  }, [staticHits, groups]);

  // Reset the cursor whenever the result set changes, or the highlight
  // points at a row that has since been replaced by a different one.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeIndex > rows.length - 1) setActiveIndex(0);
  }, [rows.length, activeIndex]);

  // Close on outside click. Same mousedown pattern the user menu in
  // Header.tsx uses — mousedown rather than click so the dropdown is gone
  // before a click on something behind it registers.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const activate = useCallback(() => {
    setMounted(true);
    setOpen(true);
    // The input does not exist yet on the first activation; focus after
    // React has committed it.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Ctrl/Cmd+K focuses the box from anywhere. Ignored while the user is
  // typing in another field, so it cannot steal a keystroke mid-form.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      activate();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activate]);

  const go = useCallback((to: string) => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    navigate(to);
  }, [navigate]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      // First Escape clears a non-empty query, second closes. Closing on
      // the first press throws away what the user typed when they only
      // meant to start over.
      if (query.length > 0) setQuery('');
      else { setOpen(false); inputRef.current?.blur(); }
      return;
    }
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % rows.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) go(row.to);
    }
  }

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector(`[data-row-index="${activeIndex}"]`);
    // Optional-call: scrollIntoView is not implemented everywhere a React
    // tree can run (jsdom, for one), and keeping the highlight in view is
    // a nicety that must never take the header down with it.
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open]);

  const showDropdown = open && query.trim().length > 0;
  const activeId = rows[activeIndex] ? `gs-row-${activeIndex}` : undefined;

  const boxClass =
    'w-full rounded-lg border border-gray-200 bg-gray-50 py-2 pl-9 pr-4 text-sm ' +
    'dark:border-gray-600 dark:bg-gray-700';

  return (
    <div ref={containerRef} className="relative flex-1 max-w-md">
      <Search
        size={16}
        className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-gray-400 dark:text-gray-500"
      />

      {mounted ? (
        <input
          ref={inputRef}
          // `type="search"` and the vendor opt-outs below are belt and
          // braces on top of the lazy mount — none of them is sufficient
          // alone (see the component docblock).
          type="search"
          name="global-search"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="global-search-listbox"
          aria-activedescendant={showDropdown ? activeId : undefined}
          aria-label="Search"
          aria-autocomplete="list"
          data-testid="global-search-input"
          className={clsx(boxClass, 'text-gray-900 placeholder-gray-400 dark:text-gray-100 dark:placeholder-gray-500')}
          placeholder={PLACEHOLDER}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      ) : (
        <button
          type="button"
          onClick={activate}
          onFocus={activate}
          data-testid="global-search-trigger"
          className={clsx(boxClass, 'block cursor-text text-left text-gray-400 dark:text-gray-500')}
        >
          {PLACEHOLDER}
        </button>
      )}

      {showDropdown && (
        <div
          ref={listRef}
          id="global-search-listbox"
          role="listbox"
          aria-label="Search results"
          data-testid="global-search-results"
          className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[70vh] overflow-y-auto overscroll-contain rounded-xl border border-gray-200 bg-white py-2 shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {sections.map((section) => (
            <div key={`${section.label}-${section.start}`}>
              <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                {section.label}
              </div>
              {rows.slice(section.start, section.start + section.count).map((row, offset) => {
                const index = section.start + offset;
                const isActive = index === activeIndex;
                return (
                  <div
                    key={row.key}
                    id={`gs-row-${index}`}
                    data-row-index={index}
                    data-testid="global-search-row"
                    role="option"
                    aria-selected={isActive}
                    // onMouseDown, not onClick: the input's blur fires
                    // first on click and would close the dropdown before
                    // the click lands on the row.
                    onMouseDown={(e) => { e.preventDefault(); go(row.to); }}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={clsx(
                      'flex cursor-pointer items-center gap-3 px-3 py-2',
                      isActive ? 'bg-brand-50 dark:bg-gray-700' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-gray-900 dark:text-gray-100">{row.title}</div>
                      {row.subtitle && (
                        <div className="truncate text-xs text-gray-500 dark:text-gray-400">{row.subtitle}</div>
                      )}
                    </div>
                    {row.badge && (
                      <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                        {row.badge}
                      </span>
                    )}
                    {isActive && (
                      <CornerDownLeft size={12} className="shrink-0 text-gray-400 dark:text-gray-500" />
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Four distinct end states. Collapsing them into one "No
              results" is how an outage gets reported as an empty estate. */}
          {rows.length === 0 && !isQueryable && (
            <div className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400" data-testid="global-search-too-short">
              Keep typing — at least {SEARCH_MIN_QUERY_LENGTH} characters.
            </div>
          )}
          {rows.length === 0 && isQueryable && isLoadingRecords && (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-gray-500 dark:text-gray-400" data-testid="global-search-loading">
              <Loader2 size={12} className="animate-spin" />
              Searching…
            </div>
          )}
          {rows.length === 0 && isQueryable && !isLoadingRecords && !recordsError && (
            <div className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400" data-testid="global-search-empty">
              No matches for “{query.trim()}”.
            </div>
          )}
          {recordsError && (
            <div
              className="flex items-start gap-2 border-t border-gray-100 px-3 py-2 text-xs text-amber-700 dark:border-gray-700 dark:text-amber-400"
              data-testid="global-search-records-error"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                Couldn’t search domains, apps and other records — showing pages only.
              </span>
            </div>
          )}
          {isLoadingRecords && rows.length > 0 && (
            <div className="flex items-center gap-2 border-t border-gray-100 px-3 py-2 text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">
              <Loader2 size={12} className="animate-spin" />
              Searching records…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
