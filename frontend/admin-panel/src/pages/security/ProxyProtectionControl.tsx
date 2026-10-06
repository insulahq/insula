import clsx from 'clsx';
import type { OidcProvider } from '@/hooks/use-oidc-settings';
import { useSystemInfo } from '@/hooks/use-system-info';
import { proxyCallbackUrl } from '@/lib/oidc-callback-url';

const PANEL_LABEL = { admin: 'admin', tenant: 'tenant' } as const;

interface ProxyProtectionControlProps {
  readonly panel: 'admin' | 'tenant';
  readonly providers: readonly OidcProvider[];
  readonly enabled: boolean;
  readonly providerId: string | null;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onProviderChange: (providerId: string | null) => void;
}

/**
 * "Protect <panel> via OAuth2 Proxy" + the ONE provider the proxy signs in
 * with. oauth2-proxy cannot offer a choice the way the login page does, so the
 * operator picks it; the panel's login then continues with that same provider
 * on its own, so nobody signs in twice.
 */
export default function ProxyProtectionControl({
  panel, providers, enabled, providerId, onEnabledChange, onProviderChange,
}: ProxyProtectionControlProps) {
  const systemInfo = useSystemInfo();
  const candidates = providers.filter((p) => p.panelScope === panel && p.enabled);
  const available = candidates.length > 0;
  const callback = proxyCallbackUrl(panel, systemInfo.data);
  const label = PANEL_LABEL[panel];

  return (
    <div className="space-y-2" data-testid={`proxy-protect-${panel}`}>
      <label className={clsx('flex items-start gap-3', !available && 'opacity-50')}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            onEnabledChange(e.target.checked);
            if (e.target.checked && !providerId && candidates.length === 1) onProviderChange(candidates[0].id);
          }}
          disabled={!available && !enabled}
          className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500 disabled:cursor-not-allowed"
          data-testid={`proxy-protect-${panel}-toggle`}
        />
        <div>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Protect {label} panel via OAuth2 Proxy</span>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {available
              ? `Visitors must sign in at the identity provider before the ${label} panel loads at all.`
              : `Enable a ${label}-scoped OIDC provider first.`}
          </p>
        </div>
      </label>

      {enabled && (
        <div className="ml-7 space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3">
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor={`proxy-provider-${panel}`}>
            Sign-in provider
          </label>
          <select
            id={`proxy-provider-${panel}`}
            value={providerId ?? ''}
            onChange={(e) => onProviderChange(e.target.value || null)}
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100"
            data-testid={`proxy-provider-${panel}-select`}
          >
            <option value="">Choose a provider…</option>
            {candidates.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            The proxy uses this one provider; the {label} login then continues with it automatically, so
            visitors sign in once. Users who sign in with another provider also need an account here.
          </p>
          {callback && (
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Register this redirect URI for that provider&apos;s client:{' '}
              <code className="break-all rounded bg-white dark:bg-gray-800 px-1 py-0.5 font-mono text-gray-900 dark:text-gray-100" data-testid={`proxy-callback-${panel}`}>{callback}</code>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
