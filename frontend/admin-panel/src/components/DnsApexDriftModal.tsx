import { useMemo, useState } from 'react';
import { X, RefreshCw, Loader2, AlertTriangle, CheckCircle2, Info, Wrench } from 'lucide-react';
import type { DnsApexDriftDomain, DnsApexDriftReport } from '@insula/api-contracts';
import { useFixDnsApexDrift, useScanDnsApexDrift } from '@/hooks/use-dns-apex-drift';
import { extractOperatorError } from '@/lib/extract-operator-error';
import ErrorPanel from '@/components/ErrorPanel';
import NodeName from '@/components/nodes/NodeName';
import { DriftRecordLine, SERVER_STATUS_LABEL } from '@/components/dns-drift/DriftRecordLine';

/**
 * Route ("apex") DNS drift report and repair.
 *
 * Shows which servers publish ingress, then every drifting domain with what
 * the repair will ADD (addresses of servers that serve ingress but are
 * missing) and REMOVE (addresses of servers that were removed or no longer
 * serve ingress), each attributed to its server. "Refresh" rescans.
 */

interface Props {
  /** Null when no scan has run yet — the modal offers to run one. */
  readonly report: DnsApexDriftReport | null;
  readonly onClose: () => void;
  readonly onFixStarted: (taskId: string) => void;
}

const SOURCE_LABEL: Record<DnsApexDriftReport['ingressSource'], string> = {
  discovered: 'discovered from the servers',
  override: 'operator override (Ingress & TLS settings)',
  env: 'deployment default',
  fallback: 'local fallback',
};

