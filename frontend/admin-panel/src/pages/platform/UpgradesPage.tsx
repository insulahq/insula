import { useState } from 'react';
import { Loader2, RefreshCw, CheckCircle, AlertTriangle, XCircle, ArrowRight, ShieldAlert, Activity, Server, Download, Container } from 'lucide-react';
import { usePlatformVersion, useUpdateSettings } from '@/hooks/use-platform-updates';
import { usePreflight, usePostflight, useHostMigrationsPreview, useUpgradeApply, useRollback, useUpgradeProgress, type UpgradeGate, type UpgradeApplyData, type RollbackData } from '@/hooks/use-platform-upgrade';
import { useAuth } from '@/hooks/use-auth';
import DeployedImagesModal from '@/components/platform/DeployedImagesModal';

/**
 * Platform → Updates (single consolidated page). Shows the version spine
 * (installed → available) + image-update settings, the live pre-flight gates,
 * a guarded preview → apply flow (super_admin) that re-pins the cluster's Flux
 * source to a release tag, live roll progress / post-flight convergence, and a
 * guarded rollback — all sharing the same progress + Task Center machinery.
 * The re-pin/rollback are server-side gated on pre-flight + super_admin.
 */
function GateRow({ gate }: { gate: UpgradeGate }) {
  const icon =
    gate.status === 'pass' ? <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" /> :
    gate.status === 'warn' ? <AlertTriangle className="h-4 w-4 text-amber-500 dark:text-amber-400" /> :
    <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />;
  return (
    <div className="flex items-start gap-3 py-2 border-b border-gray-100 dark:border-gray-700 last:border-0">
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{gate.label}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{gate.detail}</div>
      </div>
    </div>
  );
}

const CARD = 'bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4';

