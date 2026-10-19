import { useState, type ReactNode } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useLoginAsTenant } from '@/hooks/use-impersonate';

/**
 * A link into the TENANT panel, signed in as this tenant, on the page `to`
 * names. Management the tenant panel already offers is done there — this
 * page shows the state and sends the operator to the place that changes it.
 *
 * A button, not an anchor: opening the tab first mints an impersonation
 * token, so there is no URL to put in an `href`.
 */
export default function TenantPanelLink({
  tenantId,
  to,
  label,
  children,
  variant = 'link',
  className,
  testId,
}: {
  readonly tenantId: string;
  /** A tenant-panel path, from `tenantPanel` in ./tenant-panel-paths. */
  readonly to: string;
  /** Where it goes, for the tooltip: "Email → Mailboxes". */
  readonly label: string;
  readonly children: ReactNode;
  /** `tile`: a whole card is the link; its content must be phrasing content (spans). */
  readonly variant?: 'link' | 'button' | 'danger' | 'tile';
  readonly className?: string;
  readonly testId?: string;
}) {
  const login = useLoginAsTenant();
  const [failed, setFailed] = useState<string | null>(null);

  const go = async (): Promise<void> => {
    setFailed(null);
    try {
      const opened = await login.open(tenantId, to);
      if (!opened) setFailed('The tenant panel URL is not configured (System Settings).');
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'Could not sign in to the tenant panel.');
    }
  };

  const title = login.isUnconfigured
    ? 'The tenant panel URL is not configured (System Settings)'
    : `Opens ${label} in the tenant panel, in a new tab, signed in as this tenant`;

  if (variant === 'tile') {
    return (
      <button
        type="button"
        onClick={go}
        disabled={login.isPending || login.isUnconfigured}
        title={title}
        data-testid={testId}
        data-tenant-panel-path={to}
        className={clsx(
          'block w-full min-w-0 rounded-xl border border-gray-200 bg-white text-left shadow-sm hover:border-brand-500 hover:ring-1 hover:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-brand-400',
          className,
        )}
      >
        {children}
        {failed && <span role="alert" className="block px-5 pb-3 text-xs text-red-600 dark:text-red-400">{failed}</span>}
        <span className="sr-only"> (opens the tenant panel in a new tab)</span>
      </button>
    );
  }

  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        onClick={go}
        disabled={login.isPending || login.isUnconfigured}
        title={title}
        data-testid={testId}
        data-tenant-panel-path={to}
        className={clsx(
          'inline-flex items-center gap-1 whitespace-nowrap font-medium disabled:cursor-not-allowed disabled:opacity-50',
          variant === 'link' && 'rounded text-brand-600 hover:underline dark:text-brand-400',
          variant === 'danger' && 'rounded text-red-600 hover:underline dark:text-red-400',
          variant === 'button' && 'rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-sm hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700',
          className,
        )}
      >
        {children}
        {login.isPending
          ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          : <ExternalLink size={12} aria-hidden="true" />}
        <span className="sr-only"> (opens the tenant panel in a new tab)</span>
      </button>
      {failed && (
        <span role="alert" className="mt-0.5 text-xs text-red-600 dark:text-red-400">{failed}</span>
      )}
    </span>
  );
}
