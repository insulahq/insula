import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api-client';
import { X, Play, Square, Cpu, HardDrive, Server, Clock, Shield, Eye, EyeOff, AppWindow, Loader2, Database, AlertTriangle, Tag as TagIcon, Save, AlertCircle, Terminal, RefreshCw, Pencil } from 'lucide-react';
import { getStatusColor } from '@/lib/status-colors';
import { useUpdateDeploymentResources, useUpdateDeployment, useResourceAvailability, useDeploymentLiveMetrics, useSwitchDeploymentVersion } from '@/hooks/use-deployments';
import ExtraMountsEditor, { extraMountErrors, type ExtraMountRow } from './ExtraMountsEditor';
import { useSetMultihost } from '@/hooks/use-deployments';
import NetworkAccessSection from '@/components/NetworkAccessSection';
import AvailableUpgradesCard from '@/components/AvailableUpgradesCard';
import { ResourceBreakdown } from '@/components/ResourceBreakdown';
import { useCatalogEntryVersions } from '@/hooks/use-catalog';
import clsx from 'clsx';

/**
 * Tenant paths are stored WITHOUT a leading slash (`runtime/apache-php/site`),
 * which renders as something that looks relative and cannot be pasted into the
 * file manager or an SFTP client. Display them absolute.
 */
function absPath(p: string | null | undefined): string {
  const v = (p ?? '').trim();
  if (!v || v === '.') return '/';
  return v.startsWith('/') ? v : `/${v}`;
}

/** Resolve a catalog volume's `local_path` (often ".") against the storage root. */
function joinTenantPath(base: string | null | undefined, localPath?: string | null): string {
  const rel = (localPath ?? '').trim();
  const segs = [base ?? '', rel === '.' || rel === './' ? '' : rel]
    .flatMap((seg) => seg.split('/'))
    .filter((seg) => seg !== '' && seg !== '.');
  return `/${segs.join('/')}`;
}

/** Numeric-segment compare, enough to tell an upgrade from a downgrade. */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
import DatabaseManagementModal from './DatabaseManagementModal';
import LogViewer from './LogViewer';
import ChangeStoragePathModal from './ChangeStoragePathModal';
import WebTerminal from './WebTerminal';
import type { Deployment, CatalogEntry } from '@/types/api';

interface ComponentEntry {
  readonly name?: string;
  readonly type?: string;
  readonly image?: string;
}

interface ParameterEntry {
  readonly key?: string;
  readonly label?: string;
  readonly type?: string;
  readonly default?: unknown;
  readonly required?: boolean;
}

interface VolumeEntry {
  readonly local_path?: string;
  readonly container_path?: string;
  readonly description?: string;
  readonly optional?: boolean;
}

function parseJsonField<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function getIconUrl(entryId: string | null | undefined): string | null {
  if (!entryId) return null;
  return `${API_BASE}/api/v1/catalog/${entryId}/icon`;
}