export default function UpgradesPage() {
  const { data: versionRes, isLoading: versionLoading, refetch: refetchVersion } = usePlatformVersion();
  const preflight = usePreflight();
  const postflight = usePostflight(Boolean(versionRes?.data?.pendingVersion));
  const hostMigrations = useHostMigrationsPreview();
  const apply = useUpgradeApply();
  const rollback = useRollback();
  const updateSettings = useUpdateSettings();
  const { user } = useAuth();
  const [version, setVersion] = useState('');
  const [preview, setPreview] = useState<UpgradeApplyData | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rbPreview, setRbPreview] = useState<RollbackData | null>(null);
  const [rbConfirming, setRbConfirming] = useState(false);
  const [restoreData, setRestoreData] = useState(false);
  const [autoUpdateLocal, setAutoUpdateLocal] = useState<boolean | null>(null);
  const [showImages, setShowImages] = useState(false);

  const v = versionRes?.data;
  const pf = preflight.data?.data;
  const post = postflight.data?.data;
  const hm = hostMigrations.data?.data;
  const isProduction = (v?.environment ?? '') === 'production';
  const isSuperAdmin = user?.role === 'super_admin';
  const upgradeActive = Boolean(v?.pendingVersion || post?.pendingVersion);
  const progress = useUpgradeProgress(upgradeActive).data?.data;

  const onPreview = async () => { setConfirming(false); const res = await apply.mutateAsync({ version: version.trim() || undefined, apply: false }); setPreview(res.data); };
  const onApply = async () => { const res = await apply.mutateAsync({ version: version.trim() || undefined, apply: true }); setPreview(res.data); setConfirming(false); };
  const onRbPreview = async () => { setRbConfirming(false); const res = await rollback.mutateAsync({ apply: false, restoreData }); setRbPreview(res.data); };
  const onRbApply = async () => { const res = await rollback.mutateAsync({ apply: true, restoreData }); setRbPreview(res.data); setRbConfirming(false); };
  const applyError = apply.error as Error | null;
  const rbError = rollback.error as Error | null;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Platform Updates</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Current vs available version, pre-flight checks, and a guarded upgrade / rollback.
          {' '}{isProduction ? 'Production — manual, gated.' : 'Non-production environments auto-follow their branch.'}
        </p>
      </div>

      {/* Version spine + image-update settings */}
      <div className={CARD} data-testid="platform-updates-section">
        <div className="mb-3 flex items-center gap-2">
          <Download size={18} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Version</h2>
          {v?.updateAvailable && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">update available</span>}
          <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">{v?.environment ?? '—'}</span>
        </div>
        {versionLoading ? (
          <div className="flex items-center gap-2 py-2"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /><span className="text-sm text-gray-500 dark:text-gray-400">Loading…</span></div>
        ) : v ? (
          <>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">Installed</dt>
                <dd className="mt-0.5 text-sm font-mono font-semibold text-gray-900 dark:text-gray-100" data-testid="current-version">{v.currentVersion ?? 'unknown'}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">Available</dt>
                <dd className="mt-0.5 text-sm font-mono font-semibold text-gray-900 dark:text-gray-100" data-testid="latest-version">
                  {v.latestVersion ?? (
                    v.latestSource === 'none' ? <span className="font-sans font-normal text-gray-500 dark:text-gray-400">no releases published</span>
                    : v.latestSource === 'unreachable' ? <span className="font-sans font-normal text-amber-700 dark:text-amber-300">GitHub unreachable</span>
                    : '—'
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">Strategy</dt>
                <dd className="mt-0.5 text-sm text-gray-900 dark:text-gray-100">{v.imageUpdateStrategy}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">Last checked</dt>
                <dd className="mt-0.5 text-sm text-gray-900 dark:text-gray-100">{v.lastCheckedAt ? new Date(v.lastCheckedAt).toLocaleString() : '—'}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 dark:border-gray-700 pt-3 mt-3">
              {v.imageUpdateStrategy === 'auto' ? (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-green-50 dark:bg-green-900/20 px-3 py-1.5 text-sm font-medium text-green-700 dark:text-green-300" data-testid="auto-managed-badge">
                  <CheckCircle size={14} /> Auto-managed by Flux
                </span>
              ) : (
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input type="checkbox" data-testid="auto-update-toggle" checked={autoUpdateLocal ?? v.autoUpdate}
                    onChange={(e) => { setAutoUpdateLocal(e.target.checked); updateSettings.mutate(e.target.checked); }}
                    className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500" />
                  Automatic updates
                </label>
              )}
              <button type="button" data-testid="check-updates-btn" onClick={() => refetchVersion()}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors">
                <RefreshCw size={14} /> Check for updates
              </button>
              <button type="button" onClick={() => setShowImages(true)} data-testid="show-deployed-images-button"
                className="inline-flex items-center gap-2 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors">
                <Container size={14} /> Show deployed images
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">Unable to fetch version information.</p>
        )}
      </div>

      {/* Pre-flight */}
      <div className={CARD}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Pre-flight checks</h2>
          <button onClick={() => preflight.refetch()} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 flex items-center gap-1">
            <RefreshCw className={`h-3 w-3 ${preflight.isFetching ? 'animate-spin' : ''}`} /> refresh
          </button>
        </div>
        {preflight.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
        ) : pf ? (
          <>
            {pf.gates.map((g) => <GateRow key={g.id} gate={g} />)}
            <div className="mt-3 text-xs">
              {pf.ok
                ? <span className="text-green-700 dark:text-green-400">All blocking checks pass{pf.warnings ? ` (${pf.warnings} warning${pf.warnings > 1 ? 's' : ''})` : ''}.</span>
                : <span className="text-red-700 dark:text-red-400 font-medium">{pf.failures} blocking failure(s) — resolve before upgrading.</span>}
            </div>
          </>
        ) : (
          <div className="text-xs text-red-600 dark:text-red-400">Could not load pre-flight checks.</div>
        )}
      </div>

      {/* Host-migration policy */}
      <div className={CARD}>
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Host migrations</h2>
          {hm && <span className={`ml-auto text-xs px-2 py-1 rounded-full ${hm.willRun ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>{hm.willRun ? 'will run' : hm.mode}</span>}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{hostMigrations.isLoading ? 'Loading…' : hm?.note ?? 'Could not read the host-migration policy.'}</p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          Scripts are embedded in the platform-ops binary and run per node. See the{' '}
          <a href="https://github.com/insulahq/insula/blob/main/docs/operations/CLUSTER_MAINTENANCE_AND_UPGRADES.md" target="_blank" rel="noreferrer" className="underline hover:text-gray-600 dark:hover:text-gray-300">upgrades runbook</a>.
        </p>
      </div>

      {/* Run upgrade — super_admin only */}
      {isSuperAdmin ? (
        <div className={`${CARD} space-y-3`}>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Run upgrade</h2>
          <div className="flex items-center gap-2">
            <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder={v?.latestVersion ?? 'version (e.g. 2026.7.0)'}
              className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 font-mono bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500" />
            <button onClick={onPreview} disabled={apply.isPending} className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50">
              {apply.isPending && !confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Preview'}
            </button>
          </div>

          {preview && (
            <div className="text-xs rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 space-y-1">
              <div><span className="text-gray-500 dark:text-gray-400">decision:</span> <span className="font-mono text-gray-800 dark:text-gray-200">{preview.action}</span>{preview.target ? ` → ${preview.target}` : ''}</div>
              <div className="text-gray-600 dark:text-gray-300">{preview.summary}</div>
              {preview.applied && <div className="text-green-700 dark:text-green-400 font-medium">Applied — Flux is reconciling. Track it below or from the Tasks chip.</div>}
            </div>
          )}

          {preview?.proceed && !preview.applied && preview.interruption && (
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

          {applyError && <div className="text-xs text-red-700 dark:text-red-400 flex items-start gap-1"><ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" /><span>{applyError.message}</span></div>}

          {preview?.proceed && !preview.applied && (
            confirming ? (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-red-700 dark:text-red-400 font-medium">Re-pin the cluster to {preview.target}? This rolls every workload.</span>
                <button onClick={onApply} disabled={apply.isPending} className="text-sm px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">{apply.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm upgrade'}</button>
                <button onClick={() => setConfirming(false)} className="text-xs text-gray-500 dark:text-gray-400">cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirming(true)} disabled={!pf?.ok} title={!pf?.ok ? 'Pre-flight has blocking failures' : ''}
                className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">Apply upgrade →</button>
            )
          )}
        </div>
      ) : (
        <div className={`${CARD} text-xs text-gray-500 dark:text-gray-400`}>Upgrades and rollbacks require a super-admin.</div>
      )}

      {/* Post-flight / live progress — shown for BOTH an upgrade and a rollback */}
      {post && post.phase !== 'idle' && (
        <div className={CARD}>
          <div className="flex items-center gap-2 mb-2">
            <Activity className="h-4 w-4 text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Converging to {post.pendingVersion}</h2>
            <span className={`ml-auto text-xs px-2 py-1 rounded-full ${post.verdict === 'healthy' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' : post.verdict === 'abort-recommended' ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'}`}>{post.verdict}</span>
          </div>
          {progress && progress.readable && progress.total > 0 && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                <span>Rolling services to {progress.targetTag ?? post.pendingVersion}</span>
                <span className="font-mono">{progress.atTarget}/{progress.total} · {progress.percent}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-500 ${progress.percent === 100 ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${progress.percent}%` }} />
              </div>
              <ul className="mt-2 space-y-1">
                {progress.deployments.map((d) => (
                  <li key={d.name} className="flex items-center gap-1.5 text-xs">
                    {d.atTarget ? <CheckCircle className="h-3.5 w-3.5 text-green-600 dark:text-green-400 flex-shrink-0" /> : <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin flex-shrink-0" />}
                    <span className="text-gray-700 dark:text-gray-300">{d.label}</span>
                    <span className="ml-auto font-mono text-gray-400 dark:text-gray-500">{d.imageTag ?? '?'} · {d.readyReplicas}/{d.desiredReplicas} ready</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {post.gates.map((g) => <GateRow key={g.id} gate={g} />)}
          <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            Convergence check {post.consecutiveFailures}/{post.abortThreshold} consecutive failures{post.lastCheckedAt ? ` · last checked ${new Date(post.lastCheckedAt).toLocaleTimeString()}` : ''}
          </div>
          {post.verdict === 'abort-recommended' && (
            <div className="mt-2 text-xs text-red-700 dark:text-red-400 font-medium flex items-start gap-1"><ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" /><span>Not converging after {post.consecutiveFailures} checks — consider rolling back below.</span></div>
          )}
        </div>
      )}

      {/* Rollback — super_admin only */}
      {isSuperAdmin && (
        <div className={`${CARD} space-y-3`}>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Roll back the last upgrade</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">Re-pins the Flux source back to the ref recorded before the last upgrade, then tracks the roll-back roll above + in the Tasks chip. A rescue snapshot is taken before every upgrade.</p>
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={onRbPreview} disabled={rollback.isPending} className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50">
              {rollback.isPending && !rbConfirming ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Preview rollback'}
            </button>
            <label className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-1">
              <input type="checkbox" checked={restoreData} onChange={(e) => setRestoreData(e.target.checked)} className="rounded border-gray-300 dark:border-gray-600" /> also restore data (revert volumes — destructive)
            </label>
          </div>
          {rbPreview && (
            <div className="text-xs rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 space-y-1">
              <div className="text-gray-600 dark:text-gray-300">{rbPreview.summary}</div>
              {rbPreview.manifest && <div className="text-gray-500 dark:text-gray-400">target was {rbPreview.manifest.toVersion}, {rbPreview.manifest.rescueSnapshots} rescue snapshot(s)</div>}
            </div>
          )}
          {rbError && <div className="text-xs text-red-700 dark:text-red-400 flex items-start gap-1"><ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" /><span>{rbError.message}</span></div>}
          {rbPreview?.ok && !rbPreview.dataRestored && rbPreview.manifest && (
            rbConfirming ? (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-red-700 dark:text-red-400 font-medium">Roll back to {JSON.stringify(rbPreview.manifest.previousRef)}{restoreData ? ' AND revert volumes (DESTRUCTIVE)' : ''}?</span>
                <button onClick={onRbApply} disabled={rollback.isPending} className="text-sm px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">{rollback.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm rollback'}</button>
                <button onClick={() => setRbConfirming(false)} className="text-xs text-gray-500 dark:text-gray-400">cancel</button>
              </div>
            ) : (
              <button onClick={() => setRbConfirming(true)} className="text-sm px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-700">Roll back →</button>
            )
          )}
        </div>
      )}

      {showImages && <DeployedImagesModal onClose={() => setShowImages(false)} />}
    </div>
  );
}
