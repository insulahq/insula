/**
 * Tenant on-demand bundle progress modal.
 *
 * Opens after a successful POST /tenants/:tenantId/bundles/run-now,
 * polls GET /tenants/:tenantId/bundles/:id/status every 2 seconds,
 * and renders per-component progress (config, secrets, files,
 * mailboxes) as a step list. Closes when the bundle reaches a
 * terminal state (`completed`, `partial`, `failed`) and the user
 * acknowledges, OR when the user clicks "Dismiss" mid-run (the
 * bundle keeps running in the background).
 *
 * No new backend state — components rows already carry status,
 * size, timestamps, and lastError. We just render them.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, type ReactElement } from 'react';
import { CheckCircle2, AlertCircle, Loader2, X, FileText, Lock, Mail, Database } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import {
  TERMINAL_BUNDLE_STATES,
  formatBundleBytes,
  type BundleComponent,
  type BundleStatus,
  type BundleStatusResponse,
  type ComponentStatus,
} from '@k8s-hosting/ui-restore-cart';

function componentIcon(c: BundleComponent['component']) {
  if (c === 'files') return <FileText className="h-4 w-4" />;
  if (c === 'mailboxes') return <Mail className="h-4 w-4" />;
  if (c === 'secrets') return <Lock className="h-4 w-4" />;
  return <Database className="h-4 w-4" />;
}

function statusBadge(status: ComponentStatus | BundleStatus): ReactElement {
  const map: Record<string, string> = {
    pending: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    completed: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    partial: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    skipped: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  };
  const cls = map[status] ?? map.pending;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>;
}


interface Props {
  readonly bundleId: string;
  readonly onClose: () => void;
}

export function BundleProgressModal({ bundleId, onClose }: Props) {
  const tenantId = useAuth((s) => s.user?.tenantId) ?? '';

  const q = useQuery({
    queryKey: ['tenant-bundle-status', tenantId, bundleId],
    queryFn: () => apiFetch<BundleStatusResponse>(`/api/v1/tenants/${tenantId}/bundles/${bundleId}/status`),
    enabled: Boolean(tenantId && bundleId),
    // TanStack Query v5 passes the Query object (not the data) to
    // refetchInterval. We reach into query.state.data which is the
    // typed apiFetch return value (BundleStatusResponse). Polling
    // stops once the bundle reaches a terminal state — without this,
    // the modal keeps refetching every 2 s indefinitely.
    refetchInterval: (query) => {
      const bundle = (query.state.data as BundleStatusResponse | undefined)?.data?.bundle;
      return bundle && TERMINAL_BUNDLE_STATES.has(bundle.status) ? false : 2000;
    },
  });

  // Close on Escape — modal convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const bundle = q.data?.data?.bundle;
  const components = q.data?.data?.components ?? [];
  const isTerminal = bundle ? TERMINAL_BUNDLE_STATES.has(bundle.status) : false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bundle-progress-title"
      data-testid="bundle-progress-modal"
    >
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <header className="flex items-start justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div>
            <h2 id="bundle-progress-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Backup in progress
            </h2>
            <p className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">{bundleId}</p>
            {bundle && (
              <div className="mt-1 flex items-center gap-2 text-xs">
                {statusBadge(bundle.status)}
                {bundle.sizeBytes > 0 && (
                  <span className="text-gray-500 dark:text-gray-400">
                    {formatBundleBytes(bundle.sizeBytes)} total
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            aria-label="Close"
            data-testid="bundle-progress-close"
          >
            <X size={20} />
          </button>
        </header>

        <div className="px-4 py-3">
          {q.isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
              <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Loading…</span>
            </div>
          )}
          {q.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/40 dark:text-red-200">
              {(q.error as Error).message}
            </div>
          )}
          {bundle && components.length === 0 && bundle.status === 'pending' && (
            <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
              Starting components…
            </p>
          )}
          {components.length > 0 && (
            <ul className="space-y-2">
              {components.map((c: BundleComponent) => (
                <li
                  key={c.id}
                  className="flex items-start gap-3 rounded-md border border-gray-200 px-3 py-2 dark:border-gray-700"
                  data-testid={`component-row-${c.component}`}
                >
                  <div className="mt-0.5 flex-shrink-0 text-gray-500 dark:text-gray-400">
                    {componentIcon(c.component)}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {c.component}
                      </span>
                      {statusBadge(c.status)}
                      {c.sizeBytes > 0 && (
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {formatBundleBytes(c.sizeBytes)}
                        </span>
                      )}
                    </div>
                    {c.lastError && (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-300">{c.lastError}</p>
                    )}
                  </div>
                  <div className="mt-0.5 flex-shrink-0">
                    {c.status === 'completed' && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                    {c.status === 'failed' && <AlertCircle className="h-4 w-4 text-red-600" />}
                    {c.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-blue-600" />}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {bundle?.lastError && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-700 dark:bg-red-900/40 dark:text-red-200">
              {bundle.lastError}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-gray-200 p-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            data-testid="bundle-progress-dismiss"
          >
            {isTerminal ? 'Close' : 'Run in background'}
          </button>
        </footer>
      </div>
    </div>
  );
}
