import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * A collapsible sub-section inside a card — collapsed by default.
 *
 * Same interaction as the page-level collapsibles (MailSectionCard, the host
 * migrations node rows): a real <button> header carrying `aria-expanded` and
 * `aria-controls`, so it is reachable and operable from the keyboard
 * (Tab, Enter/Space) and announces its state. The body is not rendered while
 * collapsed, so a long table costs nothing until it is opened.
 */
interface DisclosureProps {
  readonly title: ReactNode;
  /** One-line context shown on the header, e.g. a count. Visible collapsed. */
  readonly summary?: ReactNode;
  /** Root test id. The header is `${testId}-toggle`, the body `${testId}-body`. */
  readonly testId: string;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}

export default function Disclosure({
  title, summary, testId, defaultOpen = false, children,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <div
      className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
      data-testid={testId}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid={`${testId}-toggle`}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-semibold text-gray-800 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-gray-200 dark:hover:bg-gray-700/40"
      >
        {open
          ? <ChevronDown size={14} className="shrink-0 text-gray-400 dark:text-gray-500" />
          : <ChevronRight size={14} className="shrink-0 text-gray-400 dark:text-gray-500" />}
        <span>{title}</span>
        {summary && (
          <span className="ml-auto truncate pl-2 text-[11px] font-normal text-gray-500 dark:text-gray-400">
            {summary}
          </span>
        )}
      </button>
      {open && (
        <div
          id={bodyId}
          className="border-t border-gray-200 px-3 py-3 dark:border-gray-700"
          data-testid={`${testId}-body`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
