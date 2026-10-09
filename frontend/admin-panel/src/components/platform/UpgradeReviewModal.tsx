import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, CheckCircle, AlertTriangle, XCircle, Server, FileText } from 'lucide-react';
import { usePreflight, useHostMigrationsPreview, useUpgradeApply, useUpgradeChanges, type UpgradeGate, type UpgradeApplyData } from '@/hooks/use-platform-upgrade';
import UpgradeChangesSection from './UpgradeChangesSection';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import NodeName from '@/components/nodes/NodeName';
import ChangelogModal from './ChangelogModal';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { formatVersion } from '@/lib/format-version';

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
  // ADR-064: the upgrade updates every node before the services, so a node that is
  // not Ready blocks it — unless the operator chooses to upgrade without it.
  const [excluded, setExcluded] = useState<string[]>([]);
  // ADR-064 §8: opt-in — Kubernetes restarts k3s on every node and drains the workers.
  const [upgradeKubernetes, setUpgradeKubernetes] = useState(false);
  const nodesQ = useClusterNodes();
  const notReady = useMemo(
    () => (nodesQ.data?.data ?? [])
      .filter((n) => n.existsInKubernetes !== false)
      .filter((n) => (n.statusConditions ?? []).find((c) => c.type === 'Ready')?.status !== 'True')
      .map((n) => n.name),
    [nodesQ.data],
  );
  const preflight = usePreflight(true, excluded);
  const hostMigrations = useHostMigrationsPreview();
  const changesQ = useUpgradeChanges(true, excluded);
  const apply = useUpgradeApply();
  const [preview, setPreview] = useState<UpgradeApplyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);

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
    // Mount-only on purpose: the dry-run preview is fetched once when the modal
    // opens. (No eslint-disable here — `react-hooks/exhaustive-deps` is not a
    // configured rule in this repo, and naming it made eslint hard-fail with
    // "Definition for rule ... was not found".)
  }, []);

  const resolvedTarget = preview?.target ?? targetVersion;
  const canApprove = Boolean(pf?.ok && preview?.proceed && !loading && !applying);

  const onApproveClick = async () => {
    setApplying(true);
    try {
      await apply.mutateAsync({ version: targetVersion, apply: true, excludeNodes: excluded, upgradeKubernetes });
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
            Review upgrade{resolvedTarget ? <> → <span className="font-mono">{formatVersion(resolvedTarget)}</span></> : null}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-gray-500 dark:text-gray-400"><Loader2 className="h-4 w-4 animate-spin" /> Planning the upgrade…</div>
          ) : (
            <>
              {/* What changes (ADR-064 §6) */}
              {changesQ.data?.data && <UpgradeChangesSection changes={changesQ.data.data} target={resolvedTarget ?? undefined} />}

              {/* The opt-in Kubernetes step (ADR-064 §8) */}
              {changesQ.data?.data.kubernetes?.offer && changesQ.data.data.toVersion === resolvedTarget && (
                <label className="flex items-start gap-2 rounded border border-gray-200 p-3 text-xs dark:border-gray-700" data-testid="upgrade-kubernetes-option">
                  <input
                    type="checkbox" checked={upgradeKubernetes} disabled={applying}
                    onChange={(e) => setUpgradeKubernetes(e.target.checked)} data-testid="upgrade-kubernetes-toggle"
                    className="mt-0.5 rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
                  />
                  <span className="text-gray-700 dark:text-gray-300">
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      Also upgrade Kubernetes {changesQ.data.data.kubernetes.current} → {changesQ.data.data.kubernetes.target}
                    </span>
                    <br />
                    A fourth step after the host changes: servers one at a time, then each worker drained and upgraded.
                    Tenant sites on a worker move while it is drained.
                  </span>
                </label>
              )}
              {changesQ.data?.data.kubernetes && !changesQ.data.data.kubernetes.offer && changesQ.data.data.kubernetes.reason && (
                <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="upgrade-kubernetes-unavailable">
                  Kubernetes: {changesQ.data.data.kubernetes.reason}
                </p>
              )}

              {/* Interruption preview */}
              {preview?.interruption && (
                <div className={`text-xs rounded border p-3 space-y-2 ${(preview.interruption.noRedundancy ?? preview.interruption.singleNode) ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20' : 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20'}`}>
                  <div className="flex items-center gap-1.5 font-medium text-gray-900 dark:text-gray-100">
                    <AlertTriangle className={`h-4 w-4 ${(preview.interruption.noRedundancy ?? preview.interruption.singleNode) ? 'text-amber-500' : 'text-blue-500'}`} />
                    What will be interrupted
                    {preview.interruption.nodeCount != null && (
                      <span className="ml-auto text-gray-500 dark:text-gray-400 font-normal">{preview.interruption.nodeCount} node{preview.interruption.nodeCount === 1 ? '' : 's'}{(preview.interruption.noRedundancy ?? preview.interruption.singleNode) ? ' · no second replica' : ''}</span>
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

              {/* Nodes the upgrade would wait for */}
              {(notReady.length > 0 || excluded.length > 0) && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-900/20" data-testid="upgrade-exclude-nodes">
                  <div className="font-medium text-gray-900 dark:text-gray-100">Nodes that are not Ready</div>
                  <p className="mt-1 text-gray-700 dark:text-gray-300">
                    The upgrade updates every node before the services. Upgrade without a node that is down, and it
                    catches up on its own update check when it is back.
                  </p>
                  <ul className="mt-2 space-y-1">
                    {[...new Set([...notReady, ...excluded])].map((name) => (
                      <li key={name}>
                        <label className="inline-flex items-center gap-2 text-gray-800 dark:text-gray-200">
                          <input
                            type="checkbox"
                            className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
                            data-testid={`exclude-node-${name}`}
                            checked={excluded.includes(name)}
                            disabled={applying}
                            onChange={(e) => setExcluded((cur) => (e.target.checked ? [...cur, name] : cur.filter((x) => x !== name)))}
                          />
                          Upgrade without <NodeName name={name} className="font-mono" />
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Host migrations */}
              <div className="text-xs text-gray-500 dark:text-gray-400">
                <span className="font-medium text-gray-700 dark:text-gray-300">Host migrations: </span>
                {hostMigrations.isLoading ? 'loading…' : (hm ? `${hm.willRun ? 'will run' : hm.mode} — ${hm.note}` : 'policy unavailable')}
              </div>

            </>
          )}
        </div>

        {/* Next to the buttons, not at the end of the scrolled body: an Approve
            that was refused must say so where the operator just clicked. */}
        {applyError && (
          <div className="border-t border-gray-200 px-5 pt-3 dark:border-gray-700" data-testid="upgrade-apply-error">
            <ErrorPanel error={extractOperatorError(applyError)} compact />
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 dark:border-gray-700 px-5 py-3">
          <button type="button" onClick={onClose} className="text-sm px-3 py-1.5 rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">Cancel</button>
          {/* Sits before Approve so the reading step comes before the committing
              one. Enabled even when pre-flight blocks the upgrade: knowing what
              a release contains is exactly what helps an operator decide how to
              clear a blocking gate. Disabled only while an apply is in flight,
              and until the dry-run has resolved the target — without a version
              there is nothing to fetch notes for. */}
          <button
            type="button"
            data-testid="review-changelog-btn"
            onClick={() => setShowChangelog(true)}
            disabled={applying || !resolvedTarget}
            className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            <FileText className="h-4 w-4" />
            Review changelog
          </button>
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

      {showChangelog && (
        <ChangelogModal
          version={resolvedTarget}
          canApprove={canApprove}
          applying={applying}
          onClose={() => setShowChangelog(false)}
          onApprove={() => { setShowChangelog(false); void onApproveClick(); }}
        />
      )}
    </div>
  );
}
