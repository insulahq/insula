import { useState } from 'react';
import { Archive, Download, Lock, Loader2, AlertCircle, Play, RotateCcw } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  useTenantBundles,
  useRunBundleNow,
  downloadTenantDataExport,
} from '@/hooks/use-tenant-backups';
import { BundleProgressModal } from '@/components/BundleProgressModal';

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function StatusBadge({ status }: { readonly status: string }) {
  const colorMap: Record<string, string> = {
    completed: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700',
    running: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700',
    pending: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700',
    partial: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700',
    failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700',
    expired: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600',
  };
  const colors = colorMap[status.toLowerCase()] ?? 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600';
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${colors}`}>{status}</span>;
}

export default function Backups() {
  const bundlesQ = useTenantBundles();
  const runNow = useRunBundleNow();
  const bundles = bundlesQ.data?.data ?? [];
  // Track the in-flight bundle id from the most recent run-now click
  // so we can open BundleProgressModal. Cleared via modal onClose.
  const [progressBundleId, setProgressBundleId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400">
          <Archive size={20} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="backups-heading">
            Backups
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Your bundles, on-demand captures, and restore tools. Scheduled backups are managed centrally by your platform admins.
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            runNow.mutate(undefined, {
              onSuccess: (res) => {
                const id = res?.data?.bundleId;
                if (id) setProgressBundleId(id);
              },
            })
          }
          disabled={runNow.isPending}
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          data-testid="run-backup-now"
        >
          {runNow.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run backup now
        </button>
      </div>
      {runNow.error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/40 dark:text-red-200">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <span>{(runNow.error as Error).message}</span>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {bundlesQ.isLoading && (
          <div className="flex items-center justify-center py-16" data-testid="backups-loading">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
            <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">Loading bundles…</span>
          </div>
        )}
        {bundlesQ.isError && (
          <div className="px-6 py-16 text-center" data-testid="backups-error">
            <p className="text-sm text-red-600">Failed to load bundles: {(bundlesQ.error as Error)?.message ?? 'Unknown error'}</p>
          </div>
        )}
        {!bundlesQ.isLoading && !bundlesQ.isError && bundles.length === 0 && (
          <div className="px-6 py-16 text-center" data-testid="backups-empty">
            <Archive size={40} className="mx-auto text-gray-300 dark:text-gray-600" />
            <p className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">No bundles yet</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Click &quot;Run backup now&quot; to create one, or wait for the next scheduled bundle.
            </p>
          </div>
        )}
        {!bundlesQ.isLoading && !bundlesQ.isError && bundles.length > 0 && (
          <div className="overflow-x-auto" data-testid="backups-table">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50">
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Bundle</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Initiator</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 dark:text-gray-400 sm:table-cell">Size</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 dark:text-gray-400 lg:table-cell">Created</th>
                  <th className="hidden px-6 py-3 font-medium text-gray-500 dark:text-gray-400 lg:table-cell">Expires</th>
                  <th className="px-6 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bundles.map((b) => (
                  <tr key={b.id} className="border-b border-gray-100 dark:border-gray-700 last:border-0">
                    <td className="px-6 py-3 font-mono text-xs text-gray-900 dark:text-gray-100">
                      {b.label ?? b.id.slice(0, 12)}
                    </td>
                    <td className="px-6 py-3 text-gray-600 dark:text-gray-400">{b.initiator}</td>
                    <td className="px-6 py-3"><StatusBadge status={b.status} /></td>
                    <td className="hidden px-6 py-3 text-gray-600 dark:text-gray-400 sm:table-cell">{formatBytes(b.sizeBytes)}</td>
                    <td className="hidden px-6 py-3 text-gray-500 dark:text-gray-400 lg:table-cell">{new Date(b.createdAt).toLocaleString()}</td>
                    <td className="hidden px-6 py-3 text-gray-500 dark:text-gray-400 lg:table-cell">
                      {b.expiresAt ? new Date(b.expiresAt).toLocaleDateString() : '-'}
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-2">
                        {(b.status === 'completed' || b.status === 'partial') && (
                          <Link
                            to={`/backups/restore/${b.id}`}
                            className="inline-flex items-center gap-1 rounded-md border border-blue-300 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-950"
                            data-testid={`restore-from-${b.id}`}
                            title="Open a restore cart for this bundle"
                          >
                            <RotateCcw size={12} /> Restore
                          </Link>
                        )}
                        {b.exportArtifact && b.status === 'completed' && (
                          <button
                            type="button"
                            onClick={async () => {
                              try { await downloadTenantDataExport(b.id); }
                              catch (e) { window.alert(`Download failed: ${(e as Error).message}`); }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-purple-300 px-2 py-1 text-xs font-medium text-purple-700 hover:bg-purple-50 dark:border-purple-700 dark:text-purple-300 dark:hover:bg-purple-950"
                            title="Download the encrypted GDPR data-export."
                          >
                            <Download size={12} /> GDPR <Lock size={10} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {progressBundleId && (
        <BundleProgressModal
          bundleId={progressBundleId}
          onClose={() => setProgressBundleId(null)}
        />
      )}
    </div>
  );
}

// ScheduleEditor was removed 2026-05-28. Per platform policy, tenants
// can no longer set their own backup schedule — scheduled bundles
// are driven by a single platform-global cron. Operators inclusion-
// gate per-plan via `hosting_plans.include_in_scheduled_bundles`.
