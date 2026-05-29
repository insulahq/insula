/**
 * Admin-side bundle progress modal.
 *
 * Opens after an admin clicks "Bundle now" for a tenant (or "Bundle
 * all eligible tenants"). Polls `GET /api/v1/admin/tenant-bundles/:id`
 * every 2 s until the bundle reaches a terminal state, then stays
 * open with a close button so the operator can review per-component
 * status + sizes.
 *
 * Dismissable mid-run — the bundle keeps orchestrating in the
 * background regardless of whether the modal is open. The
 * orchestrator writes a chip + notification on terminal state so the
 * operator can find the result on the bell.
 *
 * Mirrors the tenant-panel BundleProgressModal — types shared via
 * @insula/ui-restore-cart so both panels render the same shape.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, type ReactElement } from 'react';
import { CheckCircle2, AlertCircle, Loader2, X, FileText, Lock, Mail, Database } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import {
  TERMINAL_BUNDLE_STATES,
  formatBundleBytes,
  type BundleComponent,
  type BundleStatus,
} from '@insula/ui-restore-cart';

interface AdminBundleResponse {
  readonly data: {
    readonly id: string;
    readonly tenantId: string;
    readonly tenantName: string | null;
    readonly status: BundleStatus;
    readonly sizeBytes: number;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly lastError: string | null;
    readonly components: ReadonlyArray<BundleComponent>;
  };
}

function componentIcon(c: BundleComponent['component']) {
  if (c === 'files') return <FileText className="h-4 w-4" />;
  if (c === 'mailboxes') return <Mail className="h-4 w-4" />;
  if (c === 'secrets') return <Lock className="h-4 w-4" />;
  return <Database className="h-4 w-4" />;
}

function statusBadge(status: BundleComponent['status'] | BundleStatus): ReactElement {
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

export function AdminBundleProgressModal({ bundleId, onClose }: Props) {
  const q = useQuery({
    queryKey: ['admin-bundle-detail', bundleId],
    queryFn: () => apiFetch<AdminBundleResponse>(`/api/v1/admin/tenant-bundles/${bundleId}`),
    enabled: Boolean(bundleId),
    refetchInterval: (query) => {
      const status = (query.state.data as AdminBundleResponse | undefined)?.data?.status;
      return status && TERMINAL_BUNDLE_STATES.has(status) ? false : 2000;
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const bundle = q.data?.data;
  const components = bundle?.components ?? [];
  const isTerminal = bundle ? TERMINAL_BUNDLE_STATES.has(bundle.status) : false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-bundle-progress-title"
      data-testid="admin-bundle-progress-modal"
    >
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <header className="flex items-start justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div>
            <h2 id="admin-bundle-progress-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Backup in progress
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {bundle?.tenantName ? `Tenant: ${bundle.tenantName} — ` : ''}
              <span className="font-mono">{bundleId}</span>
            </p>
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
            data-testid="admin-bundle-progress-close"
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
                  data-testid={`admin-component-row-${c.component}`}
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
            data-testid="admin-bundle-progress-dismiss"
          >
            {isTerminal ? 'Close' : 'Run in background'}
          </button>
        </footer>
      </div>
    </div>
  );
}
