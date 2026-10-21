import { Fragment, useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, Pause, Play, Trash2, Loader2, UserCheck, Rocket, ServerCrash, RefreshCw, Copy, Check, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import ActionsMenu, { ActionsMenuItem, ActionsMenuSeparator } from '@/components/ui/ActionsMenu';
import StatusBadge from '@/components/ui/StatusBadge';
import EditTenantModal from '@/components/EditTenantModal';
import DeleteConfirmDialog from '@/components/DeleteConfirmDialog';
import type { TenantDeletedState } from '@/components/tenants/TenantDeletedBanner';
import OperationProgressModal from '@/components/OperationProgressModal';
import TransitionProgressModal from '@/components/TransitionProgressModal';
import ProvisioningProgressModal from '@/components/ProvisioningProgressModal';
import ErrorPanel from '@/components/ErrorPanel';
import ArchiveTenantDialog, { type ArchiveRetention } from '@/components/tenant-detail/ArchiveTenantDialog';
import ArchivedTenantView from '@/components/tenant-detail/ArchivedTenantView';
import { useTenantArchive } from '@/hooks/use-tenant-archive';
import { useStorageLifecycleSettings } from '@/hooks/use-storage-settings';
import OverviewTab from '@/components/tenant-detail/OverviewTab';
import TenantEmailTab from '@/components/tenant-detail/EmailTab';
import TenantTrafficTab from '@/components/tenant-detail/TrafficTab';
import StorageTab from '@/components/tenant-detail/StorageTab';
import LimitsTab from '@/components/tenant-detail/LimitsTab';
import ActivityTab from '@/components/tenant-detail/ActivityTab';
import { Chip } from '@/components/tenant-detail/ui';
import { useTenantIssues } from '@/hooks/use-tenant-issues';
import { useTenant, useDeleteTenant, useUpdateTenant } from '@/hooks/use-tenants';
import { useSetTenantAutomationExempt } from '@/hooks/use-tenant-automation';
import { useBulkRestartDeployments } from '@/hooks/use-deployments';
import { useLoginAsTenant } from '@/hooks/use-impersonate';
import { useTriggerProvisioning } from '@/hooks/use-provisioning';
import { usePlans } from '@/hooks/use-plans';
import { useTenantPlacement } from '@/hooks/use-tenant-placement';
import { useNodeLabel } from '@/hooks/use-node-labels';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { useTabParam } from '@/hooks/use-tab-param';
import type { TabOf } from '@/routes/tabbed-pages';
import type { UpdateTenantInput } from '@insula/api-contracts';

type TabKey = TabOf<'/tenants/:id'>;

const TAB_LABELS: Record<TabKey, string> = {
  overview: 'Overview',
  email: 'Email',
  traffic: 'Traffic',
  storage: 'Storage & backups',
  limits: 'Plan & limits',
  activity: 'Activity',
};

export default function TenantDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: issuesData } = useTenantIssues();
  const tenantIssues = id ? issuesData?.data?.[id] : undefined;
  const navigate = useNavigate();
  const { data, isLoading, error } = useTenant(id);
  const tenant = data?.data;
  const { data: placementData } = useTenantPlacement(id ?? '');
  const placement = placementData?.data.placement ?? null;
  const nodeLabel = useNodeLabel();
  // The detail read leaves `planName` empty (only list rows carry it), so the
  // name comes from the plan list when the tenant does not say.
  const { data: plansRes } = usePlans();

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [activeTab, setActiveTab] = useTabParam('/tenants/:id');
  // Per-action switch for the tenant-facing notification the lifecycle hooks
  // send. Default ON — the operator opts out explicitly; it rides along on
  // every lifecycle action as `suppressTenantNotification`.
  const [notifyTenant, setNotifyTenant] = useState(true);
  const [provisioningOpen, setProvisioningOpen] = useState(false);
  // Op id surfaced when a status PATCH started a storage-lifecycle
  // orchestrator (archive, restore-from-archive).
  const [statusOpId, setStatusOpId] = useState<string | null>(null);
  // The transition progress modal latches onto the most recent transition row
  // matching `kind` started after `since`, so concurrent transitions don't
  // bleed across.
  const [txModal, setTxModal] = useState<{
    kind: 'active' | 'suspended' | 'archived' | 'restored' | 'deleted';
    since: number;
    transitionId?: string | null;
  } | null>(null);
  // A suspend, reactivate, archive or restore the API refused — shown under the
  // header until the next action, instead of a "Dispatching…" dialog left open
  // with nothing to say why.
  const [lifecycleActionError, setLifecycleActionError] = useState<unknown>(null);
  const lifecycleActionFailed = (err: unknown): void => {
    setTxModal(null);
    setLifecycleActionError(err);
  };
  const setAutomationExempt = useSetTenantAutomationExempt();
  const deleteTenant = useDeleteTenant();
  // Which tenant this page shows NOW. The same page instance is reused when the
  // route's :id changes, so "still mounted" alone does not mean "still on the
  // tenant that was deleted".
  const shownIdRef = useRef<string | undefined>(id);
  useEffect(() => {
    shownIdRef.current = id;
    return () => { shownIdRef.current = undefined; };
  }, [id]);
  const updateTenant = useUpdateTenant(id ?? '');
  const impersonate = useLoginAsTenant();
  // The archive's bundle: what restore brings back (a whole archive, or files only).
  const archiveInfo = useTenantArchive(id, tenant?.status === 'archived');
  // The platform's archive retention: the dialog's starting value.
  const storageSettings = useStorageLifecycleSettings();
  const provisioningStatus = tenant?.provisioningStatus as string | undefined;
  const triggerProvision = useTriggerProvisioning();
  const bulkRestart = useBulkRestartDeployments();
  const [copied, setCopied] = useState(false);

  const handleDelete = async () => {
    if (!id) return;
    const deletingId = id;
    try {
      setTxModal({ kind: 'deleted', since: Date.now() });
      // `?suppressTenantNotification=true` tells the lifecycle hooks to skip the
      // tenant-facing notification; the shared delete hook takes only an id.
      const idWithQuery = notifyTenant ? id : `${id}?suppressTenantNotification=true`;
      await deleteTenant.mutateAsync(idWithQuery);
      // The DELETE answers once the tenant is gone; staying would refetch a
      // tenant that no longer exists. Go back to the list, which says what
      // happened — unless the operator already left this tenant.
      if (shownIdRef.current !== deletingId) return;
      setTxModal(null);
      setDeleteOpen(false);
      const state: TenantDeletedState = { deletedTenant: { name: tenant?.name ?? 'Unknown', id: deletingId } };
      navigate('/tenants/list', { replace: true, state });
    } catch (err) {
      // Nothing was deleted: drop the "Dispatching…" modal and let the confirm
      // dialog (which awaits this) show why.
      setTxModal(null);
      throw err;
    }
  };

  const runTransition = async (
    kind: 'active' | 'suspended' | 'archived' | 'restored',
    input: Record<string, unknown>,
  ): Promise<void> => {
    setLifecycleActionError(null);
    try {
      setTxModal({ kind, since: Date.now() });
      const res = await updateTenant.mutateAsync(
        { ...input, suppressTenantNotification: !notifyTenant } as unknown as UpdateTenantInput,
      );
      const opId = res?.data?.storageArchiveOperationId ?? res?.data?.storageRestoreOperationId ?? null;
      if (opId) setStatusOpId(opId);
    } catch (err) {
      lifecycleActionFailed(err);
    }
  };

  const handleSuspend = () => runTransition('suspended', { status: 'suspended' });
  const handleArchive = async (retention: ArchiveRetention) => {
    setArchiveOpen(false);
    await runTransition('archived', retention === null
      ? { status: 'archived', archive_never_expires: true }
      : { status: 'archived', archive_retention_days: retention });
  };
  const handleRestoreArchived = async (whole: boolean) => {
    const ok = confirm(whole
      ? 'Restore this tenant from its archive?\n\n'
        + 'Its files and databases, applications, DNS zones, mail domains and mailboxes with their mail come back, '
        + 'and its users can sign in again. Mailboxes need new passwords: the mail server never kept a copy the '
        + 'archive could hold. Estimated time: a few minutes per GiB of stored data.\n\nContinue?'
      : 'Restore this tenant from its archive?\n\n'
        + 'This archive is from before archives held everything: only the files come back. Applications have to be '
        + 'redeployed and mailboxes set up again.\n\nContinue?');
    if (!ok) return;
    await runTransition('restored', { status: 'active' });
  };
  const handleReactivate = async () => {
    if (tenant?.status === 'archived') {
      await handleRestoreArchived(archiveInfo.data?.data?.bundle?.whole ?? false);
      return;
    }
    await runTransition('active', { status: 'active' });
  };

  const provision = async () => {
    if (!id) return;
    try {
      await triggerProvision.mutateAsync({ tenantId: id });
      setProvisioningOpen(true);
    } catch { /* error shown via mutation state */ }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={32} className="animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !tenant || !id) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-lg text-gray-500 dark:text-gray-400">
          {error instanceof Error ? error.message : 'Tenant not found'}
        </p>
        <Link to="/tenants" className="mt-4 text-sm text-brand-500 hover:text-brand-600">
          Back to tenants
        </Link>
      </div>
    );
  }

  const name = tenant.name ?? 'Unknown';
  const planName = tenant.planName ?? plansRes?.data.find((p) => p.id === tenant.planId)?.name ?? null;
  const issueCount = tenantIssues?.length ?? 0;
  const misplaced = placement?.status === 'misplaced';
  const runningOn = placement ? (placement.workloadNodes.length > 0 ? placement.workloadNodes : placement.attachedNodes) : [];
  const tabs = Object.keys(TAB_LABELS) as TabKey[];

  const copyNamespace = async () => {
    if (!tenant.kubernetesNamespace) return;
    try {
      await navigator.clipboard.writeText(tenant.kubernetesNamespace);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard refused: nothing to undo */ }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-gray-200 bg-white px-5 pt-4 shadow-sm dark:border-gray-700 dark:bg-gray-800" data-testid="tenant-header">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <Link
              to="/tenants"
              className="mt-0.5 rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
              aria-label="Back to tenants"
            >
              <ArrowLeft size={20} />
            </Link>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">{name}</h1>
                <StatusBadge status={tenant.status} />
                {provisioningStatus && provisioningStatus !== 'provisioned' && (
                  <Chip tone={provisioningStatus === 'failed' ? 'bad' : 'warn'} testId="tenant-provisioning-chip">
                    {provisioningStatus === 'provisioning' ? 'Provisioning…' : provisioningStatus === 'failed' ? 'Provisioning failed' : 'Not provisioned'}
                  </Chip>
                )}
                {issueCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('overview')}
                    className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    data-testid="tenant-issue-count"
                  >
                    <Chip tone={tenantIssues?.some((i) => i.severity === 'critical') ? 'bad' : 'warn'}>
                      {issueCount} {issueCount === 1 ? 'issue' : 'issues'}
                    </Chip>
                  </button>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-gray-600 dark:text-gray-400">
                <Link to={`/tenants/${id}/limits`} className="hover:text-brand-600 hover:underline dark:hover:text-brand-400" data-testid="tenant-plan-link">
                  {planName ? `${planName} plan` : tenant.planId ? 'Plan' : 'No plan'}
                </Link>
                {misplaced ? (
                  <Link to={`/tenants/${id}/storage`} data-testid="tenant-placement-chip">
                    <Chip tone="warn">
                      Running on {runningOn.map(nodeLabel).join(', ') || 'another node'} · pinned to {placement?.primaryNode ? nodeLabel(placement.primaryNode) : 'none'}
                    </Chip>
                  </Link>
                ) : (runningOn.length > 0 || tenant.nodeName) && (
                  <Link to={`/tenants/${id}/storage`} className="hover:text-brand-600 hover:underline dark:hover:text-brand-400" data-testid="tenant-placement-chip">
                    {runningOn.length > 0 ? `On ${runningOn.map(nodeLabel).join(', ')}` : `Pinned to ${nodeLabel(tenant.nodeName!)}`}
                  </Link>
                )}
                {tenant.kubernetesNamespace && (
                  <span className="inline-flex items-center gap-1 font-mono text-xs">
                    {tenant.kubernetesNamespace}
                    <button type="button" onClick={copyNamespace} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200" aria-label="Copy namespace">
                      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                    </button>
                  </span>
                )}
                {tenant.createdAt && <span>Customer since {new Date(tenant.createdAt).toLocaleDateString()}</span>}
              </div>
              {tenant.lifecycleAutomationExempt === true && (
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-400" data-testid="automation-exempt-note">
                  Kept out of{' '}
                  <Link to="/platform/lifecycle-hooks" className="underline hover:no-underline">automatic archive and delete</Link>.
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col items-end gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                data-testid="edit-button"
              >
                <Edit size={14} aria-hidden="true" /> Edit
              </button>
              <ActionsMenu testId="tenant-actions">
                {provisioningStatus === 'unprovisioned' || provisioningStatus === 'failed' ? (
                  <ActionsMenuItem onClick={provision} disabled={triggerProvision.isPending} icon={<Rocket size={14} />} testId="provision-button">
                    Provision
                  </ActionsMenuItem>
                ) : provisioningStatus === 'provisioning' ? (
                  <ActionsMenuItem onClick={() => setProvisioningOpen(true)} icon={<Loader2 size={14} className="animate-spin" />} testId="provision-status-button">
                    Provisioning…
                  </ActionsMenuItem>
                ) : provisioningStatus === 'provisioned' ? (
                  <ActionsMenuItem onClick={provision} disabled={triggerProvision.isPending} icon={<RefreshCw size={14} />} title="Re-run provisioning to fix inconsistent K8s state" testId="reprovision-button">
                    Re-provision
                  </ActionsMenuItem>
                ) : null}

                <ActionsMenuItem
                  onClick={() => bulkRestart.mutate(undefined)}
                  disabled={bulkRestart.isPending}
                  icon={<RefreshCw size={14} />}
                  title="Pull latest images and restart all running deployments"
                  testId="refresh-all-apps-button"
                >
                  Refresh all apps
                </ActionsMenuItem>

                {/* ADR-040: the SYSTEM tenant cannot be suspended, archived or deleted. */}
                {!tenant.isSystem && <ActionsMenuSeparator />}

                {/* Configures the lifecycle actions below it, so it sits with
                    them — and must NOT close the menu. */}
                {!tenant.isSystem && (
                  <label
                    onClick={(e) => e.stopPropagation()}
                    className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-gray-600 dark:text-gray-400"
                    title="Send the tenant an in-app + email notification about this lifecycle action"
                    data-testid="notify-tenant-toggle"
                  >
                    <input type="checkbox" checked={notifyTenant} onChange={(e) => setNotifyTenant(e.target.checked)} className="rounded" data-testid="notify-tenant-checkbox" />
                    Notify tenant
                  </label>
                )}

                {/* Saved at once, like a switch: a standing property of the tenant. */}
                {!tenant.isSystem && (
                  <label
                    onClick={(e) => e.stopPropagation()}
                    className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-gray-600 dark:text-gray-400"
                    title="Never archive or delete this tenant automatically, however long it stays suspended or archived (Platform → Tenant Lifecycle Hooks)"
                    data-testid="automation-exempt-toggle"
                  >
                    <input
                      type="checkbox"
                      checked={tenant.lifecycleAutomationExempt === true}
                      disabled={setAutomationExempt.isPending}
                      onChange={(e) => {
                        setLifecycleActionError(null);
                        setAutomationExempt.mutate(
                          { tenantId: tenant.id, exempt: e.target.checked },
                          { onError: (err) => setLifecycleActionError(err) },
                        );
                      }}
                      className="rounded"
                      data-testid="automation-exempt-checkbox"
                    />
                    Keep out of automatic archive and delete
                  </label>
                )}

                {tenant.status === 'active' && !tenant.isSystem && (
                  <ActionsMenuItem onClick={handleSuspend} disabled={updateTenant.isPending} icon={<Pause size={14} />} title="Scale workloads to 0, swap ingress to suspended page, disable mail/cron — fully reversible via Reactivate." testId="suspend-button">
                    Suspend
                  </ActionsMenuItem>
                )}
                {tenant.status === 'suspended' && !tenant.isSystem && (
                  <ActionsMenuItem onClick={handleReactivate} disabled={updateTenant.isPending} icon={<Play size={14} />} title="Restore workloads to pre-suspend replica counts, unpatch ingress, re-enable mail/cron." testId="reactivate-button">
                    Reactivate
                  </ActionsMenuItem>
                )}
                {(tenant.status === 'active' || tenant.status === 'suspended') && !tenant.isSystem && provisioningStatus === 'provisioned' && (
                  <ActionsMenuItem
                    onClick={() => setArchiveOpen(true)}
                    // Archive takes a suspended tenant only: suspend first.
                    disabled={updateTenant.isPending || tenant.status !== 'suspended'}
                    icon={<ServerCrash size={14} />}
                    title={tenant.status === 'suspended'
                      ? 'Take a final full backup off-site, then remove the tenant almost as if deleted. Restorable until the archive expires.'
                      : 'Only a suspended tenant can be archived — suspend it first.'}
                    testId="archive-button"
                  >
                    Archive…
                  </ActionsMenuItem>
                )}
                {tenant.status === 'archived' && !tenant.isSystem && (
                  <ActionsMenuItem onClick={handleReactivate} disabled={updateTenant.isPending} icon={<Play size={14} />} title="Bring the tenant back from its archive bundle." testId="restore-button">
                    Restore
                  </ActionsMenuItem>
                )}
                {!tenant.isSystem && (
                  <ActionsMenuItem onClick={() => setDeleteOpen(true)} icon={<Trash2 size={14} />} tone="danger" title="Hard delete — removes the tenant, its namespace, DNS zones, backup bundles and volumes. Irreversible." testId="delete-button">
                    Delete
                  </ActionsMenuItem>
                )}
              </ActionsMenu>
              {tenant.status !== 'archived' && <button
                type="button"
                onClick={async () => {
                  try {
                    const opened = await impersonate.open(id);
                    if (!opened) alert('Tenant Panel URL is not configured. Set it in System Settings before using "Login as Tenant".');
                  } catch { /* error shown via impersonate.error */ }
                }}
                disabled={impersonate.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:opacity-50"
                data-testid="impersonate-button"
              >
                {impersonate.isPending ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />}
                <span>Login as tenant</span>
              </button>}
            </div>
            {tenant.status !== 'archived' && (
              <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400" data-testid="impersonate-caption">
                <ExternalLink size={12} aria-hidden="true" />
                opens that page of the tenant panel, signed in as this tenant
              </span>
            )}
          </div>
        </div>

        {tenant.status !== 'archived' && <nav className="-mx-2 mt-4 flex gap-1 overflow-x-auto" aria-label="Tenant sections" data-testid="tenant-tabs">
          {tabs.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveTab(key)}
              aria-current={activeTab === key ? 'page' : undefined}
              data-testid={`tab-${key}`}
              className={clsx(
                'whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition-colors',
                activeTab === key
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200',
              )}
            >
              {TAB_LABELS[key]}
            </button>
          ))}
        </nav>}
      </div>

      {lifecycleActionError !== null && (
        <ErrorPanel error={extractOperatorError(lifecycleActionError)} severity="error" testId="tenant-lifecycle-action-error" />
      )}

      {/* A `pending` tenant is created but not yet provisioned: it cannot deploy
          workloads, configure domains/ingress, or set up email until it is. */}
      {!tenant.isSystem && tenant.status === 'pending' && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200" data-testid="not-provisioned-banner">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium">Tenant not provisioned yet</p>
              <p className="mt-1 text-amber-800 dark:text-amber-300">
                This tenant is <code>pending</code>. Until it is provisioned it cannot deploy
                workloads, configure domains/ingress, or set up email domains and mailboxes.
                Provisioning activates the tenant automatically.
              </p>
            </div>
            {(provisioningStatus === 'unprovisioned' || provisioningStatus === 'failed') && (
              <button
                onClick={provision}
                disabled={triggerProvision.isPending}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                data-testid="banner-provision-now"
              >
                {triggerProvision.isPending ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
                Provision Now
              </button>
            )}
          </div>
        </div>
      )}

      {/* ADR-040: why the destructive actions are missing and what this tenant is for. */}
      {tenant.isSystem && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200" data-testid="system-tenant-banner">
          <p className="font-medium">SYSTEM tenant — platform-managed</p>
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            This tenant owns the platform apex domain and the platform&rsquo;s reserved mailbox space
            (e.g. <code>noreply@</code>, <code>postmaster@</code>). It cannot be suspended, archived,
            or deleted. You can still provision websites and mailboxes under the apex through the
            normal flows.
          </p>
        </div>
      )}

      {/* Keyed by tenant: this page instance is reused when the route's :id
          changes, and a tab's own state — limit drafts, a pending shrink, a
          chosen pin, a traffic subject — belongs to the tenant it was made on.
          Limits also remount on a plan change, to re-read the plan's values. */}
      {tenant.status === 'archived' && (
        <ArchivedTenantView
          tenantId={id}
          restoring={updateTenant.isPending}
          keptOutOfAutomation={tenant.lifecycleAutomationExempt === true}
          onRestore={handleRestoreArchived}
        />
      )}
      {tenant.status !== 'archived' && <Fragment key={id}>
        {activeTab === 'overview' && <OverviewTab tenant={tenant} tenantId={id} planName={planName} issues={tenantIssues} placement={placement} onTab={setActiveTab} />}
        {activeTab === 'email' && <TenantEmailTab tenant={tenant} tenantId={id} />}
        {activeTab === 'traffic' && <TenantTrafficTab tenant={tenant} tenantId={id} />}
        {activeTab === 'storage' && <StorageTab tenant={tenant} tenantId={id} />}
        {activeTab === 'limits' && <LimitsTab key={tenant.planId ?? 'no-plan'} tenant={tenant} tenantId={id} />}
        {activeTab === 'activity' && <ActivityTab tenantId={id} />}
      </Fragment>}

      <EditTenantModal open={editOpen} onClose={() => setEditOpen(false)} tenant={tenant} />

      <DeleteConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        tenantName={name}
        isPending={deleteTenant.isPending}
      />

      {archiveOpen && (
        <ArchiveTenantDialog
          tenantName={name}
          busy={updateTenant.isPending}
          defaultDays={storageSettings.data?.data?.retentionPreArchiveDays ?? 90}
          onConfirm={handleArchive}
          onClose={() => setArchiveOpen(false)}
        />
      )}

      {txModal && (
        <TransitionProgressModal
          tenantId={id}
          transition={txModal.kind}
          since={txModal.since}
          transitionId={txModal.transitionId}
          onClose={() => {
            setTxModal(null);
            if (txModal.kind === 'deleted') navigate('/tenants');
          }}
        />
      )}

      {provisioningOpen && (
        <ProvisioningProgressModal tenantId={id} tenantName={name} onClose={() => setProvisioningOpen(false)} />
      )}

      {/* Progress of a status-driven storage op (archive, restore-from-archive). */}
      <OperationProgressModal operationId={statusOpId} onClose={() => setStatusOpId(null)} />
    </div>
  );
}
