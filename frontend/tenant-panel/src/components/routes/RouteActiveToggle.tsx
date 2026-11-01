import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, PowerOff } from 'lucide-react';
import clsx from 'clsx';

interface RouteActiveToggleProps {
  readonly hostname: string;
  readonly enabled: boolean;
  readonly isPending: boolean;
  readonly disabled?: boolean;
  /** Called with the new state. Switching off asks first; switching on does not. */
  readonly onChange: (enabled: boolean) => void;
  readonly testId?: string;
}

/**
 * A route's Active / Inactive state, as a pill that is also the switch.
 *
 * The pill says the state in words and colour — green "Active", grey
 * "Inactive" — so a switched-off route is obvious in a list without reading a
 * knob position. Switching off takes the site offline, so it is confirmed;
 * switching back on is not.
 */
export default function RouteActiveToggle({
  hostname, enabled, isPending, disabled = false, onChange, testId,
}: RouteActiveToggleProps) {
  const [confirming, setConfirming] = useState(false);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  // Back to the pill when the dialog closes, so keyboard users are not left
  // at the top of the page.
  const closeConfirm = () => {
    setConfirming(false);
    pillRef.current?.focus();
  };

  const handleClick = () => {
    if (enabled) setConfirming(true);
    else onChange(true);
  };

  return (
    <>
      <button
        ref={pillRef}
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`Active: ${hostname}`}
        title={enabled ? 'Active — click to deactivate' : 'Inactive — click to activate'}
        onClick={handleClick}
        disabled={isPending || disabled}
        className={clsx(
          'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border py-0.5 pl-1 pr-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60',
          enabled
            ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50'
            : 'border-gray-300 bg-gray-100 text-gray-600 hover:bg-gray-200 dark:border-gray-600 dark:bg-gray-700/60 dark:text-gray-300 dark:hover:bg-gray-700',
        )}
        data-testid={testId}
        data-state={enabled ? 'active' : 'inactive'}
      >
        <span
          aria-hidden="true"
          className={clsx(
            'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
            enabled ? 'bg-green-600 dark:bg-green-500' : 'bg-gray-400 dark:bg-gray-500',
          )}
        >
          <span
            className={clsx(
              'inline-flex h-3 w-3 items-center justify-center rounded-full bg-white shadow transition-transform',
              enabled ? 'translate-x-3.5' : 'translate-x-0.5',
            )}
          >
            {isPending && <Loader2 size={9} className="animate-spin text-gray-500" />}
          </span>
        </span>
        {enabled ? 'Active' : 'Inactive'}
      </button>
      {/* Portalled: the pill sits inside clickable table rows, and a dialog
          rendered in place would inherit the row's stacking context. React
          still bubbles its events to the row's stopPropagation wrapper. */}
      {confirming && createPortal(
        <DeactivateRouteConfirm
          hostname={hostname}
          onCancel={closeConfirm}
          onConfirm={() => { closeConfirm(); onChange(false); }}
        />,
        document.body,
      )}
    </>
  );
}

function DeactivateRouteConfirm({ hostname, onConfirm, onCancel }: {
  readonly hostname: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="deactivate-route-title"
      data-testid="deactivate-route-confirm"
      onClick={(e) => { e.stopPropagation(); onCancel(); }}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
            <PowerOff size={18} className="text-amber-600 dark:text-amber-400" />
          </div>
          <div className="min-w-0">
            <h2 id="deactivate-route-title" className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Deactivate this route?
            </h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              <span className="break-all font-mono text-xs">{hostname}</span> stops being served until you
              activate it again — visitors get an error instead of the site.
            </p>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Nothing is deleted: its settings, DNS records and certificate are kept.
            </p>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            data-testid="deactivate-route-cancel"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
            data-testid="deactivate-route-confirm-button"
          >
            Deactivate
          </button>
        </div>
      </div>
    </div>
  );
}
