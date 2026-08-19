import { useState, useRef, useEffect } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * The token an operator must re-type to confirm a destructive action.
 *
 * Destructive confirmations deliberately make you type an exact string —
 * a node name, a PV name, a domain. That guard is worth keeping, but
 * forcing the operator to transcribe a 40-character PV name by eye adds
 * only typos, not safety: the intent is already proven by the click.
 * Clicking the token copies it.
 *
 * Renders a <button>, so it is keyboard-reachable and announces itself;
 * the token text stays selectable for anyone who prefers to drag-select.
 */
interface ConfirmTokenProps {
  /** The exact string the operator must type. */
  readonly value: string;
  /** Extra classes for the token text (callers vary the accent colour). */
  readonly className?: string;
  /** Test id for the surrounding button. */
  readonly testId?: string;
}

export default function ConfirmToken({ value, className = '', testId }: ConfirmTokenProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clearing on unmount matters: these live inside modals that close the
  // moment the action is confirmed, and a pending timer would then set
  // state on an unmounted component.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is unavailable on insecure origins and when the browser
      // withholds permission. Staying silent is right — the operator can
      // still select and copy the text by hand, which is the status quo.
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied' : `Copy "${value}"`}
      aria-label={copied ? `Copied ${value}` : `Copy ${value} to clipboard`}
      data-testid={testId ?? 'confirm-token'}
      className="group inline-flex max-w-full items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 align-middle font-mono text-xs hover:bg-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-800 dark:hover:bg-gray-700"
    >
      <span className={`truncate ${className}`}>{value}</span>
      {copied
        ? <Check size={12} className="shrink-0 text-green-600 dark:text-green-400" aria-hidden />
        : <Copy size={12} className="shrink-0 text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 dark:text-gray-500" aria-hidden />}
    </button>
  );
}
