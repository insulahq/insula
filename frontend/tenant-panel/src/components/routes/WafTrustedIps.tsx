/**
 * WAF trusted IPs of a route: addresses (or small networks) whose requests the
 * WAF still checks and logs on this hostname but never blocks — the tenant's
 * own workstation, office or automation. Not the IP allowlist below it, which
 * decides who may reach the site at all.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, ShieldPlus } from 'lucide-react';
import {
  isWildcardRouteHostname,
  WAF_TRUSTED_IP_NOTE_MAX,
  WAF_TRUSTED_IPV4_MIN_PREFIX,
  WAF_TRUSTED_IPV6_MIN_PREFIX,
  createWafTrustedIpRequestSchema,
  type WafTrustedIp,
} from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import LocalTime from '@/components/ui/LocalTime';
import { useCreateRouteWafTrustedIp, useDeleteRouteWafTrustedIp, useRouteWafTrustedIps } from '@/hooks/use-route-waf';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { localZoneTitle } from '@/lib/format-timestamp';
import { utcOffsetLabel } from '@/lib/format-traffic';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export function WafTrustedIpsSection({ tenantId, routeId, hostname, prefill, onPrefillDone }: {
  readonly tenantId: string;
  readonly routeId: string;
  readonly hostname: string;
  /** An address picked in the WAF Log ("Trust"): opens the card and the add dialog with it. */
  readonly prefill: string | null;
  readonly onPrefillDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WafTrustedIp | null>(null);
  const { data, isLoading, isError, error } = useRouteWafTrustedIps(tenantId, routeId);
  const del = useDeleteRouteWafTrustedIp(tenantId, routeId);
  const list = data?.data?.trustedIps ?? [];
  const max = data?.data?.max ?? 20;
  // The WAF matches a website by its exact hostname; a wildcard route has none.
  const wildcard = isWildcardRouteHostname(hostname);

  useEffect(() => {
    if (prefill === null) return;
    setOpen(true);
    setAdding(prefill);
    onPrefillDone();
  }, [prefill, onPrefillDone]);

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-5 py-4 text-left"
        data-testid="waf-trusted-ips-section"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">WAF Trusted IPs</h3>
        </div>
        {list.length > 0 && (
          <span className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" data-testid="waf-trusted-ips-count">
            {list.length}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-5 space-y-3" data-testid="waf-trusted-ips-body">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Requests from these addresses to <strong className="font-mono">{hostname}</strong> are still checked
            and logged by the WAF, but <em>never blocked</em>, and they do not count toward the platform&apos;s
            automatic ban. Use it for your own workstation, office or automation that sends content the rules
            mistake for an attack. Your other routes and other tenants are unaffected.
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-300">
            A trusted address is a gap in the WAF for this site: anything sent from it reaches your application.
            Prefer single addresses; a network can be at most a /{WAF_TRUSTED_IPV4_MIN_PREFIX} (IPv4) or /{WAF_TRUSTED_IPV6_MIN_PREFIX} (IPv6).
            This is not the IP allowlist, which decides who may reach the site at all.
          </p>
          {wildcard && (
            <p className="rounded-md border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900/40 p-3 text-xs text-gray-600 dark:text-gray-300" data-testid="waf-trusted-ips-wildcard">
              Trusted IPs cannot be set on a wildcard route: the firewall matches a website by its exact
              hostname. Add a route for the exact hostname and trust the address there.
            </p>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setAdding('')}
              disabled={wildcard || list.length >= max}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-50"
              title={list.length >= max ? `A route can trust at most ${max} entries` : undefined}
              data-testid="waf-trusted-ips-add"
            >
              <ShieldPlus size={12} /> Trust an address
            </button>
          </div>
          {isLoading && <div className="flex justify-center py-4"><Loader2 size={20} className="animate-spin text-blue-600" /></div>}
          {isError && <ErrorPanel error={extractOperatorError(error)} compact testId="waf-trusted-ips-error" />}
          {!isLoading && !isError && list.length === 0 && (
            <div className="rounded-md border border-dashed border-gray-300 dark:border-gray-600 p-4 text-center text-xs text-gray-500 dark:text-gray-400" data-testid="waf-trusted-ips-empty">
              No trusted addresses. Every request is enforced.
            </div>
          )}
          {list.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-500 dark:text-gray-400 uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Address</th>
                    <th className="px-3 py-2 text-left">Note</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap" title={localZoneTitle()}>Added ({utcOffsetLabel()})</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {list.map((t) => (
                    <tr key={t.id} data-testid={`waf-trusted-ip-row-${t.id}`}>
                      <td className="px-3 py-2 font-mono text-gray-900 dark:text-gray-100 whitespace-nowrap">{t.value}</td>
                      <td className="px-3 py-2 text-gray-700 dark:text-gray-300 max-w-[280px] truncate" title={t.note ?? undefined}>{t.note ?? '—'}</td>
                      <td className="px-3 py-2 text-[11px] text-gray-500 dark:text-gray-400 whitespace-nowrap"><LocalTime iso={t.createdAt} /></td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setPendingDelete(t)}
                          className="inline-flex items-center gap-1 rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40"
                          data-testid={`waf-trusted-ip-delete-${t.id}`}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {adding !== null && (
        <AddTrustedIpModal
          tenantId={tenantId}
          routeId={routeId}
          hostname={hostname}
          initialValue={adding}
          onClose={() => setAdding(null)}
        />
      )}
      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="waf-trusted-ip-delete-title">
          <div className="w-full max-w-md rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl" data-testid="confirm-delete-waf-trusted-ip-modal">
            <h3 id="waf-trusted-ip-delete-title" className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Stop trusting {pendingDelete.value}?</h3>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              Its requests to <strong className="font-mono">{hostname}</strong> are enforced again once the WAF has
              reloaded (a few seconds to a minute), and requests that match rules will be blocked.
            </p>
            {del.isError && <div className="mt-3"><ErrorPanel error={extractOperatorError(del.error)} compact testId="waf-trusted-ip-delete-error" /></div>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={del.isPending}
                className="rounded-md px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => del.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) })}
                disabled={del.isPending}
                className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm border border-red-300 bg-red-600 dark:bg-red-700 text-white hover:bg-red-700 dark:hover:bg-red-600 disabled:opacity-50"
                data-testid="confirm-delete-waf-trusted-ip-submit"
                autoFocus
              >
                {del.isPending && <Loader2 size={14} className="animate-spin" />}
                {del.isPending ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AddTrustedIpModal({ tenantId, routeId, hostname, initialValue, onClose }: {
  readonly tenantId: string;
  readonly routeId: string;
  readonly hostname: string;
  readonly initialValue: string;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [note, setNote] = useState('');
  const create = useCreateRouteWafTrustedIp(tenantId, routeId);
  const parsed = createWafTrustedIpRequestSchema.safeParse({ value, note: note.trim() || undefined });
  const shapeError = value.trim() === '' ? null : parsed.error?.issues[0]?.message ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="add-waf-trusted-ip-title">
      <form
        className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
        data-testid="add-waf-trusted-ip-modal"
        onSubmit={(e) => {
          e.preventDefault();
          if (!parsed.success) return;
          create.mutate(parsed.data, { onSuccess: onClose });
        }}
      >
        <h3 id="add-waf-trusted-ip-title" className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Trust an address on {hostname}</h3>
        <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">
          Checked and logged, never blocked — on this hostname only.
        </p>
        <div className="space-y-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-gray-700 dark:text-gray-200">Address or network</span>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="203.0.113.7 or 2001:db8:1::/48"
              className={INPUT_CLASS + ' font-mono'}
              aria-invalid={shapeError !== null}
              autoFocus
              data-testid="add-waf-trusted-ip-value"
            />
            {shapeError && <span className="text-[11px] text-red-600 dark:text-red-400" data-testid="add-waf-trusted-ip-value-error">{shapeError}</span>}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-700 dark:text-gray-200">Note (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={WAF_TRUSTED_IP_NOTE_MAX}
              placeholder="e.g. office, CI runner, my workstation"
              className={INPUT_CLASS}
              data-testid="add-waf-trusted-ip-note"
            />
          </label>
        </div>
        {create.isError && <div className="mt-3"><ErrorPanel error={extractOperatorError(create.error)} compact testId="add-waf-trusted-ip-error" /></div>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!parsed.success || create.isPending}
            className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm border border-emerald-300 bg-emerald-600 dark:bg-emerald-700 text-white hover:bg-emerald-700 dark:hover:bg-emerald-600 disabled:opacity-50"
            data-testid="add-waf-trusted-ip-submit"
          >
            {create.isPending && <Loader2 size={14} className="animate-spin" />}
            {create.isPending ? 'Saving…' : 'Trust'}
          </button>
        </div>
      </form>
    </div>
  );
}
