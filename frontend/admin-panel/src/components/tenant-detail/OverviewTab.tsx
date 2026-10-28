/**
 * Tenant → Overview: is this tenant all right, and where do I go if not.
 *
 * Usage at a glance, every open condition with the place it is fixed, and a
 * short summary of each area with a link to it — an admin tab for what only
 * an admin can change, the tenant panel for what the tenant panel manages.
 */
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2, Pin } from 'lucide-react';
import type { TenantPlacement } from '@insula/api-contracts';
import type { Tenant } from '@/types/api';
import type { TabOf } from '@/routes/tabbed-pages';
import type { TenantIssue } from '@/hooks/use-tenant-issues';
import NamespaceIntegrityBanner from '@/components/NamespaceIntegrityBanner';
import StatusBadge from '@/components/ui/StatusBadge';
import { useTenantMetrics } from '@/hooks/use-resource-metrics';
import { useTenantBandwidth, useTenantMailUsage, useTenantSendLimitsLive } from '@/hooks/use-tenant-insights';
import { useDomains } from '@/hooks/use-domains';
import { useDeployments } from '@/hooks/use-deployments';
import { useTenantBundles } from '@/hooks/use-tenant-bundles';
import { useTenantSnapshots } from '@/hooks/use-tenant-snapshots';
import { useEmailDomains, useMailboxes, useEmailAliases, useImapSyncJobs } from '@/hooks/use-email';
import { useAdminSubUsers } from '@/hooks/use-sub-users';
import { useSftpUsers } from '@/hooks/use-sftp-users';
import { useAuditLogs } from '@/hooks/use-audit-logs';
import { useCpuMigrationPreview } from '@/hooks/use-cpu-migration';
import { useNodeLabel } from '@/hooks/use-node-labels';
import { formatMetricsCpu, formatMetricsGi } from '@/lib/format-metrics';
import { createdByLabel } from '@/lib/created-by-label';
import { Card, Chip, GoLink, KV, UsageTile, formatGb, type Tone } from './ui';
import TenantPanelLink from './TenantPanelLink';
import { tenantPanel } from './tenant-panel-paths';
import { describeAuditEntry } from './audit-describe';
import ApplicationsList from './ApplicationsList';
import { bandwidthForecast } from './bandwidth-forecast';

type TabKey = TabOf<'/tenants/:id'>;

export interface AttentionItem {
  readonly key: string;
  readonly tone: Tone;
  readonly title: string;
  readonly detail: string;
  readonly since: string | null;
  /** An admin path, or a tab of this page. */
  readonly to: string;
  readonly action: string;
}

