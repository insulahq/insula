import { useEffect, useState } from 'react';
import { Loader2, Server, CheckCircle, AlertCircle, Plus, X } from 'lucide-react';
import clsx from 'clsx';
import { MAX_DNS_RESOLVER_SERVERS, type DnsResolverMode } from '@insula/api-contracts';
import { useDnsResolver, useUpdateDnsResolver, useProbeDnsResolver } from '@/hooks/use-dns-resolver';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

/**
 * Upstream DNS for every platform-initiated lookup (domain verification, mail
 * deliverability, drift scans).
 *
 * `host` is the pod's inherited resolver — CoreDNS → the node's
 * /etc/resolv.conf, which on a mesh-joined node the VPN agent owns and
 * rewrites. We show those addresses so the option is not a black box.
 */
export default function DnsResolverCard() {
  const { data, isLoading, error } = useDnsResolver();
  const update = useUpdateDnsResolver();
  const probe = useProbeDnsResolver();

  const [mode, setMode] = useState<DnsResolverMode>('host');
  const [servers, setServers] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);

  // Seed local state once the server value arrives; don't clobber an edit in
  // progress if the query refetches underneath the operator.
  // Defensive about shape, not just presence: this card renders on a page
  // whose other queries resolve different payloads, and a partial/unknown
  // response must degrade to the safe default rather than throw and blank the
  // whole page.
  useEffect(() => {
    if (!data || dirty) return;
    setMode(data.mode === 'custom' ? 'custom' : 'host');
    const configured = Array.isArray(data.servers) ? data.servers : [];
    setServers(configured.length > 0 ? [...configured] : ['']);
  }, [data, dirty]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading resolver settings…
      </div>
    );
  }
  if (error) return <ErrorPanel error={extractOperatorError(error)} />;

  const trimmed = servers.map((s) => s.trim()).filter(Boolean);
  const canSave = mode === 'host' || trimmed.length > 0;

  const setAt = (i: number, v: string) => {
    setDirty(true);
    setServers((prev) => prev.map((s, idx) => (idx === i ? v : s)));
  };
  const removeAt = (i: number) => {
    setDirty(true);
    setServers((prev) => prev.filter((_, idx) => idx !== i));
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-3 flex items-center gap-2">
        <Server className="h-5 w-5 text-gray-500 dark:text-gray-400" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Upstream DNS</h2>
      </div>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Resolver used for every platform lookup — domain verification, mail deliverability and DNS
        drift scans. Changing this does not affect what your tenants&apos; visitors resolve.
      </p>

      <fieldset className="space-y-3">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="radio"
            className="mt-1"
            checked={mode === 'host'}
            onChange={() => { setDirty(true); setMode('host'); }}
          />
          <span>
            <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
              Use the cluster&apos;s own resolver
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              Inherited from the node. Currently:{' '}
              <code className="rounded bg-gray-100 px-1 dark:bg-gray-700 dark:text-gray-200">
                {Array.isArray(data?.hostServers) && data.hostServers.length > 0
                  ? data.hostServers.join(', ')
                  : 'unknown'}
              </code>
              . A mesh VPN agent may rewrite this without notice.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="radio"
            className="mt-1"
            checked={mode === 'custom'}
            onChange={() => { setDirty(true); setMode('custom'); }}
          />
          <span>
            <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
              Use specific upstream servers
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              Up to {MAX_DNS_RESOLVER_SERVERS} addresses, IPv4 and/or IPv6. Bypasses cluster DNS.
            </span>
          </span>
        </label>
      </fieldset>

      {mode === 'custom' && (
        <div className="mt-4 space-y-2">
          {servers.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={s}
                onChange={(e) => setAt(i, e.target.value)}
                placeholder="9.9.9.9 or 2620:fe::fe"
                className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={`Remove server ${i + 1}`}
                className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          {servers.length < MAX_DNS_RESOLVER_SERVERS && (
            <button
              type="button"
              onClick={() => { setDirty(true); setServers((p) => [...p, '']); }}
              className="flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              <Plus className="h-4 w-4" /> Add server
            </button>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={update.isPending || !canSave}
          onClick={() => {
            // `trimmed` for both modes on purpose: host mode PERSISTS the list
            // so toggling back to custom does not make the operator retype it.
            update.mutate({ mode, servers: trimmed }, {
              onSuccess: () => setDirty(false),
            });
          }}
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
        >
          {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </button>

        {/* Test BEFORE saving — a blackholed upstream would otherwise only
            surface when domain verification started failing. */}
        <button
          type="button"
          disabled={probe.isPending}
          onClick={() => probe.mutate(mode === 'custom' ? trimmed : [])}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          {probe.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Test
        </button>

        {probe.data && (
          <span
            className={clsx(
              'inline-flex items-center gap-1 text-sm',
              probe.data.data.ok
                ? 'text-green-700 dark:text-green-400'
                : 'text-red-700 dark:text-red-400',
            )}
          >
            {probe.data.data.ok ? <CheckCircle className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            {probe.data.data.detail}
          </span>
        )}
      </div>

      {update.error ? <div className="mt-3"><ErrorPanel error={extractOperatorError(update.error)} /></div> : null}
    </div>
  );
}
