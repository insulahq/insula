import { useState } from 'react';
import {
  Loader2,
  Download,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Container,
  X,
} from 'lucide-react';
import { usePlatformVersion, useUpdateSettings, useTriggerUpdate } from '@/hooks/use-platform-updates';
import { usePlatformImages } from '@/hooks/use-platform-images';

/**
 * Platform → Updates — image-update strategy, current vs latest version,
 * Auto-Update toggle (manual strategy only) + Check for Updates / Update
 * Now buttons. Plus a "Show Deployed Images" modal trigger.
 *
 * Lifted from the legacy /settings page (Platform Updates inline card +
 * Deployed Images modal). On staging/dev where image-update-strategy is
 * 'auto' (Flux Image Automation), the toggle + Update Now button are
 * hidden — the operator gets a "managed by Flux" badge instead.
 */
export default function UpdatesPage() {
  const { data: versionRes, isLoading, refetch } = usePlatformVersion();
  const updateSettings = useUpdateSettings();
  const triggerUpdate = useTriggerUpdate();
  const [autoUpdateLocal, setAutoUpdateLocal] = useState<boolean | null>(null);
  const [showImagesModal, setShowImagesModal] = useState(false);
  const version = versionRes?.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Updates</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Image-update strategy, current vs latest version, deployed image inventory
        </p>
      </div>

      <div
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
        data-testid="platform-updates-section"
      >
        <div className="mb-4 flex items-center gap-2">
          <Download size={20} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Platform Updates</h2>
        </div>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4">
            <Loader2 size={16} className="animate-spin text-gray-400" />
            <span className="text-sm text-gray-500 dark:text-gray-400">Loading…</span>
          </div>
        ) : version ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Current Version</dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="current-version">
                  {version.currentVersion}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Latest Version</dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="latest-version">
                  {version.latestVersion ?? (
                    version.latestSource === 'none' ? (
                      <span className="text-gray-500 dark:text-gray-400">no releases published</span>
                    ) : version.latestSource === 'unreachable' ? (
                      <span className="text-amber-700 dark:text-amber-300">GitHub unreachable</span>
                    ) : (
                      '—'
                    )
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Environment</dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100" data-testid="environment">
                  {version.environment}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Last Checked</dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {version.lastCheckedAt ? new Date(version.lastCheckedAt).toLocaleString() : '—'}
                </dd>
              </div>
            </dl>

            <div className="flex flex-wrap items-center gap-4 border-t border-gray-100 dark:border-gray-700 pt-4">
              {version.imageUpdateStrategy === 'auto' ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-md bg-green-50 dark:bg-green-900/20 px-3 py-1.5 text-sm font-medium text-green-700 dark:text-green-300"
                  data-testid="auto-managed-badge"
                >
                  <CheckCircle size={14} />
                  Auto-managed by Flux — pods roll on every main push
                </span>
              ) : (
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    data-testid="auto-update-toggle"
                    checked={autoUpdateLocal ?? version.autoUpdate}
                    onChange={(e) => {
                      const newValue = e.target.checked;
                      setAutoUpdateLocal(newValue);
                      updateSettings.mutate(newValue);
                    }}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  Automatic Updates
                </label>
              )}

              <button
                type="button"
                data-testid="check-updates-btn"
                onClick={() => refetch()}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
              >
                <RefreshCw size={14} />
                {version.imageUpdateStrategy === 'auto' ? 'Refresh' : 'Check for Updates'}
              </button>

              {version.imageUpdateStrategy === 'manual' && (
                <>
                  <button
                    type="button"
                    data-testid="settings-update-now-btn"
                    disabled={!version.updateAvailable || triggerUpdate.isPending}
                    onClick={() => triggerUpdate.mutate()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {triggerUpdate.isPending ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        Updating…
                      </>
                    ) : (
                      'Update Now'
                    )}
                  </button>

                  {triggerUpdate.isSuccess && (
                    <span className="flex items-center gap-1 text-sm text-green-700 dark:text-green-300">
                      <CheckCircle size={14} />
                      Update started
                    </span>
                  )}
                  {triggerUpdate.isError && (
                    <span className="flex items-center gap-1 text-sm text-red-700 dark:text-red-300">
                      <AlertCircle size={14} />
                      Update failed
                    </span>
                  )}
                </>
              )}

              <button
                type="button"
                onClick={() => setShowImagesModal(true)}
                className="inline-flex items-center gap-2 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
                data-testid="show-deployed-images-button"
              >
                <Container size={14} />
                Show Deployed Images
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">Unable to fetch version information.</p>
        )}
      </div>

      {showImagesModal && <DeployedImagesModal onClose={() => setShowImagesModal(false)} />}
    </div>
  );
}

/**
 * Modal listing the container images + resolved tags currently running
 * on the cluster for platform-owned components. Sourced from the k8s
 * API at request time. Lazy-loaded — the usePlatformImages hook only
 * runs when the modal is mounted.
 */
function DeployedImagesModal({ onClose }: { readonly onClose: () => void }) {
  const { data, isLoading, isError } = usePlatformImages();
  const images = data?.data ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-xl bg-white dark:bg-gray-800 shadow-xl flex flex-col"
        data-testid="platform-images-modal"
      >
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <div className="flex items-center gap-2">
            <Container size={20} className="text-gray-600 dark:text-gray-400" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Deployed Images</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex items-center gap-2 py-8 justify-center">
              <Loader2 size={16} className="animate-spin text-gray-400" />
              <span className="text-sm text-gray-500 dark:text-gray-400">Loading image inventory…</span>
            </div>
          ) : isError ? (
            <p className="text-sm text-red-600 dark:text-red-400">Failed to load image inventory.</p>
          ) : images.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No images enumerated. The backend may lack cluster read permissions.
            </p>
          ) : (
            <table className="min-w-full text-sm" data-testid="platform-images-table">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                  <th className="px-2 py-2 font-medium">Component</th>
                  <th className="px-2 py-2 font-medium">Namespace</th>
                  <th className="px-2 py-2 font-medium">Image</th>
                  <th className="px-2 py-2 font-medium">Tag</th>
                  <th className="px-2 py-2 font-medium text-right">Ready</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {images.map((row) => (
                  <tr key={`${row.namespace}/${row.component}/${row.image}`}>
                    <td className="px-2 py-2 text-gray-900 dark:text-gray-100 font-medium">{row.component}</td>
                    <td className="px-2 py-2 text-gray-600 dark:text-gray-400 font-mono text-xs">{row.namespace}</td>
                    <td className="px-2 py-2 text-gray-600 dark:text-gray-400 font-mono text-xs break-all">{row.image}</td>
                    <td className="px-2 py-2 text-gray-900 dark:text-gray-100 font-mono text-xs">{row.tag}</td>
                    <td className="px-2 py-2 text-right">
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium ${
                          row.healthy ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {row.running}/{row.desired}
                        {row.healthy ? <CheckCircle size={12} /> : <AlertCircle size={12} />}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
