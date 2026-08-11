import { useState } from 'react';
import { X, AlertTriangle, CheckCircle2, Loader2, Info } from 'lucide-react';
import type { DnsApexDriftReport, DnsApexDriftDomain } from '@insula/api-contracts';
import { useFixDnsApexDrift } from '@/hooks/use-dns-apex-drift';

interface Props {
  readonly report: DnsApexDriftReport;
  readonly onClose: () => void;
  /** Called with the task id once a repair has been started. */
  readonly onFixStarted: (taskId: string) => void;
}

/**
 * Per-domain apex drift report.
 *
 * Three groups, deliberately distinguished:
 *   - drifting   — missing ingress records, selectable, repairable
 *   - unreadable — the zone could not be read, so NOT selectable; there is
 *                  nothing safe to add when we don't know what's there
 *   - clean      — collapsed count only
 *
 * "Also present" lists apex addresses the platform didn't place. They are
 * shown because an operator reviewing DNS should see everything at the apex,
 * and explicitly labelled as left alone so nobody expects this tool to remove
 * a CDN origin they added on purpose.
 */
export default function DnsApexDriftModal({ report, onClose, onFixStarted }: Props) {
  const fix = useFixDnsApexDrift();

  const drifting = report.domains.filter((d) => d.missing.length > 0 && d.error === null);
  const unreadable = report.domains.filter((d) => d.error !== null);
  const clean = report.domains.filter((d) => d.missing.length === 0 && d.error === null);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const toggle = (domainId: string) => {
    const next = new Set(selected);
    if (next.has(domainId)) next.delete(domainId);
    else next.add(domainId);
    setSelected(next);
  };

  const allSelected = drifting.length > 0 && selected.size === drifting.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(drifting.map((d) => d.domainId)));
  };

  const runFix = async (vars: { all?: boolean; domainIds?: string[] }) => {
    const res = await fix.mutateAsync(vars);
    onFixStarted(res.data.taskId);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800"
        data-testid="dns-apex-drift-modal"
      >
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Apex DNS drift
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Scanned {new Date(report.scannedAt).toLocaleString()} ({report.trigger}) · expected{' '}
              {report.expected.map((r) => r.content).join(', ') || 'none configured'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            data-testid="dns-apex-drift-modal-close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
            <Info size={12} className="mr-1 inline" />
            Repairs are <strong>additive</strong>: missing ingress addresses are added, and nothing
            is ever removed. Records the platform didn&apos;t place are listed for visibility only.
          </p>

          {drifting.length === 0 && unreadable.length === 0 && (
            <div
              className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300"
              data-testid="dns-apex-drift-none"
            >
              <CheckCircle2 size={16} />
              Every apex-managed domain has all expected ingress records.
            </div>
          )}

          {drifting.length > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Missing records ({drifting.length})
                </h3>
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="rounded border-gray-300 text-brand-500 focus:ring-brand-500 dark:border-gray-600"
                    data-testid="dns-apex-drift-select-all"
                  />
                  Select all
                </label>
              </div>
              <ul className="space-y-2">
                {drifting.map((d) => (
                  <DomainRow
                    key={d.domainId}
                    domain={d}
                    checked={selected.has(d.domainId)}
                    onToggle={() => toggle(d.domainId)}
                  />
                ))}
              </ul>
            </div>
          )}

          {unreadable.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                Could not be read ({unreadable.length})
              </h3>
              <ul className="space-y-2">
                {unreadable.map((d) => (
                  <li
                    key={d.domainId}
                    className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm dark:border-red-900 dark:bg-red-950/30"
                    data-testid={`dns-apex-drift-unreadable-${d.domainName}`}
                  >
                    <div className="flex items-center gap-2 font-medium text-red-800 dark:text-red-300">
                      <AlertTriangle size={14} /> {d.domainName}
                    </div>
                    <p className="mt-1 text-xs text-red-700 dark:text-red-400">{d.error}</p>
                    <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                      Not selectable — with the zone unreadable there is nothing safe to add.
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {clean.length > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="dns-apex-drift-clean-count">
              {clean.length} domain{clean.length === 1 ? '' : 's'} already correct
              {report.unmanagedCount > 0 && (
                <> · {report.unmanagedCount} carry additional records not managed by the platform</>
              )}
              .
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {selected.size > 0 ? `${selected.size} selected` : 'No domains selected'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700/50"
            >
              Close
            </button>
            <button
              type="button"
              disabled={selected.size === 0 || fix.isPending}
              onClick={() => void runFix({ domainIds: Array.from(selected) })}
              className="inline-flex items-center gap-2 rounded-lg border border-brand-500 px-4 py-2 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:text-brand-400 dark:hover:bg-brand-950/30"
              data-testid="dns-apex-drift-fix-selected"
            >
              {fix.isPending && <Loader2 size={14} className="animate-spin" />}
              Fix selected
            </button>
            <button
              type="button"
              disabled={drifting.length === 0 || fix.isPending}
              onClick={() => void runFix({ all: true })}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="dns-apex-drift-fix-all"
            >
              {fix.isPending && <Loader2 size={14} className="animate-spin" />}
              Fix all domains
            </button>
          </div>
        </div>

        {fix.error && (
          <p className="px-5 pb-3 text-sm text-red-600 dark:text-red-400" data-testid="dns-apex-drift-error">
            {fix.error instanceof Error ? fix.error.message : 'Failed to start repair'}
          </p>
        )}
      </div>
    </div>
  );
}

function DomainRow({
  domain,
  checked,
  onToggle,
}: {
  readonly domain: DnsApexDriftDomain;
  readonly checked: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li
      className="rounded-md border border-gray-200 px-3 py-2 dark:border-gray-700"
      data-testid={`dns-apex-drift-domain-${domain.domainName}`}
    >
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-1 rounded border-gray-300 text-brand-500 focus:ring-brand-500 dark:border-gray-600"
          data-testid={`dns-apex-drift-checkbox-${domain.domainName}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{domain.domainName}</p>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            Will add:{' '}
            {domain.missing.map((r) => (
              <code
                key={`${r.type}-${r.content}`}
                className="mr-1 rounded bg-amber-100 px-1 py-0.5 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
              >
                {r.type} {r.content}
              </code>
            ))}
          </p>
          {domain.unmanaged.length > 0 && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Also present (left alone):{' '}
              {domain.unmanaged.map((r) => (
                <code
                  key={`${r.type}-${r.content}`}
                  className="mr-1 rounded bg-gray-100 px-1 py-0.5 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                >
                  {r.type} {r.content}
                </code>
              ))}
            </p>
          )}
        </div>
      </label>
    </li>
  );
}