function AppIcon({ entryId, size = 48 }: { readonly entryId?: string | null; readonly size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = getIconUrl(entryId);
  if (!url || failed) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-700" style={{ width: size, height: size }}>
        <AppWindow size={size * 0.5} className="text-gray-400" />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="rounded-lg object-contain"
      style={{ width: size, height: size }}
    />
  );
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

const typeBadgeColors: Record<string, string> = {
  deployment: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  statefulset: 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  cronjob: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  job: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

interface InstalledAppDetailModalProps {
  readonly open: boolean;
  readonly deployment: Deployment | null;
  readonly catalogEntry: CatalogEntry | null;
  readonly tenantId: string | undefined;
  readonly onClose: () => void;
  readonly onToggleStatus: (deploymentId: string, newStatus: 'running' | 'stopped') => void;
  readonly isToggling: boolean;
  readonly onRestart?: (id: string) => void;
}

export default function InstalledAppDetailModal({
  open,
  deployment,
  catalogEntry,
  tenantId,
  onClose,
  onToggleStatus,
  isToggling,
  onRestart,
}: InstalledAppDetailModalProps) {
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [dbModalOpen, setDbModalOpen] = useState(false);
  const { data: versionsData } = useCatalogEntryVersions(catalogEntry?.id);

  // Multi-host serving. The capability is DECLARED by the catalog entry — the
  // control is not offered at all for an application that cannot do it, rather
  // than offered and then refused by the API.
  const setMultihost = useSetMultihost(tenantId);
  const multihostCapable = Boolean((catalogEntry as { multihost?: unknown } | null)?.multihost);
  // `deployment` is null while the modal is mounted but closed — these hooks
  // run before the component's own null guard further down.
  const multihostOn = Boolean((deployment as { multihostEnabled?: boolean } | null)?.multihostEnabled);

  // ─── Resource editing (Issue 7) ─────────────────────────────────────────────
  const [editingResources, setEditingResources] = useState(false);
  const [editCpu, setEditCpu] = useState('');
  const [editMemoryValue, setEditMemoryValue] = useState('');
  const [editMemoryUnit, setEditMemoryUnit] = useState<'Mi' | 'Gi'>('Mi');
  const queryClient = useQueryClient();
  // Derived: combine value + unit for submission
  const editMemory = `${editMemoryValue}${editMemoryUnit}`;
  const updateResources = useUpdateDeploymentResources(tenantId);
  const availability = useResourceAvailability(tenantId, editingResources ? deployment?.id : undefined);
  const avail = availability.data?.data;
  const [showLogs, setShowLogs] = useState(false);
  const [changingStoragePath, setChangingStoragePath] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const liveMetrics = useDeploymentLiveMetrics(tenantId, deployment?.status === 'running' ? deployment?.id : undefined);

  // ─── Configuration editing ────────────────────────────────────────────────
  // Version switching replaces the old one-step Rollback button: any listed
  // version is selectable, including older ones. The platform's lock-mode
  // guard is the authority on what is permitted, so its error is surfaced
  // verbatim rather than second-guessed here.
  const [versionTarget, setVersionTarget] = useState<string | null>(null);
  // Hooks run before the null guard below, so these are optional-chained.
  const switchVersion = useSwitchDeploymentVersion(deployment?.tenantId, deployment?.id ?? '');

  const [editingConfig, setEditingConfig] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const updateDeployment = useUpdateDeployment(tenantId);
  const [editingMounts, setEditingMounts] = useState(false);
  const [mountRows, setMountRows] = useState<ExtraMountRow[]>([]);

  if (!open || !deployment) return null;

  const isDatabase = catalogEntry?.type === 'database';

  const components = parseJsonField<readonly ComponentEntry[]>(catalogEntry?.components) ?? (Array.isArray(catalogEntry?.components) ? catalogEntry.components as readonly ComponentEntry[] : []);

  const parameters = parseJsonField<readonly ParameterEntry[]>(catalogEntry?.parameters) ?? (Array.isArray(catalogEntry?.parameters) ? catalogEntry.parameters as readonly ParameterEntry[] : []);

  const volumes: readonly VolumeEntry[] = (() => {
    const raw = catalogEntry?.volumes;
    if (raw == null) return [];
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return Array.isArray(raw) ? raw : [];
  })();

  const configuration: Record<string, unknown> = (() => {
    const raw = deployment.configuration;
    if (raw == null) return {};
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
      } catch {
        return {};
      }
    }
    return typeof raw === 'object' ? raw as Record<string, unknown> : {};
  })();

  const configKeys = Object.keys(configuration);

  const secretKeys = new Set(
    parameters
      .filter((p) => p.type === 'secret')
      .map((p) => p.key)
      .filter((k): k is string => k != null),
  );

  // Derive configurable env var keys from catalog entry
  const configurableKeys = new Set<string>(
    (() => {
      const raw = catalogEntry?.envVars;
      if (raw == null) return [];
      const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
      if (parsed && typeof parsed === 'object' && 'configurable' in parsed && Array.isArray((parsed as Record<string, unknown>).configurable)) {
        return (parsed as { configurable: string[] }).configurable;
      }
      return [];
    })(),
  );

  // Keys to show in the Configuration table: the ones this deployment actually
  // has, PLUS any the catalog declares configurable but that were never set at
  // deploy time. Without the second group an optional variable (e.g.
  // NGINX_CONF_DIR / APACHE_CONF_DIR, whose default is "") is unreachable
  // forever — the section rendered "No custom configuration" and offered no way
  // to add it.
  const unsetConfigurableKeys = [...configurableKeys].filter((k) => !(k in configuration)).sort();
  const displayKeys = [...configKeys, ...unsetConfigurableKeys];

  const enterConfigEdit = () => {
    const initial: Record<string, string> = {};
    for (const key of displayKeys) {
      if (configurableKeys.has(key)) {
        initial[key] = String(configuration[key] ?? '');
      }
    }
    setEditValues(initial);
    setEditingConfig(true);
  };

  const saveConfigEdit = () => {
    // Don't persist empty strings for keys that were never set — leaving them
    // absent keeps the stored configuration to what the tenant actually chose.
    const cleaned = Object.fromEntries(
      Object.entries(editValues).filter(([k, v]) => v !== '' || k in configuration),
    );
    const merged: Record<string, unknown> = { ...configuration, ...cleaned };
    updateDeployment.mutate(
      { deploymentId: deployment.id, configuration: merged },
      {
        onSuccess: () => {
          setEditingConfig(false);
          queryClient.invalidateQueries({ queryKey: ['deployments'] });
          // No onRestart here. The backend now re-renders the pod template from
          // the saved configuration and rolls the pods itself, so an extra
          // POST /restart would delete the pod that redeploy just created —
          // a second, pointless bounce.
          //
          // This restart used to be the only thing that happened at all: the
          // config was persisted, the template was never updated, and deleting
          // the pod brought it back byte-identical. That is why the setting
          // appeared not to work.
          onClose();
        },
      },
    );
  };

  const saveMounts = () => {
    // Same shape as saveConfigEdit: apply, invalidate, close. The redeploy
    // that applies a mount change happens server-side.
    const filled = mountRows.filter(m => m.folder.trim() !== '' && m.mount_path.trim() !== '');
    updateDeployment.mutate(
      { deploymentId: deployment.id, extra_mounts: filled },
      {
        onSuccess: () => {
          setEditingMounts(false);
          queryClient.invalidateQueries({ queryKey: ['deployments'] });
          // Server-side redeploy already rolls the pod (it always did for
          // mounts) — see saveConfigEdit.
          onClose();
        },
      },
    );
  };

  const mountsInvalid = Object.keys(extraMountErrors(mountRows)).length > 0;

  const toggleSecret = (key: string) => {
    const next = new Set(revealedSecrets);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setRevealedSecrets(next);
  };

  const isActionable = deployment.status === 'running' || deployment.status === 'stopped' || deployment.status === 'failed';
  const isTransitioning = deployment.status === 'deploying' || deployment.status === 'pending' || deployment.status === 'upgrading';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" data-testid="installed-app-detail-modal">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />

      {/* Panel */}
      <div
        className="relative w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-label={`${deployment.name} details`}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-4">
            <AppIcon entryId={catalogEntry?.id} size={48} />
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                {deployment.name}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {catalogEntry?.name ?? 'Unknown application'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${getStatusColor(deployment.status)}`}
            >
              {deployment.status}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              data-testid="modal-close-button"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Last Error Banner */}
        {deployment.lastError && (
          <div
            className="mb-6 flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400"
            data-testid="last-error-banner"
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>Last error: {deployment.lastError}</span>
          </div>
        )}

        {/* Available updates — only renders when there's an upgrade or rollback available */}
        {tenantId && (
          <AvailableUpgradesCard
            tenantId={tenantId}
            deploymentId={deployment.id}
            deploymentName={deployment.name}
            installedVersion={deployment.installedVersion}
          />
        )}

        {/* Status Section */}
        <div className="mb-6 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
            <Clock size={16} className="text-blue-600 dark:text-blue-400" />
            Status Details
          </h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Installed Version</span>
              <p className="text-gray-900 dark:text-gray-100">{deployment.installedVersion ?? 'latest'}</p>
            </div>
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Created</span>
              <p className="text-gray-900 dark:text-gray-100">{formatDate(deployment.createdAt)}</p>
            </div>
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">K8s Name</span>
              <p className="font-mono text-gray-900 dark:text-gray-100">{deployment.name}</p>
            </div>
            {deployment.storagePath && (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Storage Path</span>
                <div className="flex items-center gap-2">
                  <p className="font-mono text-gray-900 dark:text-gray-100">{absPath(deployment.storagePath)}</p>
                  <button
                    type="button"
                    onClick={() => setChangingStoragePath(true)}
                    className="shrink-0 rounded-md border border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                    data-testid="change-storage-path-button"
                  >
                    Change
                  </button>
                </div>
              </div>
            )}
            {deployment.lastUpgradedAt && (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Last Upgraded</span>
                <p className="text-gray-900 dark:text-gray-100">{formatDate(deployment.lastUpgradedAt)}</p>
              </div>
            )}
            {deployment.domainName && (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Domain</span>
                <p className="text-gray-900 dark:text-gray-100">{deployment.domainName}</p>
              </div>
            )}
          </div>
        </div>

        {/* Supported Versions */}
        {(versionsData?.data ?? []).length > 0 && (
          <div className="mb-6">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
              <TagIcon size={16} className="text-blue-600 dark:text-blue-400" />
              Supported Versions
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {(versionsData?.data ?? []).map(v => {
                const isInstalled = deployment.installedVersion === v.version;
                return (
                  <button
                    key={v.id}
                    type="button"
                    disabled={isInstalled || switchVersion.isPending}
                    onClick={() => setVersionTarget(v.version)}
                    title={isInstalled ? 'Currently installed' : `Switch to ${v.version}`}
                    data-testid={`version-${v.version}`}
                    className={clsx(
                      'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors',
                      isInstalled
                        ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium cursor-default'
                        : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-blue-300 dark:hover:border-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-700 dark:hover:text-blue-300 disabled:opacity-50',
                    )}
                  >
                    {v.version}
                    {v.isDefault ? <span className="text-[10px] font-medium text-blue-500 dark:text-blue-400">default</span> : null}
                    {isInstalled ? <span className="text-[10px] font-medium text-green-600 dark:text-green-400">installed</span> : null}
                  </button>
                );
              })}
              {deployment.status === 'running' && onRestart && (
                <button
                  type="button"
                  onClick={() => { onRestart(deployment.id); onClose(); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 dark:border-blue-600 bg-blue-50 dark:bg-blue-900/30 px-3 py-1.5 text-sm font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
                  data-testid="pull-latest-restart"
                >
                  <RefreshCw size={14} />
                  Pull Latest
                </button>
              )}
            </div>
          </div>
        )}

        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <Cpu size={16} className="text-blue-600 dark:text-blue-400" />
              Assigned Resources
            </h3>
            {!editingResources && (
              <button
                type="button"
                onClick={() => {
                  setEditCpu(deployment.cpuRequest);
                  // Parse "256Mi" or "1Gi" into value + unit
                  const mem = deployment.memoryRequest;
                  if (mem.endsWith('Gi')) { setEditMemoryValue(mem.slice(0, -2)); setEditMemoryUnit('Gi'); }
                  else if (mem.endsWith('Mi')) { setEditMemoryValue(mem.slice(0, -2)); setEditMemoryUnit('Mi'); }
                  else { setEditMemoryValue(mem); setEditMemoryUnit('Mi'); }
                  setEditingResources(true);
                }}
                className="rounded-md border border-blue-300 dark:border-blue-600 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                data-testid="edit-resources-button"
              >
                Edit
              </button>
            )}
          </div>
          {editingResources ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label
                    className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1"
                    title="Your CPU baseline — guaranteed minimum. When neighbour customers are idle, your pods can burst above this value (shared CPU model)."
                  >
                    CPU baseline (burstable)
                  </label>
                  <input
                    type="text"
                    value={editCpu}
                    onChange={(e) => setEditCpu(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    data-testid="edit-cpu-input"
                  />
                  {avail && (
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                      Min: {avail.cpu.min} &middot; Max: {avail.cpu.max} cores
                    </p>
                  )}
                </div>
                <div>
                  <label
                    className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1"
                    title="Memory is guaranteed — your pods always have access to this amount but cannot exceed it without restart."
                  >
                    Memory (guaranteed)
                  </label>
                  <div className="flex gap-1">
                    <input
                      type="number"
                      min="1"
                      value={editMemoryValue}
                      onChange={(e) => setEditMemoryValue(e.target.value)}
                      className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      data-testid="edit-memory-input"
                    />
                    <select
                      value={editMemoryUnit}
                      onChange={(e) => setEditMemoryUnit(e.target.value as 'Mi' | 'Gi')}
                      className="rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none"
                      data-testid="edit-memory-unit"
                    >
                      <option value="Mi">MB</option>
                      <option value="Gi">GB</option>
                    </select>
                  </div>
                  {avail && (
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                      Min: {avail.memory.min} &middot; Max: {avail.memory.max}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <AlertCircle size={12} className="shrink-0" />
                <span>Applying changes will restart the deployment</span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    updateResources.mutate(
                      { deploymentId: deployment.id, cpu_request: editCpu, memory_request: editMemory },
                      {
                        onSuccess: () => {
                          setEditingResources(false);
                          queryClient.invalidateQueries({ queryKey: ['deployments'] });
                          onClose();
                        },
                      },
                    );
                  }}
                  disabled={updateResources.isPending || (editCpu === deployment.cpuRequest && editMemory === deployment.memoryRequest)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="apply-resources-button"
                >
                  {updateResources.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  Apply Changes
                </button>
                <button
                  type="button"
                  onClick={() => setEditingResources(false)}
                  className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  Cancel
                </button>
              </div>
              {updateResources.isError && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {updateResources.error instanceof Error ? updateResources.error.message : 'Failed to update resources'}
                </p>
              )}
              {/* Per-component breakdown — surfaced while editing so the user
                  sees what their CPU/memory split looks like across the app. */}
              <ResourceBreakdown tenantId={deployment.tenantId} deploymentId={deployment.id} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <DetailMetricCard
                icon={<Cpu size={16} className="mx-auto mb-1 text-gray-400" />}
                label="CPU"
                request={deployment.cpuRequest}
                used={liveMetrics.data?.data?.cpuUsed}
                type="cpu"
              />
              <DetailMetricCard
                icon={<HardDrive size={16} className="mx-auto mb-1 text-gray-400" />}
                label="Memory"
                request={deployment.memoryRequest}
                used={liveMetrics.data?.data?.memoryUsedMi}
                type="memory"
              />
              {(() => {
                const storageBytes = liveMetrics.data?.data?.storageUsedBytes ?? 0;
                const usedGb = storageBytes / (1024 * 1024 * 1024);
                const pct = Math.min((usedGb / 10) * 100, 100);
                const barColor = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-500' : 'bg-green-500';
                return (
                  <div className="col-span-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50 p-3 text-center">
                    <HardDrive size={16} className="mx-auto mb-1 text-gray-400" />
                    <p className="text-xs text-gray-500 dark:text-gray-400">Disk Usage</p>
                    <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{liveMetrics.data?.data?.storageUsedFormatted ?? '0 B'}</p>
                    <div className="mt-1.5 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
                      <div className={clsx('h-full rounded-full transition-all', barColor)} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
          {/* Per-component breakdown (read-only view). Hidden for
              single-component apps where the breakdown adds no info. */}
          {!editingResources && (
            <div className="mt-3">
              <ResourceBreakdown tenantId={deployment.tenantId} deploymentId={deployment.id} />
            </div>
          )}
        </div>

        {/* Components Section */}
        {components.length > 0 && (
          <div className="mb-6">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
              <Server size={16} className="text-blue-600 dark:text-blue-400" />
              Components
            </h3>
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Image</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {components.map((comp) => (
                    <tr key={comp.name ?? comp.image}>
                      <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">{comp.name ?? '-'}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${typeBadgeColors[comp.type ?? ''] ?? typeBadgeColors.job}`}>
                          {comp.type ?? 'unknown'}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{comp.image ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Volumes Section — tenant-visible local paths, not K8s ones */}
        {volumes.length > 0 && (
          <div className="mb-6" data-testid="volumes-section">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
              <HardDrive size={16} className="text-blue-600 dark:text-blue-400" />
              Volumes
            </h3>
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-2">Local Path</th>
                    <th className="px-3 py-2">Container Path</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {(() => {
                    // Backend-computed paths are authoritative — they resolve the
                    // manifest's local_path against the deployment's storage root.
                    const deploymentVolumePaths = deployment.volumePaths;
                    if (deploymentVolumePaths && deploymentVolumePaths.length > 0) {
                      return deploymentVolumePaths.map((vp) => (
                        <tr key={vp.containerPath ?? vp.k8sPath}>
                          <td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{absPath(vp.k8sPath)}</td>
                          <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{vp.containerPath ?? '-'}</td>
                        </tr>
                      ));
                    }
                    // Fallback for responses without volumePaths. The catalog's
                    // `local_path` is relative to the deployment's storage root and
                    // is literally "." for most entries — rendering it raw is what
                    // put a bare "." in this column.
                    return volumes.map((vol) => (
                      <tr key={vol.container_path ?? vol.local_path}>
                        <td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">
                          {joinTenantPath(deployment.storagePath, vol.local_path)}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{vol.container_path ?? '-'}</td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Configuration Section */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <Shield size={16} className="text-blue-600 dark:text-blue-400" />
              Configuration
            </h3>
            {!editingConfig && configurableKeys.size > 0 && (
              <button
                type="button"
                onClick={enterConfigEdit}
                className="inline-flex items-center gap-1 rounded-md border border-blue-300 dark:border-blue-600 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                data-testid="edit-config-button"
              >
                <Pencil size={12} />
                Edit
              </button>
            )}
          </div>
          {displayKeys.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-2">Key</th>
                    <th className="px-3 py-2">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {displayKeys.map((key) => {
                    const isSecret = secretKeys.has(key);
                    const isRevealed = revealedSecrets.has(key);
                    const isConfigurable = configurableKeys.has(key);
                    const value = String(configuration[key] ?? '');
                    return (
                      <tr key={key}>
                        <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">{key}</td>
                        <td className="px-3 py-2 text-gray-600 dark:text-gray-400">
                          {editingConfig && isConfigurable && !isSecret ? (
                            <input
                              type="text"
                              value={editValues[key] ?? ''}
                              onChange={(e) => setEditValues({ ...editValues, [key]: e.target.value })}
                              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 font-mono text-xs text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              data-testid={`edit-config-${key}`}
                            />
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className={`font-mono text-xs ${value === '' ? 'italic text-gray-400 dark:text-gray-500' : ''}`}>
                                {isSecret && !isRevealed
                                  ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'
                                  : (value === '' ? 'not set' : value)}
                              </span>
                              {isSecret && (
                                <button
                                  type="button"
                                  onClick={() => toggleSecret(key)}
                                  className="rounded p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                                  data-testid={`toggle-secret-${key}`}
                                >
                                  {isRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">No custom configuration</p>
          )}
          {editingConfig && (
            <div className="mt-3 space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>Saving will restart the deployment to apply changes. The application will be briefly unavailable.</span>
              </div>
              <div className="flex gap-2">
              <button
                type="button"
                onClick={saveConfigEdit}
                disabled={updateDeployment.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="save-config-button"
              >
                {updateDeployment.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                Apply Changes
              </button>
              <button
                type="button"
                onClick={() => { setEditingConfig(false); updateDeployment.reset(); }}
                className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                data-testid="cancel-config-button"
              >
                Cancel
              </button>
              </div>
            </div>
          )}
          {updateDeployment.isError && editingConfig && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              {updateDeployment.error instanceof Error ? updateDeployment.error.message : 'Failed to update configuration'}
            </p>
          )}
          {secretKeys.size > 0 && (
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400" data-testid="credentials-readonly-note">
              Set at deployment time. Change passwords inside the application if needed.
            </p>
          )}
        </div>

        {/* Multi-host serving — only for catalog entries that declare it. */}
        {multihostCapable && (
          <section className="mb-5" data-testid="multihost-section">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Multi-host serving
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {multihostOn
                ? 'On — each hostname routed here can serve its own folder. Assign folders under Domains → Routing.'
                : 'Off — every hostname routed here serves this deployment\u2019s document root.'}
            </p>
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                {multihostOn
                  ? 'Turning this off restarts the application once. Clear every hostname\u2019s folder first, or the request is refused.'
                  : 'Turning this on restarts the application once, and gives it access to your whole storage so any folder can be served. Adding or changing sites afterwards does not restart anything.'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setMultihost.mutate({ deploymentId: deployment.id, enabled: !multihostOn })}
              disabled={setMultihost.isPending}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
              data-testid="multihost-toggle"
            >
              {setMultihost.isPending && <Loader2 size={12} className="animate-spin" />}
              {multihostOn ? 'Turn off multi-host serving' : 'Turn on multi-host serving'}
            </button>
            {setMultihost.isError && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400" data-testid="multihost-error">
                {setMultihost.error instanceof Error ? setMultihost.error.message : 'Failed to change multi-host serving'}
              </p>
            )}
          </section>
        )}

        {/* Extra Mounts Section */}
        <section className="mb-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Extra Mounts
          </h3>
          {!editingMounts ? (
            <>
              {(deployment.extraMounts ?? []).length > 0 ? (
                <ul className="space-y-1" data-testid="extra-mounts-list">
                  {(deployment.extraMounts ?? []).map((m, i) => (
                    <li key={i} className="text-sm text-gray-700 dark:text-gray-300 font-mono">
                      {m.folder} → {m.mount_path}
                      {m.read_only && (
                        <span className="ml-2 font-sans text-xs text-gray-500 dark:text-gray-400">(read-only)</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">No extra mounts</p>
              )}
              <button
                type="button"
                onClick={() => { setMountRows([...(deployment.extraMounts ?? [])]); setEditingMounts(true); }}
                className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                data-testid="edit-mounts-button"
              >
                Edit mounts
              </button>
            </>
          ) : (
            <div className="space-y-3">
              <ExtraMountsEditor rows={mountRows} onChange={setMountRows} disabled={updateDeployment.isPending} />
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>Saving will restart the deployment to apply changes. The application will be briefly unavailable.</span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveMounts}
                  disabled={updateDeployment.isPending || mountsInvalid}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="save-mounts-button"
                >
                  {updateDeployment.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  Apply Changes
                </button>
                <button
                  type="button"
                  onClick={() => { setEditingMounts(false); updateDeployment.reset(); }}
                  className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  data-testid="cancel-mounts-button"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Resources Section (Issue 7: editable) */}

        {/* Network Access (deployment-level: public/tunneler/zrok) */}
        {tenantId && (
          <div className="mb-6">
            <NetworkAccessSection
              tenantId={tenantId}
              deploymentId={deployment.id}
              deploymentName={deployment.name}
            />
          </div>
        )}

        {/* Unified Logs (static snapshot default, with Stream Live toggle) */}
        {showLogs && deployment && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                <Terminal size={16} className="text-gray-600 dark:text-gray-400" />
                Logs
              </h3>
              <button
                type="button"
                onClick={() => setShowLogs(false)}
                className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Hide
              </button>
            </div>
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden h-80">
              <LogViewer deploymentId={deployment.id} />
            </div>
          </div>
        )}

        {/* Web Terminal */}
        {showTerminal && deployment && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                <Terminal size={16} className="text-gray-600 dark:text-gray-400" />
                Terminal
              </h3>
              <button
                type="button"
                onClick={() => setShowTerminal(false)}
                className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Hide
              </button>
            </div>
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden h-80">
              <WebTerminal deploymentId={deployment.id} />
            </div>
          </div>
        )}

        {/* Version switch confirmation */}
        {versionTarget && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center" data-testid="version-switch-modal">
            <div className="fixed inset-0 bg-black/50" onClick={() => { setVersionTarget(null); switchVersion.reset(); }} />
            <div className="relative w-full max-w-md rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Switch to version {versionTarget}?
              </h3>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                <span className="font-medium">{deployment.name}</span> will redeploy from{' '}
                <span className="font-mono">{deployment.installedVersion ?? 'unversioned'}</span> to{' '}
                <span className="font-mono">{versionTarget}</span>.
              </p>
              {deployment.installedVersion
                && compareSemver(versionTarget, deployment.installedVersion) < 0 && (
                <div className="mt-3 flex gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs text-amber-800 dark:text-amber-300">
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  <span>
                    This is a downgrade. Database schema changes made by the newer version are
                    <span className="font-semibold"> not reversed</span> — take a backup first if the app stores data.
                  </span>
                </div>
              )}
              {switchVersion.isError && (
                <div className="mt-3 rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-xs text-red-700 dark:text-red-300" data-testid="version-switch-error">
                  {switchVersion.error instanceof Error ? switchVersion.error.message : 'Version switch failed'}
                </div>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setVersionTarget(null); switchVersion.reset(); }}
                  className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={switchVersion.isPending}
                  onClick={() => switchVersion.mutate(versionTarget, {
                    onSuccess: () => { setVersionTarget(null); queryClient.invalidateQueries({ queryKey: ['deployments'] }); },
                  })}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  data-testid="version-switch-confirm"
                >
                  {switchVersion.isPending && <Loader2 size={14} className="animate-spin" />}
                  Switch version
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
          <button
            type="button"
            onClick={() => setShowLogs(!showLogs)}
            className={clsx(
              'inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
              showLogs
                ? 'border-brand-500 text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/20'
                : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
            )}
            data-testid="logs-button"
          >
            <Terminal size={16} />
            Logs
          </button>
          <button
            type="button"
            onClick={() => setShowTerminal(!showTerminal)}
            className={clsx(
              'inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
              showTerminal
                ? 'border-brand-500 text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/20'
                : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
            )}
            data-testid="terminal-button"
          >
            <Terminal size={16} />
            Terminal
          </button>
          {isDatabase && (
            <button
              type="button"
              onClick={() => setDbModalOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 transition-colors"
              data-testid="manage-database-button"
            >
              <Database size={16} />
              Manage Database
            </button>
          )}
          {isActionable && (
            <button
              type="button"
              onClick={() => {
                const newStatus = deployment.status === 'running' ? 'stopped' : 'running';
                onToggleStatus(deployment.id, newStatus);
              }}
              disabled={isToggling}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                deployment.status === 'running'
                  ? 'bg-orange-50 text-orange-700 hover:bg-orange-100 dark:bg-orange-900/20 dark:text-orange-400 dark:hover:bg-orange-900/40'
                  : 'bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/40'
              }`}
              data-testid="modal-toggle-status"
            >
              {isToggling ? (
                <Loader2 size={16} className="animate-spin" />
              ) : deployment.status === 'running' ? (
                <Square size={16} />
              ) : (
                <Play size={16} />
              )}
              {deployment.status === 'running' ? 'Stop' : 'Start'}
            </button>
          )}
          {isTransitioning && (
            <span className="inline-flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 size={16} className="animate-spin" />
              {deployment.status}...
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            data-testid="modal-close-footer"
          >
            Close
          </button>
        </div>
      </div>

      {/* Database Management Modal */}
      {isDatabase && (
        <DatabaseManagementModal
          open={dbModalOpen}
          deployment={deployment}
          catalogEntry={catalogEntry}
          tenantId={tenantId}
          onClose={() => setDbModalOpen(false)}
        />
      )}

      {changingStoragePath && deployment.storagePath && (
        <ChangeStoragePathModal
          tenantId={tenantId}
          deploymentId={deployment.id}
          deploymentName={deployment.name}
          currentPath={deployment.storagePath}
          isRunning={deployment.status === 'running'}
          onClose={() => setChangingStoragePath(false)}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: ['deployments', tenantId] });
          }}
        />
      )}
    </div>
  );
}

function DetailMetricCard({
  icon,
  label,
  request,
  used,
  type,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly request: string;
  readonly used: number | undefined;
  readonly type: 'cpu' | 'memory';
}) {
  let requestNum = 0;
  const usedNum = used ?? 0;
  let usedLabel = '';

  if (type === 'cpu') {
    requestNum = request.endsWith('m') ? parseFloat(request) / 1000 : parseFloat(request) || 0;
    usedLabel = used != null ? `${(usedNum * 1000).toFixed(0)}m used` : '';
  } else {
    if (request.endsWith('Gi')) requestNum = parseFloat(request) * 1024;
    else if (request.endsWith('Mi')) requestNum = parseFloat(request);
    else requestNum = parseFloat(request) || 0;
    usedLabel = used != null ? `${Math.round(usedNum)}Mi used` : '';
  }

  const ratio = requestNum > 0 ? (type === 'cpu' ? usedNum / requestNum : usedNum / requestNum) : 0;
  const pct = Math.min(ratio * 100, 100);
  const barColor = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-500' : 'bg-green-500';

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/50 p-3 text-center">
      {icon}
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{request}</p>
      {used != null && (
        <>
          <div className="mt-1.5 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
            <div className={clsx('h-full rounded-full transition-all', barColor)} style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{usedLabel}</p>
        </>
      )}
    </div>
  );
}