export default function DnsApexDriftModal({ report, onClose, onFixStarted }: Props) {
  const scan = useScanDnsApexDrift();
  const fix = useFixDnsApexDrift();
  const drifting = useMemo(
    () => (report?.domains ?? []).filter((d) => d.error === null && d.missingCount + d.staleCount > 0),
    [report],
  );
  const unreadable = (report?.domains ?? []).filter((d) => d.error !== null);
  const holding = (report?.domains ?? []).filter((d) => d.error === null && d.missingCount + d.staleCount === 0 && d.heldCount > 0);
  const clean = (report?.domains ?? []).length - drifting.length - unreadable.length;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const start = (vars: { all: true } | { domainIds: string[] }) => fix.mutate(vars, {
    onSuccess: (res) => onFixStarted(res.data.taskId),
  });

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dns-apex-drift-title"
      data-testid="dns-apex-drift-modal"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-xl dark:bg-gray-800">
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-3 dark:border-gray-700">
          <div>
            <h3 id="dns-apex-drift-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Apex DNS drift
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="dns-apex-drift-scanned">
              {report
                ? `Scanned ${new Date(report.scannedAt).toLocaleString()} (${report.trigger}) · ingress addresses ${SOURCE_LABEL[report.ingressSource]}`
                : 'Not scanned yet'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => scan.mutate()}
              disabled={scan.isPending || fix.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700/50"
              data-testid="dns-apex-drift-refresh"
            >
              {scan.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {scan.isPending ? 'Scanning…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              data-testid="dns-apex-drift-close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300" data-testid="dns-apex-drift-explainer">
            <Info size={14} className="mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p>
                <strong>What is checked:</strong> on every domain whose DNS the platform hosts, each route name —
                the apex, subdomains, wildcards and their www — must carry exactly one A/AAAA record per server
                that serves ingress.
              </p>
              <p>
                <strong>Why fix it:</strong> when a server is added, its address is missing and it gets no
                visitors. When a server is removed, or its ingress is disabled, its address is still published,
                so some visitors are sent to a server that no longer answers. The repair adds the missing
                addresses and removes the stale ones. It never removes an address published by a hand-made
                record, one of a server that is only not ready right now, or one the platform cannot attribute
                to its servers.
              </p>
            </div>
          </div>

          {scan.isError && <ErrorPanel error={extractOperatorError(scan.error)} testId="dns-apex-drift-scan-error" />}
          {fix.isError && <ErrorPanel error={extractOperatorError(fix.error)} testId="dns-apex-drift-fix-error" />}

          {!report && !scan.isPending && (
            <p className="text-sm text-gray-600 dark:text-gray-400">No scan has run yet — click <strong>Refresh</strong>.</p>
          )}

          {report?.scanError && (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{report.scanError}</span>
            </div>
          )}

          {report && report.servers.length > 0 && (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Servers</h4>
              <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                <table className="w-full text-sm" data-testid="dns-apex-drift-servers">
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {report.servers.map((s) => (
                      <tr key={s.name} data-testid={`dns-apex-drift-server-${s.name}`}>
                        <td className="px-3 py-1.5 font-medium text-gray-900 dark:text-gray-100"><NodeName name={s.name} /></td>
                        <td className="px-3 py-1.5 font-mono text-xs text-gray-600 dark:text-gray-400">{[...s.ipv4, ...s.ipv6].join(', ') || '—'}</td>
                        <td className="px-3 py-1.5 text-right">
                          <span className={`rounded px-1.5 py-0.5 text-[11px] ${s.status === 'ingress'
                            ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                            : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}`}
                          >
                            {SERVER_STATUS_LABEL[s.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {report && !report.scanError && drifting.length === 0 && unreadable.length === 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300" data-testid="dns-apex-drift-clean">
              <CheckCircle2 size={14} /> Every route name matches the ingress servers ({report.domains.length} domain{report.domains.length === 1 ? '' : 's'} checked).
            </div>
          )}

          {drifting.length > 0 && (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Drifting domains ({drifting.length}) · {report?.missingCount ?? 0} to add · {report?.staleCount ?? 0} to remove
              </h4>
              <ul className="space-y-2">
                {drifting.map((d) => (
                  <DomainRow key={d.domainId} domain={d} checked={selected.has(d.domainId)} onToggle={() => toggle(d.domainId)} />
                ))}
              </ul>
            </section>
          )}

          {holding.length > 0 && (
            <section data-testid="dns-apex-drift-held-section">
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Kept on purpose ({holding.reduce((n, d) => n + d.heldCount, 0)})
              </h4>
              <ul className="space-y-2">
                {holding.map((d) => (
                  <li key={d.domainId} className="rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700" data-testid={`dns-apex-drift-holding-${d.domainName}`}>
                    <div className="font-medium text-gray-900 dark:text-gray-100">{d.domainName}</div>
                    <HostnameLines domain={d} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {unreadable.length > 0 && (
            <section>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Could not be checked ({unreadable.length})</h4>
              <ul className="space-y-1">
                {unreadable.map((d) => (
                  <li key={d.domainId} className="text-sm text-gray-700 dark:text-gray-300" data-testid={`dns-apex-drift-unreadable-${d.domainName}`}>
                    <span className="font-medium">{d.domainName}</span>
                    <span className="text-xs text-red-600 dark:text-red-400"> — {d.error}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report && clean > 0 && drifting.length > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{clean} other domain{clean === 1 ? '' : 's'} already match.</p>
          )}
        </div>

        {drifting.length > 0 && (
          <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3 dark:border-gray-700">
            <button
              type="button"
              onClick={() => start({ domainIds: [...selected] })}
              disabled={selected.size === 0 || fix.isPending || scan.isPending}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700/50"
              data-testid="dns-apex-drift-fix-selected"
            >
              Fix selected ({selected.size})
            </button>
            <button
              type="button"
              onClick={() => start({ all: true })}
              disabled={fix.isPending || scan.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="dns-apex-drift-fix-all"
            >
              {fix.isPending ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
              Fix all domains
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DomainRow({ domain, checked, onToggle }: {
  readonly domain: DnsApexDriftDomain;
  readonly checked: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li className="rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700" data-testid={`dns-apex-drift-domain-${domain.domainName}`}>
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="h-4 w-4 rounded border-gray-300 text-brand-500 dark:border-gray-600 dark:bg-gray-700"
          data-testid={`dns-apex-drift-select-${domain.domainName}`}
        />
        <span className="font-medium text-gray-900 dark:text-gray-100">{domain.domainName}</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {domain.missingCount > 0 && `${domain.missingCount} to add`}
          {domain.missingCount > 0 && domain.staleCount > 0 && ' · '}
          {domain.staleCount > 0 && `${domain.staleCount} to remove`}
        </span>
      </label>
      <div className="pl-6">
        <HostnameLines domain={domain} />
      </div>
    </li>
  );
}

/** Per route name: what the repair adds, removes, keeps, and leaves alone. */
function HostnameLines({ domain }: { readonly domain: DnsApexDriftDomain }) {
  const changed = domain.hostnames.filter((h) => h.missing.length + h.stale.length + h.held.length + h.foreign.length > 0);
  return (
    <div className="mt-1.5 space-y-1.5">
      {changed.map((h) => (
        <div key={h.hostname}>
          <div className="text-xs font-medium text-gray-700 dark:text-gray-300">{h.hostname}</div>
          <ul className="space-y-0.5">
            {h.missing.map((r) => <DriftRecordLine key={`+${r.type}${r.content}`} kind="add" type={r.type} content={r.content} servers={r.servers} testId="dns-apex-drift-add" />)}
            {h.stale.map((r) => <DriftRecordLine key={`-${r.type}${r.content}`} kind="remove" type={r.type} content={r.content} servers={r.servers} reason={r.reason} testId="dns-apex-drift-remove" />)}
            {h.held.map((r) => <DriftRecordLine key={`=${r.type}${r.content}`} kind="held" type={r.type} content={r.content} servers={r.servers} heldReason={r.reason} testId="dns-apex-drift-held" />)}
            {h.foreign.map((r) => <DriftRecordLine key={`~${r.type}${r.content}`} kind="foreign" type={r.type} content={r.content} testId="dns-apex-drift-foreign" />)}
          </ul>
        </div>
      ))}
    </div>
  );
}
