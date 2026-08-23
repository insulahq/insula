// "Custom Containers" tab content inside Applications.tsx.
//
// Lists every custom-source deployment for the current tenant with
// a lazy-loaded "Updates available?" pill, an action menu (Edit /
// Restart / Upgrade tag / Manage PAT / Delete), and two top-right "New …"
// buttons that open the simple-form wizard or the compose editor.
//
// The check-updates-batch query fires once on mount (per render of
// this tab) and the result lives in TanStack Query's cache; the
// backend already serves stale results from its 60-min cache row.
//
// Overflow menu is rendered via createPortal(document.body) to escape
// the overflow-x-auto table clip region.

import { useMemo, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ArrowUpCircle, Download, FileText, Loader2, MoreVertical, Pencil, Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import {
  useCustomDeployments,
  useCheckUpdatesBatch,
  useDeleteCustomDeployment,
  useUpdateCustomDeployment,
  useUpdateNowCustomDeployment,
  useStopStartCustomDeployment,
  useSetAutoUpdate,
  useUpgradeTag,
  type CustomDeploymentRow,
} from '@/hooks/use-custom-deployments';
import { getStatusColor } from '@/lib/status-colors';
import { SimpleContainerWizard } from './SimpleContainerWizard';
import { ComposeEditor } from './ComposeEditor';
import { PrivateRegistryPanel } from './PrivateRegistryPanel';
import { UpdatesPill } from './UpdatesPill';

interface CustomContainersTabProps {
  readonly tenantId: string;
  readonly canManage: boolean;
}

type ActiveModal =
  | { kind: 'none' }
  | { kind: 'simple-wizard' }
  | { kind: 'compose-editor' }
  | { kind: 'pat'; row: CustomDeploymentRow }
  | { kind: 'upgrade'; row: CustomDeploymentRow }
  | { kind: 'edit-simple'; row: CustomDeploymentRow }
  | { kind: 'edit-compose'; row: CustomDeploymentRow };

export function CustomContainersTab({ tenantId, canManage }: CustomContainersTabProps) {
  const [activeModal, setActiveModal] = useState<ActiveModal>({ kind: 'none' });
  const [actionMenuOpen, setActionMenuOpen] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useCustomDeployments(tenantId);
  const rows = useMemo(() => data?.data ?? [], [data]);

  const deploymentIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const updatesQuery = useCheckUpdatesBatch(tenantId, deploymentIds);

  const deleteMutation = useDeleteCustomDeployment(tenantId);
  const restartMutation = useUpdateCustomDeployment(tenantId);
  const updateNowMutation = useUpdateNowCustomDeployment(tenantId);
  const stopStartMutation = useStopStartCustomDeployment(tenantId);
  const autoUpdateMutation = useSetAutoUpdate(tenantId);
  // Which row is mid-update, so the button can show a spinner + disable
  // rather than letting an impatient operator queue three rolls.
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const onUpdateNow = (row: CustomDeploymentRow) => {
    setActionMenuOpen(null);
    const isStack = row.customSpec?.sourceMode === 'compose';
    const what = isStack
      ? `all ${Object.keys(row.customSpec?.services ?? {}).length} images in "${row.name}"`
      : `"${row.name}"`;
    if (!confirm(`Re-pull ${what} at the current tag and restart? The container stops briefly while the new image starts.`)) {
      return;
    }
    setUpdatingId(row.id);
    updateNowMutation.mutate(row.id, { onSettled: () => setUpdatingId(null) });
  };

  const onToggleAutoUpdate = (row: CustomDeploymentRow, enabled: boolean) => {
    autoUpdateMutation.mutate({ id: row.id, enabled });
  };

  const onStopStart = (row: CustomDeploymentRow) => {
    const action = row.status === 'stopped' ? 'start' : 'stop';
    if (action === 'stop'
      && !confirm(`Stop "${row.name}"? It scales to 0 and stops restarting — its config, storage and settings are kept, and Start brings it back.`)) {
      return;
    }
    stopStartMutation.mutate({ id: row.id, action });
  };

  const onRestart = (row: CustomDeploymentRow) => {
    setActionMenuOpen(null);
    restartMutation.mutate({ id: row.id, restart: true });
  };

  const onDelete = (row: CustomDeploymentRow) => {
    setActionMenuOpen(null);
    if (!confirm(`Delete custom deployment "${row.name}"? This removes the Pod, Services, and any stored PAT. Volume data on the tenant PVC is preserved.`)) {
      return;
    }
    deleteMutation.mutate(row.id);
  };

  const onEdit = (row: CustomDeploymentRow) => {
    setActionMenuOpen(null);
    if (row.customSpec?.sourceMode === 'compose') {
      setActiveModal({ kind: 'edit-compose', row });
    } else {
      setActiveModal({ kind: 'edit-simple', row });
    }
  };

  // Close action menu on outside click
  useEffect(() => {
    if (!actionMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest('[data-action-menu]')) {
        setActionMenuOpen(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [actionMenuOpen]);

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setActiveModal({ kind: 'simple-wizard' })}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            data-testid="custom-new-container"
          >
            New Container
          </button>
          <button
            type="button"
            onClick={() => setActiveModal({ kind: 'compose-editor' })}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            data-testid="custom-new-stack"
          >
            <FileText size={14} />
            New Stack (compose)
          </button>
        </div>
      )}

      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={16} className="animate-spin" />
          Loading custom containers…
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <div>
            <strong>Failed to load custom containers.</strong>
            <div>{error instanceof Error ? error.message : String(error)}</div>
          </div>
        </div>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <EmptyState canManage={canManage} onSimple={() => setActiveModal({ kind: 'simple-wizard' })} onCompose={() => setActiveModal({ kind: 'compose-editor' })} />
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700" data-testid="custom-deployments-table">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300">Name</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300">Mode</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300">Image / Services</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700 dark:text-gray-300">Updates</th>
                <th className="px-4 py-3 text-right font-medium text-gray-700 dark:text-gray-300">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {rows.map((row) => {
                const serviceCount = Object.keys(row.customSpec?.services ?? {}).length;
                const firstImage = Object.values(row.customSpec?.services ?? {})[0]?.image;
                const updates = updatesQuery.data?.data.results?.[row.id];
                return (
                  <tr
                    key={row.id}
                    data-testid={`custom-row-${row.id}`}
                    className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
                    onClick={() => {
                      if (canManage) onEdit(row);
                    }}
                  >
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{row.name}</td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{row.customSpec?.sourceMode ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                      {row.customSpec?.sourceMode === 'compose' ? `${serviceCount} services` : firstImage ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', getStatusColor(row.status))}>
                        {row.status}
                      </span>
                      {/* The reconciler's diagnostic (CrashLoopBackOff / ImagePullBackOff /
                          OOMKilled / timeout). Previously only lastError was shown, so a
                          crash-looping container displayed a bare status with no reason. */}
                      {row.statusMessage && (
                        <div
                          className={clsx('mt-1 text-xs', row.status === 'failed'
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-amber-600 dark:text-amber-400')}
                          title={row.statusMessage}
                          data-testid={`custom-status-message-${row.id}`}
                        >
                          {row.statusMessage.length > 120 ? `${row.statusMessage.slice(0, 120)}…` : row.statusMessage}
                        </div>
                      )}
                      {row.lastError && (
                        <div className="mt-1 text-xs text-red-600 dark:text-red-400" title={row.lastError}>
                          {row.lastError.slice(0, 80)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex flex-col gap-1.5">
                        <UpdatesPill
                          result={updates}
                          loading={updatesQuery.isLoading}
                          canManage={canManage}
                          onUpgrade={() => setActiveModal({ kind: 'upgrade', row })}
                        />
                        {canManage && (
                          <div className="flex items-center gap-3">
                            {/* Re-pull the CURRENT tag. Separate from the pill,
                                which only appears when a NEWER TAG exists — a
                                republished tag (`:latest`, a rebuilt `:1.27`)
                                is invisible to that check. */}
                            <button
                              type="button"
                              onClick={() => onUpdateNow(row)}
                              disabled={updatingId === row.id}
                              title="Re-pull the current tag and restart"
                              data-testid={`custom-update-now-${row.id}`}
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-blue-400 dark:hover:text-blue-300"
                            >
                              <RefreshCw size={12} className={updatingId === row.id ? 'animate-spin' : undefined} />
                              {updatingId === row.id ? 'Updating…' : 'Update'}
                            </button>
                            {/* Break a CrashLoopBackOff without deleting: scale to 0.
                                Start scales back to 1. */}
                            <button
                              type="button"
                              onClick={() => onStopStart(row)}
                              disabled={stopStartMutation.isPending}
                              title={row.status === 'stopped'
                                ? 'Start this container (scale to 1)'
                                : 'Stop this container (scale to 0) — breaks a restart loop; config and storage are kept'}
                              data-testid={`custom-stop-start-${row.id}`}
                              className={clsx(
                                'inline-flex items-center gap-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50',
                                row.status === 'stopped'
                                  ? 'text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300'
                                  : 'text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300',
                              )}
                            >
                              {row.status === 'stopped'
                                ? (<><Play size={12} />Start</>)
                                : (<><Square size={12} />Stop</>)}
                            </button>
                            {/* Single-container only: a stack has one digest per
                                service, so "the image changed" has no single
                                meaning to act on. */}
                            {row.customSpec?.sourceMode === 'simple' && (
                              <label
                                className="inline-flex cursor-pointer items-center gap-1 text-xs text-gray-600 dark:text-gray-400"
                                title="Check hourly and re-pull automatically when this tag is republished. Never changes the tag."
                              >
                                <input
                                  type="checkbox"
                                  checked={row.customSpec?.autoUpdate ?? false}
                                  onChange={(e) => onToggleAutoUpdate(row, e.target.checked)}
                                  disabled={autoUpdateMutation.isPending}
                                  data-testid={`custom-auto-update-${row.id}`}
                                  className="h-3 w-3 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
                                />
                                Auto
                              </label>
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      {canManage && (
                        <ActionMenu
                          row={row}
                          open={actionMenuOpen === row.id}
                          onToggle={() => setActionMenuOpen(actionMenuOpen === row.id ? null : row.id)}
                          onEdit={() => onEdit(row)}
                          onRestart={() => onRestart(row)}
                          onUpdateNow={() => onUpdateNow(row)}
                          onUpgrade={() => { setActionMenuOpen(null); setActiveModal({ kind: 'upgrade', row }); }}
                          onPat={() => { setActionMenuOpen(null); setActiveModal({ kind: 'pat', row }); }}
                          onDelete={() => onDelete(row)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeModal.kind === 'simple-wizard' && (
        <SimpleContainerWizard
          tenantId={tenantId}
          existingNames={rows.map((r) => r.name)}
          onClose={() => setActiveModal({ kind: 'none' })}
          onCreated={() => { setActiveModal({ kind: 'none' }); refetch(); }}
        />
      )}
      {activeModal.kind === 'edit-simple' && (
        <SimpleContainerWizard
          tenantId={tenantId}
          existingNames={rows.map((r) => r.name)}
          existingDeployment={activeModal.row}
          onClose={() => setActiveModal({ kind: 'none' })}
          onCreated={() => { setActiveModal({ kind: 'none' }); refetch(); }}
        />
      )}
      {activeModal.kind === 'compose-editor' && (
        <ComposeEditor
          tenantId={tenantId}
          existingNames={rows.map((r) => r.name)}
          onClose={() => setActiveModal({ kind: 'none' })}
          onCreated={() => { setActiveModal({ kind: 'none' }); refetch(); }}
        />
      )}
      {activeModal.kind === 'edit-compose' && (
        <ComposeEditor
          tenantId={tenantId}
          existingNames={rows.map((r) => r.name)}
          existingDeployment={activeModal.row}
          onClose={() => setActiveModal({ kind: 'none' })}
          onCreated={() => { setActiveModal({ kind: 'none' }); refetch(); }}
        />
      )}
      {activeModal.kind === 'pat' && (
        <PrivateRegistryPanel
          tenantId={tenantId}
          deploymentId={activeModal.row.id}
          deploymentName={activeModal.row.name}
          onClose={() => setActiveModal({ kind: 'none' })}
        />
      )}
      {activeModal.kind === 'upgrade' && (
        <UpgradeTagModal
          tenantId={tenantId}
          row={activeModal.row}
          suggestedImage={
            (() => {
              const s = Object.values(activeModal.row.customSpec?.services ?? {})[0];
              const updates = updatesQuery.data?.data.results?.[activeModal.row.id];
              if (s && updates?.latest && updates.status !== 'unknown' && updates.status !== 'no-update') {
                const idx = s.image.lastIndexOf(':');
                return idx > 0 && !s.image.includes('@') ? `${s.image.slice(0, idx)}:${updates.latest}` : s.image;
              }
              return s?.image ?? '';
            })()
          }
          onClose={() => setActiveModal({ kind: 'none' })}
        />
      )}
    </div>
  );
}

// ─── Portal-based action menu ────────────────────────────────────────────────

interface ActionMenuProps {
  row: CustomDeploymentRow;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onRestart: () => void;
  onUpdateNow: () => void;
  onUpgrade: () => void;
  onPat: () => void;
  onDelete: () => void;
}

function ActionMenu({ row, open, onToggle, onEdit, onRestart, onUpdateNow, onUpgrade, onPat, onDelete }: ActionMenuProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({
        top: rect.bottom + window.scrollY + 4,
        right: window.innerWidth - rect.right,
      });
    }
  }, [open]);

  return (
    <div className="relative inline-block" data-action-menu>
      <button
        ref={btnRef}
        type="button"
        onClick={onToggle}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
        data-testid={`custom-actions-${row.id}`}
      >
        <MoreVertical size={16} />
      </button>
      {open && menuPos && createPortal(
        <div
          data-action-menu
          style={{ position: 'absolute', top: menuPos.top, right: menuPos.right, zIndex: 9999 }}
          className="w-48 rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-600 dark:bg-gray-800"
        >
          <button
            type="button"
            onClick={onEdit}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <Pencil size={14} /> Edit
          </button>
          <button
            type="button"
            onClick={onRestart}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <RefreshCw size={14} /> Restart
          </button>
          <button
            type="button"
            onClick={onUpdateNow}
            title="Re-pull the current tag and restart"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <Download size={14} /> Update (re-pull image)
          </button>
          {row.customSpec?.sourceMode === 'simple' && (
            <button
              type="button"
              onClick={onUpgrade}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <ArrowUpCircle size={14} /> Upgrade tag
            </button>
          )}
          <button
            type="button"
            onClick={onPat}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <Pencil size={14} /> Manage PAT
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────

function EmptyState({ canManage, onSimple, onCompose }: { canManage: boolean; onSimple: () => void; onCompose: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-6 py-12 text-center dark:border-gray-700">
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">No custom containers yet</h3>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Run any Docker image or compose stack alongside your catalog applications. Data lives on your tenant PVC; private registries are supported via PAT.
      </p>
      {canManage && (
        <div className="mt-4 flex justify-center gap-2">
          <button
            type="button"
            onClick={onSimple}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            New Container
          </button>
          <button
            type="button"
            onClick={onCompose}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <FileText size={14} />
            New Stack (compose)
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Upgrade-tag modal (inline — small enough not to warrant a file) ────────

function UpgradeTagModal({
  tenantId,
  row,
  suggestedImage,
  onClose,
}: {
  tenantId: string;
  row: CustomDeploymentRow;
  suggestedImage: string;
  onClose: () => void;
}) {
  const [image, setImage] = useState(suggestedImage);
  const [error, setError] = useState<string | null>(null);
  const mutation = useUpgradeTag(tenantId);

  const submit = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({ id: row.id, image });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upgrade failed');
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Upgrade tag</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Replace the image for <span className="font-mono">{row.name}</span>. The Pod restarts immediately.
        </p>
        <label className="mt-4 block text-sm font-medium text-gray-700 dark:text-gray-300">New image</label>
        <input
          type="text"
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder="nginx:1.27.5"
          autoFocus
        />
        {error && <div className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={mutation.isPending || !image.trim()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {mutation.isPending ? 'Upgrading…' : 'Upgrade'}
          </button>
        </div>
      </div>
    </div>
  );
}