function age(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

function pctOf(used: number | null | undefined, of: number | null | undefined): number | null {
  if (used == null || of == null || !Number.isFinite(used) || !Number.isFinite(of) || of <= 0) return null;
  return (used / of) * 100;
}

export default function OverviewTab({ tenant, tenantId, planName, issues, placement, onTab }: {
  readonly tenant: Tenant;
  readonly tenantId: string;
  readonly planName: string | null;
  readonly issues: readonly TenantIssue[] | undefined;
  readonly placement: TenantPlacement | null;
  readonly onTab: (tab: TabKey) => void;
}) {
  const { data: metricsRes } = useTenantMetrics(tenantId);
  const metrics = metricsRes?.data;
  const { data: bwRes } = useTenantBandwidth(tenantId);
  const bw = bwRes?.data;
  const { data: mailRes } = useTenantMailUsage(tenantId);
  // Only a usage reading with both windows counts; anything else reads as none.
  const mail = mailRes?.data?.day && mailRes.data.hour ? mailRes.data : undefined;
  const { data: bundlesRes } = useTenantBundles(tenantId);
  const lastBundle = bundlesRes?.data?.[0];
  const lastComplete = bundlesRes?.data?.find((b) => b.status === 'completed');
  const { data: cpuPreview } = useCpuMigrationPreview();
  const cpuRow = cpuPreview?.data?.tenants?.find((t) => t.tenantId === tenantId);
  const { data: sendLive } = useTenantSendLimitsLive(tenantId);
  const nodeLabel = useNodeLabel();
  const base = `/tenants/${tenantId}`;
  const forecast = bw ? bandwidthForecast(bw, new Date()) : null;

  const attention: AttentionItem[] = [
    ...(issues ?? []).map((i): AttentionItem => ({
      key: `${i.kind}:${i.objectLabel}`,
      tone: i.severity === 'critical' ? 'bad' : 'warn',
      title: i.objectLabel,
      detail: i.detail,
      since: i.since,
      to: i.actionPath,
      action: 'Open',
    })),
  ];
  if (placement?.status === 'misplaced') {
    attention.push({
      key: 'placement',
      tone: 'warn',
      title: 'Running away from its pinned node',
      detail: `Pinned to ${placement.primaryNode ? nodeLabel(placement.primaryNode) : 'no node'}, running on ${(placement.workloadNodes.length ? placement.workloadNodes : placement.attachedNodes).map(nodeLabel).join(', ') || 'another node'}. ${placement.reasons.join(', ')}`,
      since: placement.misplacedSince,
      to: `${base}/storage`,
      action: 'Review placement',
    });
  }
  if (lastBundle && (lastBundle.status === 'partial' || lastBundle.status === 'failed')) {
    attention.push({
      key: 'backup',
      tone: lastBundle.status === 'failed' ? 'bad' : 'warn',
      title: `Last backup ${lastBundle.status}`,
      detail: lastBundle.lastError ?? 'Open the backup to see which part failed.',
      since: lastBundle.finishedAt ?? lastBundle.startedAt,
      to: `${base}/storage`,
      action: 'Open backups',
    });
  }
  if (cpuRow?.pendingCpuChange) {
    attention.push({
      key: 'cpu-pending',
      tone: 'warn',
      title: 'CPU settings saved but not applied',
      detail: 'The saved CPU tier or burst ceiling reaches the cluster with Re-apply under Cluster → CPU scheduling.',
      since: null,
      to: '/cluster/cpu-scheduling',
      action: 'Open CPU scheduling',
    });
  }
  const notOnServer = sendLive?.data.reachable ? sendLive.data.domains.filter((d) => !d.inEffect) : [];
  if (notOnServer.length > 0) {
    attention.push({
      key: 'send-limits',
      tone: 'warn',
      title: 'Send limits not on the mail server',
      detail: `${notOnServer.map((d) => d.domain).join(', ')}: the mail server holds different limits than the platform wants. The next mail reconcile corrects it.`,
      since: null,
      to: `${base}/email`,
      action: 'Open email',
    });
  }

  return (
    <div className="space-y-6" data-testid="tenant-overview">
      <section aria-label="Usage" className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-4">
        <UsageTile
          label="CPU"
          value={metrics?.cpu?.inUse != null ? formatMetricsCpu(metrics.cpu.inUse) : '—'}
          of={metrics?.cpu?.available != null ? `/ ${formatMetricsCpu(metrics.cpu.available)} cores` : undefined}
          pct={pctOf(metrics?.cpu?.inUse, metrics?.cpu?.available)}
          note="In use now, against the limit"
          to={`${base}/limits`}
          testId="usage-cpu"
        />
        <UsageTile
          label="Memory"
          value={metrics?.memory?.inUse != null ? formatMetricsGi(metrics.memory.inUse) : '—'}
          of={metrics?.memory?.available != null ? `/ ${formatMetricsGi(metrics.memory.available)}` : undefined}
          pct={pctOf(metrics?.memory?.inUse, metrics?.memory?.available)}
          note="In use now, against the limit"
          to={`${base}/limits`}
          testId="usage-memory"
        />
        <UsageTile
          label="Storage"
          value={metrics?.storage?.inUse != null ? formatMetricsGi(metrics.storage.inUse) : '—'}
          of={metrics?.storage?.available != null ? `/ ${formatMetricsGi(metrics.storage.available)}` : undefined}
          pct={pctOf(metrics?.storage?.inUse, metrics?.storage?.available)}
          note="Used on the tenant volume"
          to={`${base}/storage`}
          testId="usage-storage"
        />
        <UsageTile
          label="Bandwidth"
          value={bw ? formatGb(bw.usedGb) : '—'}
          of={bw && bw.limitGb > 0 ? `/ ${formatGb(bw.limitGb, 0)}` : undefined}
          pct={bw && bw.limitGb > 0 ? bw.usedPct : undefined}
          note={bw?.capped ? 'Capped: the allowance is used up' : forecast ?? 'This billing cycle'}
          noteTone={bw?.capped || forecast ? 'warn' : undefined}
          to={`${base}/traffic`}
          testId="usage-bandwidth"
        />
        <UsageTile
          label="Email sent today"
          value={mail ? String(mail.day.used) : '—'}
          of={mail ? `/ ${mail.day.limit}` : undefined}
          pct={mail ? pctOf(mail.day.used, mail.day.limit) : undefined}
          note={mail ? (mail.outboundSuspended ? 'Outbound mail is suspended' : `${mail.hour.used} of ${mail.hour.limit} this hour`) : undefined}
          noteTone={mail?.outboundSuspended ? 'warn' : undefined}
          to={`${base}/email`}
          testId="usage-mail"
        />
      </section>

      <NamespaceIntegrityBanner tenantId={tenantId} />

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-6">
          <AttentionCard items={attention} onTab={onTab} />
          <DomainsCard tenantId={tenantId} />
          <ApplicationsCard tenantId={tenantId} />
          <RecentActivityCard tenantId={tenantId} />
        </div>

        <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-6">
          <PlacementSummaryCard tenant={tenant} tenantId={tenantId} placement={placement} />
          <AccountCard tenant={tenant} />
          <PlanCard tenant={tenant} tenantId={tenantId} planName={planName} pendingCpu={Boolean(cpuRow?.pendingCpuChange)} />
          <BackupsSummaryCard tenantId={tenantId} lastBundle={lastBundle} lastComplete={lastComplete} />
          <EmailSummaryCard tenantId={tenantId} outboundSuspended={tenant.emailOutboundSuspended === true} />
          <UsersCard tenantId={tenantId} />
        </aside>
      </div>
    </div>
  );
}

function AttentionCard({ items, onTab }: { readonly items: readonly AttentionItem[]; readonly onTab: (tab: TabKey) => void }) {
  return (
    <Card
      title="Needs attention"
      actions={<span className="text-xs text-gray-500 dark:text-gray-400">Each item clears itself when its condition does</span>}
      bodyClassName=""
      testId="attention-card"
    >
      {items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-600 dark:text-gray-400" data-testid="attention-empty">Nothing needs attention.</p>
      ) : (
        <ul>
          {items.map((i) => {
            const tab = i.to.match(/^\/tenants\/[^/]+\/(overview|email|traffic|storage|limits|activity)$/)?.[1] as TabKey | undefined;
            const content = (
              <>
                <span className={`mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full ${i.tone === 'bad' ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'}`}>
                  <AlertTriangle size={14} aria-hidden="true" />
                </span>
                <span className="block min-w-0 flex-1">
                  <span className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                    <span className="font-semibold text-gray-900 dark:text-gray-100">{i.title}</span>
                    {i.since && <span className="text-xs text-gray-500 dark:text-gray-400">{age(i.since)}</span>}
                  </span>
                  <span className="mt-0.5 block text-[13px] text-gray-700 dark:text-gray-300">{i.detail}</span>
                  <span className="mt-1 block text-[13px] font-medium text-brand-600 dark:text-brand-400">{i.action} →</span>
                </span>
              </>
            );
            const cls = 'flex w-full gap-3.5 px-5 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40';
            return (
              <li key={i.key} className="border-b border-gray-100 last:border-0 dark:border-gray-700" data-testid={`attention-${i.key}`}>
                {tab
                  ? <button type="button" className={cls} onClick={() => onTab(tab)}>{content}</button>
                  : <Link to={i.to} className={cls}>{content}</Link>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function DomainsCard({ tenantId }: { readonly tenantId: string }) {
  const { data: domainsRes, isLoading } = useDomains(tenantId);
  const domains = domainsRes?.data ?? [];
  return (
    <Card
      title="Domains"
      actions={<TenantPanelLink tenantId={tenantId} to={tenantPanel.domains()} label="Domains" testId="tp-domains">Manage domains</TenantPanelLink>}
      bodyClassName=""
      testId="domains-card"
    >
      {isLoading ? (
        <div className="flex items-center gap-2 px-5 py-4 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : domains.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-600 dark:text-gray-400">No domains yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]" data-testid="domains-table">
            <thead>
              <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th scope="col" className="px-5 py-2.5 font-medium">Domain</th>
                <th scope="col" className="px-5 py-2.5 font-medium">DNS</th>
                <th scope="col" className="px-5 py-2.5 font-medium">Certificate</th>
                <th scope="col" className="px-5 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id} className="border-b border-gray-100 last:border-0 dark:border-gray-700">
                  <td className="px-5 py-3">
                    <TenantPanelLink tenantId={tenantId} to={tenantPanel.domain(d.id)} label={`Domains → ${d.domainName}`}>{d.domainName}</TenantPanelLink>
                  </td>
                  <td className="px-5 py-3 text-gray-600 dark:text-gray-400">{d.dnsMode}</td>
                  <td className="px-5 py-3 text-gray-600 dark:text-gray-400">{d.sslAutoRenew ? 'Renews automatically' : 'Manual'}</td>
                  <td className="px-5 py-3"><StatusBadge status={d.status as 'active' | 'pending' | 'error'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ApplicationsCard({ tenantId }: { readonly tenantId: string }) {
  const { data: deploymentsRes, isLoading } = useDeployments(tenantId);
  const deployments = (deploymentsRes?.data ?? []).filter((d) => d.status !== 'deleted');
  return (
    <Card
      title="Applications"
      actions={<TenantPanelLink tenantId={tenantId} to={tenantPanel.applications()} label="Applications" testId="tp-applications">Manage applications</TenantPanelLink>}
      bodyClassName=""
      testId="applications-card"
    >
      {isLoading ? (
        <div className="flex items-center gap-2 px-5 py-4 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : deployments.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-600 dark:text-gray-400" data-testid="applications-empty">No applications yet.</p>
      ) : (
        <ApplicationsList tenantId={tenantId} deployments={deployments} />
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-gray-200 px-5 py-3 text-[13px] dark:border-gray-700">
        <TenantPanelLink tenantId={tenantId} to={tenantPanel.cronJobs()} label="Cron jobs">Cron jobs</TenantPanelLink>
        <TenantPanelLink tenantId={tenantId} to={tenantPanel.databases()} label="Database manager">Databases</TenantPanelLink>
        <TenantPanelLink tenantId={tenantId} to={tenantPanel.files()} label="Files">Files</TenantPanelLink>
      </div>
    </Card>
  );
}

function RecentActivityCard({ tenantId }: { readonly tenantId: string }) {
  const { data, isLoading } = useAuditLogs({ tenant_id: tenantId, limit: 6 });
  const entries = data?.data ?? [];
  return (
    <Card title="Recent activity" actions={<GoLink to={`/tenants/${tenantId}/activity`}>Full activity log</GoLink>} bodyClassName="" testId="recent-activity">
      {isLoading ? (
        <div className="flex items-center gap-2 px-5 py-4 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : entries.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-600 dark:text-gray-400">No recorded activity yet.</p>
      ) : (
        <ol className="py-1">
          {entries.map((e) => {
            const d = describeAuditEntry(e);
            return (
              <li key={e.id} className="flex gap-3.5 px-5 py-2.5">
                <span aria-hidden="true" className="mt-1.5 h-2 w-2 flex-none rounded-full bg-gray-300 dark:bg-gray-600" />
                <span className="flex min-w-0 flex-1 flex-wrap justify-between gap-x-4 gap-y-0.5 text-[13px]">
                  <span className="min-w-0 text-gray-900 dark:text-gray-100">{d.what}<span className="text-gray-500 dark:text-gray-400"> · {d.who}</span></span>
                  <span className="whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">{new Date(e.createdAt).toLocaleString()}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function PlacementSummaryCard({ tenant, tenantId, placement }: { readonly tenant: Tenant; readonly tenantId: string; readonly placement: TenantPlacement | null }) {
  const nodeLabel = useNodeLabel();
  const running = placement ? (placement.workloadNodes.length > 0 ? placement.workloadNodes : placement.attachedNodes) : [];
  const pinned = placement?.primaryNode ?? tenant.nodeName ?? null;
  const misplaced = placement?.status === 'misplaced';
  return (
    <Link
      to={`/tenants/${tenantId}/storage`}
      className="block rounded-xl border border-gray-200 bg-white shadow-sm hover:border-brand-500 hover:ring-1 hover:ring-brand-500 dark:border-gray-700 dark:bg-gray-800"
      data-testid="placement-summary-card"
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-3.5 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Placement</h2>
        {misplaced ? <Chip tone="warn">Away from pinned node</Chip> : placement?.status === 'placed' ? <Chip tone="ok">On its pinned node</Chip> : null}
      </div>
      <div className="grid grid-cols-2 gap-2.5 p-5">
        <div className="rounded-lg border-2 border-green-500 bg-green-50 px-3 py-2.5 dark:border-green-600 dark:bg-green-900/20">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-green-800 dark:text-green-300"><span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />ACTIVE</div>
          <div className="mt-1 font-semibold text-gray-900 dark:text-gray-100">{running.length > 0 ? running.map(nodeLabel).join(', ') : 'Nothing running'}</div>
          <div className="text-xs text-gray-600 dark:text-gray-400">{running.length > 0 ? 'Where its pods run now' : 'No pod runs and no volume is attached'}</div>
        </div>
        <div className="rounded-lg border-2 border-dashed border-brand-500 px-3 py-2.5 dark:border-brand-400">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300"><Pin size={12} aria-hidden="true" />PINNED</div>
          <div className="mt-1 font-semibold text-gray-900 dark:text-gray-100">{pinned ? nodeLabel(pinned) : 'Auto'}</div>
          <div className="text-xs text-gray-600 dark:text-gray-400">Where it should run and keep its data</div>
        </div>
        <div className="col-span-2 text-[13px] text-gray-700 dark:text-gray-300">
          {tenant.storageTier === 'ha' ? 'HA storage, 2 replicas.' : 'Local storage, 1 replica.'}{' '}
          <span className="font-medium text-brand-600 dark:text-brand-400">Review placement →</span>
        </div>
      </div>
    </Link>
  );
}

function ContactEmailLine({ label, value }: { readonly label: string; readonly value: string | null | undefined }) {
  const email = value?.trim();
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5">
      <span className="text-xs text-gray-500 dark:text-gray-400">{label}:</span>
      {email
        ? <a href={`mailto:${email}`} className="break-all text-brand-600 hover:underline dark:text-brand-400">{email}</a>
        : <span className="italic text-gray-500 dark:text-gray-400">Not set</span>}
    </div>
  );
}

function AccountCard({ tenant }: { readonly tenant: Tenant }) {
  return (
    <Card title="Account" testId="account-card">
      <KV rows={[
        ['Contact email', (
          <div className="space-y-0.5" data-testid="tenant-contact-email" key="contact">
            <ContactEmailLine label="Primary" value={tenant.primaryEmail} />
            <ContactEmailLine label="Secondary" value={tenant.secondaryEmail} />
          </div>
        )],
        ['Tenant ID', <span className="font-mono text-xs" key="id">{tenant.id}</span>],
        ['Created', tenant.createdAt ? new Date(tenant.createdAt).toLocaleDateString() : '—'],
        ['Created by', <span data-testid="tenant-created-by" key="by">{createdByLabel(tenant.createdBy, tenant.createdByName)}</span>],
        ['Automation', tenant.lifecycleAutomationExempt
          ? 'Kept out of automatic archive and delete'
          : <Link to="/platform/lifecycle-hooks" className="text-brand-600 hover:underline dark:text-brand-400" key="auto">Follows the platform's lifecycle rules</Link>],
      ]}
      />
    </Card>
  );
}

function PlanCard({ tenant, tenantId, planName, pendingCpu }: { readonly tenant: Tenant; readonly tenantId: string; readonly planName: string | null; readonly pendingCpu: boolean }) {
  const overrides = [
    tenant.cpuTierOverride, tenant.cpuBurstCoresOverride, tenant.memoryLimitOverride,
    tenant.storageLimitOverride, tenant.bandwidthLimitOverride, tenant.maxSubUsersOverride, tenant.maxMailboxesOverride, tenant.maxApplicationsOverride,
    tenant.maxMailboxSizeMbOverride, tenant.monthlyPriceOverride, tenant.emailSendRateLimit, tenant.emailSendRateLimitDaily,
    tenant.allowCustomContainersOverride,
  ].filter((v) => v != null).length;
  return (
    <Link
      to={`/tenants/${tenantId}/limits`}
      className="block rounded-xl border border-gray-200 bg-white shadow-sm hover:border-brand-500 hover:ring-1 hover:ring-brand-500 dark:border-gray-700 dark:bg-gray-800"
      data-testid="plan-summary-card"
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-3.5 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Plan</h2>
        <span className="text-[13px] font-medium text-brand-600 dark:text-brand-400">Plan &amp; limits →</span>
      </div>
      <div className="p-5">
        <div className="text-base font-semibold text-gray-900 dark:text-gray-100">{planName ?? (tenant.planId ? 'Plan' : 'No plan')}</div>
        <p className="mt-1 text-[13px] text-gray-700 dark:text-gray-300">
          {overrides === 0 ? 'Every limit follows the plan.' : `${overrides} custom ${overrides === 1 ? 'limit' : 'limits'}.`}
          {pendingCpu && ' CPU settings wait for Re-apply.'}
        </p>
      </div>
    </Link>
  );
}

function BackupsSummaryCard({ tenantId, lastBundle, lastComplete }: {
  readonly tenantId: string;
  readonly lastBundle: { readonly status: string; readonly startedAt: string | null; readonly finishedAt: string | null; readonly sizeBytes: number } | undefined;
  readonly lastComplete: { readonly finishedAt: string | null; readonly startedAt: string | null; readonly sizeBytes: number } | undefined;
}) {
  const { data: snaps } = useTenantSnapshots(tenantId);
  const snapshotCount = snaps?.data?.snapshots?.length;
  const tone: Tone = !lastBundle ? 'neutral' : lastBundle.status === 'completed' ? 'ok' : lastBundle.status === 'failed' ? 'bad' : lastBundle.status === 'partial' ? 'warn' : 'info';
  const when = (b?: { readonly finishedAt: string | null; readonly startedAt: string | null }) =>
    b ? new Date(b.finishedAt ?? b.startedAt ?? '').toLocaleString() : '—';
  return (
    <Link
      to={`/tenants/${tenantId}/storage`}
      className="block rounded-xl border border-gray-200 bg-white shadow-sm hover:border-brand-500 hover:ring-1 hover:ring-brand-500 dark:border-gray-700 dark:bg-gray-800"
      data-testid="backups-summary-card"
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-3.5 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Backups</h2>
        <span className="text-[13px] font-medium text-brand-600 dark:text-brand-400">Storage &amp; backups →</span>
      </div>
      <div className="p-5">
        <KV rows={[
          ['Last backup', lastBundle ? <span key="l" className="inline-flex flex-wrap items-center gap-2"><Chip tone={tone}>{lastBundle.status}</Chip><span className="text-xs text-gray-500 dark:text-gray-400">{when(lastBundle)}</span></span> : 'None yet'],
          ['Last complete', lastComplete ? `${when(lastComplete)} · ${formatGb(lastComplete.sizeBytes / 1e9)}` : '—'],
          ['Snapshots', snapshotCount != null ? String(snapshotCount) : '—'],
        ]}
        />
      </div>
    </Link>
  );
}

function EmailSummaryCard({ tenantId, outboundSuspended }: { readonly tenantId: string; readonly outboundSuspended: boolean }) {
  const { data: domainsRes } = useEmailDomains(tenantId);
  const { data: mailboxesRes } = useMailboxes(tenantId);
  const { data: aliasesRes } = useEmailAliases(tenantId);
  const { data: jobsRes } = useImapSyncJobs(tenantId);
  const mailboxes = mailboxesRes?.data ?? [];
  const aliasCount = mailboxes.reduce((n, m) => n + (m.aliases?.length ?? 0), 0);
  const forwardCount = mailboxes.filter((m) => (m.forwardingAddresses?.length ?? 0) > 0).length;
  const jobs = jobsRes?.data ?? [];
  const running = jobs.filter((j) => j.status === 'running' || j.status === 'pending').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;
  return (
    <Link
      to={`/tenants/${tenantId}/email`}
      className="block rounded-xl border border-gray-200 bg-white shadow-sm hover:border-brand-500 hover:ring-1 hover:ring-brand-500 dark:border-gray-700 dark:bg-gray-800"
      data-testid="email-summary-card"
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-3.5 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Email</h2>
        <span className="text-[13px] font-medium text-brand-600 dark:text-brand-400">Email →</span>
      </div>
      <div className="p-5">
        <KV rows={[
          ['Outbound', outboundSuspended ? <Chip key="o" tone="bad" dot>Suspended</Chip> : <Chip key="o" tone="ok" dot>Sending</Chip>],
          ['Domains', String(domainsRes?.data.length ?? 0)],
          ['Addresses', `${mailboxes.length} mailboxes · ${aliasCount} aliases · ${forwardCount} forwarding · ${aliasesRes?.data.length ?? 0} lists`],
          ['Migrations', jobs.length === 0 ? 'None' : `${jobs.length} · ${running} running · ${failed} failed`],
        ]}
        />
      </div>
    </Link>
  );
}

function UsersCard({ tenantId }: { readonly tenantId: string }) {
  const { data: subUsers } = useAdminSubUsers(tenantId);
  const { data: sftp } = useSftpUsers({ tenantId });
  return (
    <Card
      title="Users & access"
      actions={<TenantPanelLink tenantId={tenantId} to={tenantPanel.users()} label="Users" testId="tp-users">Manage</TenantPanelLink>}
      testId="users-card"
    >
      <KV rows={[
        ['Panel users', <TenantPanelLink key="u" tenantId={tenantId} to={tenantPanel.users()} label="Users">{`${subUsers?.data.length ?? 0} sub-users`}</TenantPanelLink>],
        ['SFTP users', <TenantPanelLink key="s" tenantId={tenantId} to={tenantPanel.sftp()} label="SFTP">{String(sftp?.data.length ?? 0)}</TenantPanelLink>],
        ['SSH keys', <TenantPanelLink key="k" tenantId={tenantId} to={tenantPanel.sshKeys()} label="SSH keys">Open</TenantPanelLink>],
      ]}
      />
    </Card>
  );
}
