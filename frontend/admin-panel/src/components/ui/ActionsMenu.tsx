import { useState, useRef, useEffect, type ReactNode } from 'react';
import { ChevronDown, MoreHorizontal } from 'lucide-react';

/**
 * Title-bar "Actions" dropdown.
 *
 * Pages that accumulate one button per capability end up with a header that
 * is mostly buttons — the tenant detail page reached nine, several of them
 * destructive and sitting one mis-click from the primary action. Everything
 * except the page's primary action belongs in here.
 *
 * Closes on outside click and on Escape, and restores focus to the trigger
 * so keyboard operators are not dumped at the top of the document.
 */
interface ActionsMenuProps {
  readonly children: ReactNode;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly testId?: string;
}

export default function ActionsMenu({
  children,
  label = 'Actions',
  disabled = false,
  testId = 'actions-menu',
}: ActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((p) => !p)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700/50"
        data-testid={`${testId}-button`}
      >
        <MoreHorizontal size={14} />
        <span className="hidden sm:inline">{label}</span>
        <ChevronDown size={14} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
      </button>

      {open && (
        <div
          role="menu"
          // Click anywhere inside closes the menu: every child here performs
          // an action or opens a modal, so leaving it open behind a dialog
          // just strands it on screen.
          onClick={() => setOpen(false)}
          className="absolute right-0 z-40 mt-1 w-60 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
          data-testid={`${testId}-panel`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** A single row in an ActionsMenu. `tone` marks destructive entries. */
export function ActionsMenuItem({
  onClick,
  icon,
  children,
  disabled = false,
  tone = 'default',
  title,
  testId,
}: {
  readonly onClick: () => void;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly tone?: 'default' | 'danger';
  readonly title?: string;
  readonly testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-50 ${
        tone === 'danger'
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20'
          : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700/50'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

/** Hairline separator between groups (e.g. before destructive actions). */
export function ActionsMenuSeparator() {
  return <div className="my-1 border-t border-gray-100 dark:border-gray-700" role="separator" />;
}
