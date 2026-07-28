import { useEffect, useState } from 'react';
import { X, Loader2, CheckCircle, AlertTriangle, XCircle, Server, ShieldAlert } from 'lucide-react';
import { usePreflight, useHostMigrationsPreview, useUpgradeApply, type UpgradeGate, type UpgradeApplyData } from '@/hooks/use-platform-upgrade';

function Gate({ gate }: { gate: UpgradeGate }) {
  const icon =
    gate.status === 'pass' ? <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" /> :
    gate.status === 'warn' ? <AlertTriangle className="h-4 w-4 text-amber-500 dark:text-amber-400" /> :
    <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />;
  return (
    <div className="flex items-start gap-3 py-1.5 border-b border-gray-100 dark:border-gray-700 last:border-0">
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{gate.label}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{gate.detail}</div>
      </div>
    </div>
  );
}

/**
 * Review-and-approve modal for a platform upgrade. On open it runs a DRY-RUN to
 * fetch the interruption preview + resolved target, alongside the live pre-flight
 * gates and the host-migration policy. "Approve & upgrade" fires the REAL apply
 * (no second confirmation) and then calls `onApprove(target)` so the page can
 * open the live progress modal immediately.
 */
interface Props {
  /** Explicit target, or undefined to upgrade to the latest available release. */
  readonly targetVersion?: string;
  readonly onApprove: (target?: string) => void;
  readonly onClose: () => void;
}

export default function UpgradeReviewModal({ targetVersion, onApprove, onClose }: Props) {
  const preflight = usePreflight();
  const hostMigrations = useHostMigrationsPreview();
  const apply = useUpgradeApply();
  const [preview, setPreview] = useState<UpgradeApplyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  const pf = preflight.data?.data;
  const hm = hostMigrations.data?.data;
  const applyError = apply.error as Error | null;

  // Dry-run on mount → interruption preview + the resolved decision/target.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apply.mutateAsync({ version: targetVersion, apply: false });
        if (!cancelled) setPreview(res.data);
      } catch { /* surfaced via apply.error */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolvedTarget = preview?.target ?? targetVersion;
  const canApprove = Boolean(pf?.ok && preview?.proceed && !loading && !applying);

  const onApproveClick = async () => {
    setApplying(true);
    try {
      await apply.mutateAsync({ version: targetVersion, apply: true });
      onApprove(resolvedTarget ?? undefined);
    } catch {
      setApplying(false); // stay open; error shows below
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg max-h-[90vh] overflow-hidden rounded-lg bg-white dark:bg-gray-800 shadow-xl flex flex-col" data-testid="upgrade-review-modal">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Review upgrade{resolvedTarget ? <> → <span className="font-mono">{resolvedTarget}</span></> : null}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-gray-500 dark:text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Planning the upgrade…</div>
          ) : (
            <>
              {/* Interruption preview */}
              {preview?.interruption && (
                <div className={`text-xs rounded border p-3 space-y-2 ${preview.interruption.singleNode ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20' : 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20'}`}>
                  <div className="flex items-center gap-1.5 font-medium text-gray-900 dark:text-gray-100">
                    <AlertTriangle className={`h-4 w-4 ${preview.interruption.singleNode ? 'text-amber-500' : 'text-blue-500'}`} />
                    What will be interrupted
                    {preview.interruption.nodeCount != null && (
                      <span className="ml-auto text-gray-500 dark:text-gray-400 font-normal">{preview.interruption.nodeCount} node{preview.interruption.nodeCount === 1 ? '' : 's'}{preview.interruption.singleNode ? ' · no rolling redundancy' : ''}</span>
                    )}
                  </div>
                  <p className="text-gray-700 dark:text-gray-300">{preview.interruption.summary}</p>
                  <ul className="space-y-1">
                    {preview.interruption.services.map((s) => (
                      <li key={s.name} className="flex items-start gap-1.5">
                        <Server className="h-3.5 w-3.5 mt-0.5 text-gray-400 flex-shrink-0" />
                        <span><span className="font-medium text-gray-800 dark:text-gray-200">{s.label}</span> <span className="text-gray-500 dark:text-gray-400">— {s.impact}</span></span>
                      </li>
                    ))}
                  </ul>
                  {!preview.interruption.tenantWorkloadsAffected && (
                    <div className="flex items-center gap-1.5 text-green-700 dark:text-green-400"><CheckCircle className="h-3.5 w-3.5" /> Tenant websites and databases keep serving throughout.</div>
                  )}
                </div>
              )}

              {/* Pre-flight checks */}
              <div>
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">Pre-flight checks</h3>
                {preflight.isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                ) : pf ? (
                  <>
                    {pf.gates.map((g) => <Gate key={g.id} gate={g} />)}
                    <div className="mt-2 text-xs">
                      {pf.ok
                        ? <span className="text-green-700 dark:text-green-400">All blocking checks pass{pf.warnings ? ` (${pf.warnings} warning${pf.warnings > 1 ? 's' : ''})` : ''}.</span>
                        : <span className="text-red-700 dark:text-red-400 font-medium">{pf.failures} blocking failure(s) — resolve before upgrading.</span>}
                    </div>
                  </>
                ) : <div className="text-xs text-red-600 dark:text-red-400">Could not load pre-flight checks.</div>}
              </div>

              {/* Host migrations */}
              <div className="text-xs text-gray-500 dark:text-gray-400">
                <span className="font-medium text-gray-700 dark:text-gray-300">Host migrations: </span>
                {hostMigrations.isLoading ? 'loading…' : (hm ? `${hm.willRun ? 'will run' : hm.mode} — ${hm.note}` : 'policy unavailable')}
              </div>

              {applyError && <div className="text-xs text-red-700 dark:text-red-400 flex items-start gap-1"><ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" /><span>{applyError.message}</span></div>}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 dark:border-gray-700 px-5 py-3">
          <button type="button" onClick={onClose} className="text-sm px-3 py-1.5 rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">Cancel</button>
          <button
            type="button"
            data-testid="approve-upgrade-btn"
            onClick={onApproveClick}
            disabled={!canApprove}
            title={!pf?.ok ? 'Pre-flight has blocking failures' : ''}
            className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            {applying ? <><Loader2 className="h-4 w-4 animate-spin" /> Starting…</> : 'Approve & upgrade →'}
          </button>
        </div>
      </div>
    </div>
  );
}
