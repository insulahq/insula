import { useState } from 'react';
import { Loader2, RefreshCw, CheckCircle, ShieldAlert, Download, Container, ArrowUpCircle } from 'lucide-react';
import { usePlatformVersion, useUpdateSettings } from '@/hooks/use-platform-updates';
import { useRollback, type RollbackData } from '@/hooks/use-platform-upgrade';
import { useAuth } from '@/hooks/use-auth';
import DeployedImagesModal from '@/components/platform/DeployedImagesModal';
import UpgradeReviewModal from '@/components/platform/UpgradeReviewModal';
import PlatformUpgradeProgressModal from '@/components/PlatformUpgradeProgressModal';

/**
 * Platform → Updates (single consolidated page). The version card carries the
 * spine (installed → available), image-update settings, and the primary actions:
 * Check for updates, Run upgrade (only when a newer verified release exists → a
 * Review modal → Approve → live progress modal), and Show deployed images. A
 * guarded rollback lives below. Actions are super_admin-only + server-gated.
 */
const CARD = 'bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4';

export default function UpgradesPage() {
  const { data: versionRes, isLoading: versionLoading, isFetching: versionFetching, refetch: refetchVersion } = usePlatformVersion();
  const updateSettings = useUpdateSettings();
  const rollback = useRollback();
  const { user } = useAuth();

  const [autoUpdateLocal, setAutoUpdateLocal] = useState<boolean | null>(null);
  const [showImages, setShowImages] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [progressTarget, setProgressTarget] = useState<string | undefined>(undefined);
  const [showProgress, setShowProgress] = useState(false);
  const [rbPreview, setRbPreview] = useState<RollbackData | null>(null);
  const [rbConfirming, setRbConfirming] = useState(false);
  const [restoreData, setRestoreData] = useState(false);

  const v = versionRes?.data;
  const isProduction = (v?.environment ?? '') === 'production';
  const isSuperAdmin = user?.role === 'super_admin';
  const canUpgrade = Boolean(v?.updateAvailable && isSuperAdmin);
  const rbError = rollback.error as Error | null;

  const onRbPreview = async () => { setRbConfirming(false); const res = await rollback.mutateAsync({ apply: false, restoreData }); setRbPreview(res.data); };
  const onRbApply = async () => {
    const res = await rollback.mutateAsync({ apply: true, restoreData });
    setRbPreview(res.data);
    setRbConfirming(false);
    if (res.data.ok) { setProgressTarget(undefined); setShowProgress(true); } // reads pending (roll-back target)
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Platform Updates</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Current vs available version, and a guarded upgrade / rollback.
          {' '}{isProduction ? 'Production — manual, gated.' : 'Non-production environments auto-follow their branch.'}
        </p>
      </div>

      {/* Version card */}
      <div className={CARD} data-testid="platform-updates-section">
        <div className="mb-3 flex items-center gap-2 flex-wrap">
          <Download size={18} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Version</h2>
          {v?.updateAvailable && <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">update available</span>}
          {/* Small "deployed images" button, top of the card */}
          <button type="button" onClick={() => setShowImages(true)} data-testid="show-deployed-images-button"
            className="ml-auto inline-flex items-center gap-1 rounded border border-gray-200 dark:border-gray-600 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
            <Container size={12} /> Images
          </button>
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">{v?.environment ?? '—'}</span>
        </div>

        {versionLoading ? (
          <div className="flex items-center gap-2 py-2"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /><span className="text-sm text-gray-500 dark:text-gray-400">Loading…</span></div>
        ) : v ? (
          <>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">Installed</dt>
                <dd className="mt-0.5 text-sm font-mono font-semibold text-gray-900 dark:text-gray-100" data-testid="current-version">{v.installed ?? v.currentVersion ?? 'unknown'}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">Available</dt>
                {/* Prefer the cosign-verified `available` (the authoritative latest);
                    `latestVersion` is often null on production. Green when a newer
                    release is available. */}
                <dd className={`mt-0.5 text-sm font-mono font-semibold ${v.updateAvailable ? 'text-green-600 dark:text-green-400' : 'text-gray-900 dark:text-gray-100'}`} data-testid="latest-version">
                  {v.available ?? v.latestVersion ?? (
                    v.latestSource === 'unreachable'
                      ? <span className="font-sans font-normal text-amber-700 dark:text-amber-300">GitHub unreachable</span>
                      : <span className="font-sans font-normal text-gray-500 dark:text-gray-400">no releases published</span>
                  )}
                  {v.availableVerifyStatus && v.availableVerifyStatus !== 'verified' && (
                    <span className="ml-1 font-sans font-normal text-xs text-amber-600 dark:text-amber-400">({v.availableVerifyStatus})</span>
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
              <button type="button" data-testid="check-updates-btn" onClick={() => refetchVersion()} disabled={versionFetching}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-60 transition-colors">
                <RefreshCw size={14} className={versionFetching ? 'animate-spin' : ''} /> {versionFetching ? 'Checking…' : 'Check for updates'}
              </button>
              {/* Run upgrade — only when a newer version is available (super_admin). */}
              {canUpgrade && (
                <button type="button" data-testid="run-upgrade-btn" onClick={() => setShowReview(true)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors">
                  <ArrowUpCircle size={14} /> Run upgrade
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">Unable to fetch version information.</p>
        )}
      </div>

      {/* Rollback — super_admin only */}
      {isSuperAdmin && (
        <div className={`${CARD} space-y-3`}>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Roll back the last upgrade</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">Re-pins the Flux source back to the ref recorded before the last upgrade, then tracks the roll-back in a live progress modal + the Tasks chip. A rescue snapshot is taken before every upgrade.</p>
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
      {showReview && (
        <UpgradeReviewModal
          onClose={() => setShowReview(false)}
          onApprove={(target) => { setShowReview(false); setProgressTarget(target); setShowProgress(true); }}
        />
      )}
      {showProgress && <PlatformUpgradeProgressModal version={progressTarget} onClose={() => setShowProgress(false)} />}
    </div>
  );
}
