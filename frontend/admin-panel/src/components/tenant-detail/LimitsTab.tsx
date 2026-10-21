/**
 * Tenant → Plan & limits.
 *
 * Every limit as one row: what is used, what the tenant gets (and whether
 * that is the plan's value or its own), and — where the platform can tell —
 * whether it is in force. Editing is one mode for the whole page: change any
 * number of limits, see what each change will do, then save them together.
 * Only the limits that changed are sent.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, Loader2, Pencil } from 'lucide-react';
import clsx from 'clsx';
import type { Tenant } from '@/types/api';
import { useUpdateTenant } from '@/hooks/use-tenants';
import { usePlans, type Plan } from '@/hooks/use-plans';
import { useSubscription, useUpdateSubscription } from '@/hooks/use-subscription';
import { useSystemInfo } from '@/hooks/use-system-info';
import { useTenantMetrics } from '@/hooks/use-resource-metrics';
import { useTenantBandwidth, useTenantMailUsage, useTenantSendLimitsLive } from '@/hooks/use-tenant-insights';
import { useMailboxes } from '@/hooks/use-email';
import { useAdminSubUsers } from '@/hooks/use-sub-users';
import { useDeployments } from '@/hooks/use-deployments';
import { useCpuMigrationPreview } from '@/hooks/use-cpu-migration';
import ApplyCpuLimitsPanel from '@/components/ApplyCpuLimitsPanel';
import NamespaceIntegrityBanner from '@/components/NamespaceIntegrityBanner';
import OperationProgressModal from '@/components/OperationProgressModal';
import ReleasedSourceVolumeOffer from '@/components/ReleasedSourceVolumeOffer';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { formatCurrency } from '@/lib/format-currency';
import { SubscriptionCard } from './SubscriptionCard';
import { Card, Chip, Meter } from './ui';
import {
  buildLimitRows, diffDrafts, formatLimit, initialDraft, isRefused,
  type Draft, type LimitGroup, type LimitId, type LimitRow,
} from './limits-model';

const GROUPS: readonly LimitGroup[] = ['Compute', 'Storage and traffic', 'Email', 'Users and features', 'Billing'];

interface Usage { readonly value: number; readonly text: string }

export default function LimitsTab({ tenant, tenantId }: { readonly tenant: Tenant; readonly tenantId: string }) {
  const qc = useQueryClient();
  const updateTenant = useUpdateTenant(tenantId);
  const { data: plansRes } = usePlans();
  const plans = plansRes?.data ?? [];
  const plan = plans.find((p) => p.id === tenant.planId);
  const { data: sys } = useSystemInfo();
  const currency = sys?.currency ?? 'USD';
  const rows = useMemo(() => buildLimitRows(tenant, plan, currency), [tenant, plan, currency]);

  const { data: metricsRes } = useTenantMetrics(tenantId);
  const { data: bwRes } = useTenantBandwidth(tenantId);
  const { data: mailRes } = useTenantMailUsage(tenantId);
  const { data: mailboxesRes } = useMailboxes(tenantId);
  const { data: subUsersRes } = useAdminSubUsers(tenantId);
  const { data: deploymentsRes } = useDeployments(tenantId);
  const { data: cpuPreview } = useCpuMigrationPreview();
  const { data: liveRes } = useTenantSendLimitsLive(tenantId);
  const subscriptionQuery = useSubscription(tenantId);
  const cpuRow = cpuPreview?.data?.tenants?.find((t) => t.tenantId === tenantId);
  const cpuTiered = tenant.cpuSchedulingMode === 'tiered';
  const live = liveRes?.data;

  const m = metricsRes?.data;
  const mailboxes = mailboxesRes?.data ?? [];
  const usage: Partial<Record<LimitId, Usage>> = {};
  // No CPU usage beside the limits: the only CPU limit left is the burst
  // ceiling, which is per application, and tenant-wide use is not comparable
  // with it. The Overview tile shows CPU use.
  if (m?.memory?.inUse != null) usage.memory = { value: m.memory.inUse, text: `${m.memory.inUse.toFixed(2)} GB now` };
  if (m?.storage?.inUse != null) usage.storage = { value: Math.round(m.storage.inUse * 10) / 10, text: `${m.storage.inUse.toFixed(1)} GB used` };
  if (bwRes?.data) usage.bandwidth = { value: Math.round(bwRes.data.usedGb * 10) / 10, text: `${bwRes.data.usedGb.toFixed(1)} GB this cycle` };
  if (mailboxesRes) usage.mailboxes = { value: mailboxes.length, text: `${mailboxes.length} in use` };
  if (mailboxes.length > 0) {
    const largest = Math.max(...mailboxes.map((x) => x.usedMb));
    usage.mailboxSize = { value: largest, text: `largest ${largest} MB` };
  }
  if (mailRes?.data?.hour && mailRes.data.day) {
    usage.sendsHour = { value: mailRes.data.hour.used, text: `${mailRes.data.hour.used} this hour` };
    usage.sendsDay = { value: mailRes.data.day.used, text: `${mailRes.data.day.used} today` };
  }
  if (subUsersRes) usage.subUsers = { value: subUsersRes.data.length, text: `${subUsersRes.data.length} in use` };
  if (deploymentsRes) {
    const custom = deploymentsRes.data.filter((d) => d.source === 'custom' && d.status !== 'deleted').length;
    usage.customContainers = { value: custom, text: `${custom} deployed` };
  }
  const inUse = Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, v!.value])) as Partial<Record<LimitId, number>>;

  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<LimitId, Draft>>>({});
  const [reviewing, setReviewing] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const [opDestructive, setOpDestructive] = useState(false);
  const [shrink, setShrink] = useState<{ targetGi: number; currentGi: number; remediation: string } | null>(null);

  const diff = diffDrafts(rows, editing ? drafts : {}, { inUse, cpuTiered });
  const refused = diff.changes.some(isRefused);
  const customCount = rows.filter((r) => r.override !== null).length;
  const sendNotOnServer = live?.reachable === true && live.domains.some((d) => !d.inEffect);
  const waiting = (cpuRow?.pendingCpuChange ? 1 : 0) + (sendNotOnServer ? 1 : 0);

  // Drafts hold only the limits the operator touched; an untouched row shows,
  // and is compared as, the live value — so another admin's change that lands
  // while this page edits is neither shown stale nor reverted on save.
  const startEdit = () => {
    setDrafts({});
    setSaveError(null);
    setSavedMsg(null);
    setEditing(true);
  };
  const discard = () => { setEditing(false); setReviewing(false); setDrafts({}); setSaveError(null); };
  const draftOf = (r: LimitRow): Draft => drafts[r.id] ?? initialDraft(r);
  const setDraft = (r: LimitRow, d: Partial<Draft>) => setDrafts((prev) => ({ ...prev, [r.id]: { ...(prev[r.id] ?? initialDraft(r)), ...d } }));
  const allToPlan = () => setDrafts((prev) => Object.fromEntries(rows.map((r) => [r.id, { ...(prev[r.id] ?? initialDraft(r)), mode: 'plan' as const }])));

  const afterSave = async (count: number) => {
    setEditing(false);
    setReviewing(false);
    setDrafts({});
    setSavedMsg(`Saved ${count} ${count === 1 ? 'change' : 'changes'}.`);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['tenant-send-limits-live', tenantId] }),
      qc.invalidateQueries({ queryKey: ['tenant-mail-usage', tenantId] }),
      qc.invalidateQueries({ queryKey: ['tenant-bandwidth', tenantId] }),
      qc.invalidateQueries({ queryKey: ['cpu-migration-preview'] }),
    ]);
  };

  const save = async () => {
    setSaveError(null);
    const count = diff.changes.length;
    try {
      const res = await updateTenant.mutateAsync(diff.payload as never);
      const grow = (res as { data?: { storageGrowOperationId?: string | null } })?.data?.storageGrowOperationId;
      if (grow) { setOpDestructive(false); setOpId(grow); }
      await afterSave(count);
    } catch (err) {
      const apiErr = err as { code?: string; details?: { targetMib?: number; targetGi?: number; currentGi?: number; remediation?: string } };
      if (apiErr?.code === 'STORAGE_RESIZE_REQUIRED' && apiErr.details?.targetMib != null) {
        setReviewing(false);
        setShrink({
          targetGi: apiErr.details.targetGi ?? Math.round(apiErr.details.targetMib / 102.4) / 10,
          currentGi: apiErr.details.currentGi ?? Number(tenant.storageLimitOverride ?? plan?.storageLimit ?? 0),
          remediation: apiErr.details.remediation ?? 'The platform takes a snapshot, drops the volume, recreates it at the smaller size, and restores from the snapshot.',
        });
        return;
      }
      setSaveError(err);
    }
  };

  // The same changes again, with the shrink confirmed — every changed limit,
  // not just the storage one, so nothing else typed into the form is lost.
  const confirmShrink = async () => {
    if (!shrink) return;
    const count = diff.changes.length;
    try {
      const res = await updateTenant.mutateAsync({ ...diff.payload, confirm_destructive_shrink: true } as never);
      const op = (res as { data?: { storageShrinkOperationId?: string | null } })?.data?.storageShrinkOperationId;
      if (op) { setOpDestructive(true); setOpId(op); }
      setShrink(null);
      await afterSave(count);
    } catch (err) {
      setShrink({ ...shrink, remediation: `${shrink.remediation}\n\nFailed: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  return (
    <div className={clsx('space-y-6', editing && 'pb-28')} data-testid="tenant-limits">
      <section aria-label="Plan summary" className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <a href="#plans" className="block rounded-xl border border-gray-200 bg-white px-4 py-4 shadow-sm hover:border-brand-500 hover:ring-1 hover:ring-brand-500 dark:border-gray-700 dark:bg-gray-800">
          <div className="text-[13px] font-medium text-gray-600 dark:text-gray-400">Plan</div>
          <div className="mt-1 text-xl font-bold text-gray-900 dark:text-gray-100">{plan?.name ?? 'No plan'}</div>
          <div className="mt-1 text-[13px] font-medium text-brand-600 dark:text-brand-400">Compare plans →</div>
        </a>
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="text-[13px] font-medium text-gray-600 dark:text-gray-400">Price</div>
          <div className="mt-1 text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(Number(tenant.monthlyPriceOverride ?? plan?.monthlyPriceUsd ?? 0), currency)}
            <span className="ml-1 text-[13px] font-normal text-gray-500 dark:text-gray-400">/ month</span>
          </div>
          <div className="mt-1 text-[13px] text-gray-600 dark:text-gray-400">{tenant.monthlyPriceOverride != null ? 'Custom price' : 'The plan’s price'}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-4 shadow-sm dark:border-gray-700 dark:bg-gray-800" data-testid="custom-limit-count">
          <div className="text-[13px] font-medium text-gray-600 dark:text-gray-400">Custom limits</div>
          <div className="mt-1 text-xl font-bold text-gray-900 dark:text-gray-100">{customCount} <span className="text-[13px] font-normal text-gray-500 dark:text-gray-400">of {rows.length}</span></div>
          <div className="mt-1 text-[13px] text-gray-600 dark:text-gray-400">Everything else follows the plan</div>
        </div>
        <div className={clsx('rounded-xl border bg-white px-4 py-4 shadow-sm dark:bg-gray-800', waiting > 0 ? 'border-amber-300 dark:border-amber-700' : 'border-gray-200 dark:border-gray-700')} data-testid="waiting-count">
          <div className="text-[13px] font-medium text-gray-600 dark:text-gray-400">Not yet in force</div>
          <div className={clsx('mt-1 text-xl font-bold', waiting > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100')}>{waiting}</div>
          <div className="mt-1 text-[13px] text-gray-600 dark:text-gray-400">
            {[cpuRow?.pendingCpuChange && 'CPU settings wait for Re-apply', sendNotOnServer && 'send limits differ on the mail server'].filter(Boolean).join('; ') || 'Everything saved is in force'}
          </div>
        </div>
      </section>

      <SubscriptionCard tenantId={tenantId} data={subscriptionQuery.data?.data} isLoading={subscriptionQuery.isLoading} />
      <NamespaceIntegrityBanner tenantId={tenantId} />

      {savedMsg && !editing && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-lg bg-green-50 px-4 py-3 text-sm font-medium text-green-800 dark:bg-green-900/20 dark:text-green-300" data-testid="limits-saved">
          <span>{savedMsg}</span>
          <button type="button" onClick={() => setSavedMsg(null)} className="text-xs underline">Dismiss</button>
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Limits</h2>
          <p className="text-[13px] text-gray-600 dark:text-gray-400">A custom value overrides the plan for this tenant only. Back on the plan, the limit follows later plan changes too.</p>
        </div>
        {editing ? (
          <button type="button" onClick={allToPlan} className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700" data-testid="limits-all-to-plan">
            Put every limit back on the plan
          </button>
        ) : (
          <button type="button" onClick={startEdit} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600" data-testid="edit-limits-button">
            <Pencil size={14} aria-hidden="true" /> Edit limits
          </button>
        )}
      </div>

      {GROUPS.map((g) => (
        <Card key={g} title={g} bodyClassName="" testId={`limits-group-${g.toLowerCase().replace(/\s+/g, '-')}`}>
          <div className="overflow-x-auto">
            <div className="min-w-[860px]">
              <div className="grid grid-cols-[minmax(0,24fr)_minmax(0,22fr)_minmax(0,32fr)_minmax(0,22fr)] gap-5 border-b border-gray-200 px-5 py-2.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <div>Limit</div><div>In use</div><div>This tenant gets</div><div>In force</div>
              </div>
              {rows.filter((r) => r.group === g).map((r) => (
                <LimitRowView
                  key={r.id}
                  row={r}
                  usage={usage[r.id]}
                  editing={editing}
                  draft={editing ? draftOf(r) : undefined}
                  change={diff.changes.find((c) => c.id === r.id)}
                  invalid={diff.invalid.includes(r.label)}
                  onDraft={(d) => setDraft(r, d)}
                  status={<LimitStatus row={r} tenantId={tenantId} cpuTiered={cpuTiered} cpuPending={Boolean(cpuRow?.pendingCpuChange)} live={live} />}
                />
              ))}
            </div>
          </div>
          {g === 'Compute' && (
            <div className="border-t border-gray-200 px-5 py-4 dark:border-gray-700">
              <ApplyCpuLimitsPanel tenantId={tenantId} schedulingMode={tenant.cpuSchedulingMode} />
            </div>
          )}
        </Card>
      ))}

      <PlanCompare tenant={tenant} tenantId={tenantId} plans={plans} current={plan} usage={inUse} currency={currency} />

      {editing && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 shadow-[0_-6px_24px_rgba(0,0,0,0.08)] backdrop-blur dark:border-gray-700 dark:bg-gray-800/95" data-testid="limits-change-bar">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-3.5">
            <div className="min-w-0">
              <div className="font-semibold text-gray-900 dark:text-gray-100">
                {diff.changes.length === 0 ? 'Editing limits: no changes yet' : `${diff.changes.length} ${diff.changes.length === 1 ? 'change' : 'changes'} not saved`}
              </div>
              <div className="truncate text-[13px] text-gray-600 dark:text-gray-400">
                {diff.invalid.length > 0
                  ? <span className="text-red-600 dark:text-red-400">Not a valid value: {diff.invalid.join(', ')}</span>
                  : diff.changes.length === 0 ? 'Choose Plan or Custom on any limit.' : diff.changes.map((c) => c.label).join(', ')}
              </div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={discard} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700" data-testid="limits-discard">Discard</button>
              <button
                type="button"
                onClick={() => { setSaveError(null); setReviewing(true); }}
                disabled={diff.changes.length === 0 || diff.invalid.length > 0}
                className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                data-testid="limits-review"
              >
                Review {diff.changes.length || ''} {diff.changes.length === 1 ? 'change' : 'changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {reviewing && (
        <div className="fixed inset-0 z-60 flex items-start justify-center overflow-y-auto bg-black/50 px-4 py-16" onClick={(e) => { if (e.target === e.currentTarget && !updateTenant.isPending) setReviewing(false); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="limits-review-title" className="w-full max-w-2xl rounded-xl bg-white shadow-xl dark:bg-gray-800" data-testid="limits-review-dialog">
            <div className="border-b border-gray-200 px-5 py-3.5 dark:border-gray-700">
              <h2 id="limits-review-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">Save {diff.changes.length} limit {diff.changes.length === 1 ? 'change' : 'changes'} for {tenant.name}?</h2>
            </div>
            <ul>
              {diff.changes.map((c) => (
                <li key={c.id} className="border-b border-gray-100 px-5 py-3.5 dark:border-gray-700" data-testid={`limits-review-${c.id}`}>
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm">
                    <span className="font-semibold text-gray-900 dark:text-gray-100">{c.label}</span>
                    <span className="tabular-nums text-gray-700 dark:text-gray-300">{c.from} <span className="text-gray-400">→</span> <strong className="text-gray-900 dark:text-gray-100">{c.to}</strong></span>
                  </div>
                  <p className={clsx('mt-1 flex items-start gap-1.5 text-[13px]', c.tone === 'ok' ? 'text-green-700 dark:text-green-400' : c.tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400')}>
                    {c.tone !== 'ok' && <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />}
                    {c.effect}
                  </p>
                </li>
              ))}
            </ul>
            {saveError !== null && <div className="px-5 pt-3"><ErrorPanel error={extractOperatorError(saveError)} severity="error" testId="limits-save-error" /></div>}
            <div className="flex flex-wrap justify-end gap-2 px-5 py-3.5">
              <button type="button" onClick={() => setReviewing(false)} disabled={updateTenant.isPending} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">
                Back to editing
              </button>
              <button type="button" onClick={save} disabled={updateTenant.isPending || refused} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="save-limits-button">
                {updateTenant.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {refused ? 'Fix the refused change first' : `Save ${diff.changes.length} ${diff.changes.length === 1 ? 'change' : 'changes'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {shrink && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4" data-testid="shrink-confirm-modal" onClick={(e) => { if (e.target === e.currentTarget && !updateTenant.isPending) setShrink(null); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="shrink-title" className="w-full max-w-lg rounded-xl bg-white shadow-xl dark:bg-gray-800">
            <div className="border-b border-red-200 bg-red-50 px-5 py-3 dark:border-red-700/40 dark:bg-red-900/20">
              <h3 id="shrink-title" className="flex items-center gap-2 text-base font-semibold text-red-800 dark:text-red-200"><AlertCircle size={18} aria-hidden="true" /> Destructive storage shrink</h3>
            </div>
            <div className="space-y-3 p-5 text-sm text-gray-700 dark:text-gray-300">
              <p>You are shrinking storage from <strong>{shrink.currentGi} GiB</strong> to <strong>{shrink.targetGi} GiB</strong>.</p>
              <p className="whitespace-pre-wrap">{shrink.remediation}</p>
              <p>The platform takes a snapshot, drops the volume, recreates it at the smaller size, and restores from the snapshot. <strong>Downtime: a few minutes per GiB.</strong> Your other changes are saved with it.</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3 dark:border-gray-700">
              <button type="button" onClick={() => setShrink(null)} disabled={updateTenant.isPending} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700" data-testid="shrink-confirm-cancel">Cancel</button>
              <button type="button" onClick={confirmShrink} disabled={updateTenant.isPending} className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50" data-testid="shrink-confirm-button">
                {updateTenant.isPending ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
                Continue with destructive resize
              </button>
            </div>
          </div>
        </div>
      )}

      <OperationProgressModal
        operationId={opId}
        title="Storage resize"
        onClose={() => { setOpId(null); setOpDestructive(false); }}
        onSuccessSlot={opDestructive && tenant.kubernetesNamespace ? <ReleasedSourceVolumeOffer namespace={tenant.kubernetesNamespace} /> : undefined}
      />
    </div>
  );
}

function LimitRowView({ row, usage, editing, draft, change, invalid, onDraft, status }: {
  readonly row: LimitRow;
  readonly usage: Usage | undefined;
  readonly editing: boolean;
  readonly draft: Draft | undefined;
  readonly change: { readonly effect: string; readonly tone: string; readonly from: string; readonly to: string } | undefined;
  readonly invalid: boolean;
  readonly onDraft: (d: Partial<Draft>) => void;
  readonly status: ReactNode;
}) {
  const effective = row.override ?? row.planValue;
  const limitNum = effective !== null && row.kind === 'number' ? Number(effective) : NaN;
  const pct = usage && Number.isFinite(limitNum) && limitNum > 0 ? (usage.value / limitNum) * 100 : null;
  const slug = row.label.toLowerCase().replace(/\s+/g, '-');
  return (
    <div
      className={clsx(
        'grid grid-cols-[minmax(0,24fr)_minmax(0,22fr)_minmax(0,32fr)_minmax(0,22fr)] items-center gap-5 border-b border-gray-100 px-5 py-3.5 text-[13px] last:border-0 dark:border-gray-700',
        change && 'bg-brand-50 dark:bg-brand-950',
      )}
      data-testid={`limit-${row.id}`}
    >
      <div className="min-w-0">
        <div className="font-semibold text-gray-900 dark:text-gray-100">{row.label}</div>
        {row.hint && <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{row.hint}</div>}
      </div>
      <div className="min-w-0">
        {usage ? (
          <>
            {pct !== null && <div className="flex items-center gap-2.5"><div className="min-w-[70px] flex-1"><Meter pct={pct} /></div><span className="w-9 text-right text-xs tabular-nums text-gray-700 dark:text-gray-300">{Math.round(pct)}%</span></div>}
            <div className={clsx('text-xs text-gray-600 dark:text-gray-400', pct !== null && 'mt-1')}>{usage.text}</div>
          </>
        ) : <span className="text-gray-400">—</span>}
      </div>
      <div className="min-w-0">
        {!editing || !draft ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-bold text-gray-900 dark:text-gray-100" data-testid={`limit-value-${row.id}`}>{formatLimit(row, effective)}</span>
            {row.override !== null
              ? <><Chip tone="warn">Custom</Chip><span className="text-xs text-gray-500 dark:text-gray-400">plan: {formatLimit(row, row.planValue)}</span></>
              : <Chip>Plan</Chip>}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex overflow-hidden rounded-lg border border-gray-300 dark:border-gray-600" role="group" aria-label={`${row.label}: follow the plan or set a custom value`}>
              <button type="button" aria-pressed={draft.mode === 'plan'} onClick={() => onDraft({ mode: 'plan' })} className={clsx('px-2.5 py-1.5 text-xs font-medium', draft.mode === 'plan' ? 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300' : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700')} data-testid={`limit-plan-${slug}`}>
                Plan · {formatLimit(row, row.planValue)}
              </button>
              <button type="button" aria-pressed={draft.mode === 'custom'} onClick={() => onDraft({ mode: 'custom' })} className={clsx('border-l border-gray-300 px-2.5 py-1.5 text-xs font-medium dark:border-gray-600', draft.mode === 'custom' ? 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300' : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700')} data-testid={`limit-custom-${slug}`}>
                Custom
              </button>
            </div>
            {draft.mode === 'custom' && row.kind === 'number' && (
              <label className="inline-flex items-center gap-1.5">
                <span className="sr-only">{row.label}, custom value</span>
                <input
                  type="number"
                  min={0}
                  step={row.step}
                  value={draft.value}
                  onChange={(e) => onDraft({ value: e.target.value })}
                  className={clsx('w-28 rounded-lg border px-2.5 py-1.5 text-sm dark:bg-gray-700 dark:text-gray-100', invalid ? 'border-red-500' : 'border-gray-300 dark:border-gray-600')}
                  data-testid={`value-${slug}`}
                />
                <span className="text-xs text-gray-500 dark:text-gray-400">{row.unit}</span>
              </label>
            )}
            {draft.mode === 'custom' && row.kind === 'tier' && (
              <select value={draft.value} onChange={(e) => onDraft({ value: e.target.value })} aria-label={`${row.label}, custom value`} className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" data-testid="tenant-cpu-tier">
                <option value="normal">Normal, 1× share</option>
                <option value="high">High, 2× share</option>
                <option value="highest">Highest, 4× share</option>
              </select>
            )}
            {draft.mode === 'custom' && row.kind === 'bool' && (
              <select value={draft.value} onChange={(e) => onDraft({ value: e.target.value })} aria-label={`${row.label}, custom value`} className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" data-testid={`value-${slug}`}>
                <option value="true">Allowed</option>
                <option value="false">Not allowed</option>
              </select>
            )}
          </div>
        )}
      </div>
      <div className="min-w-0">
        {editing && change ? (
          <>
            <Chip tone="info">Changes: {change.from} → {change.to}</Chip>
            <div className={clsx('mt-1 text-xs', change.tone === 'ok' ? 'text-green-700 dark:text-green-400' : change.tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400')}>{change.effect}</div>
          </>
        ) : status}
      </div>
    </div>
  );
}

/**
 * Only what the platform can actually tell: CPU tier and ceiling against the
 * applied state, send limits against the mail server. Nothing is claimed for
 * the rest.
 */
function LimitStatus({ row, tenantId, cpuTiered, cpuPending, live }: {
  readonly row: LimitRow;
  readonly tenantId: string;
  readonly cpuTiered: boolean;
  readonly cpuPending: boolean;
  readonly live: { readonly reachable: boolean; readonly domains: ReadonlyArray<{ readonly domain: string; readonly inEffect: boolean }> } | undefined;
}) {
  if (row.id === 'tier' || row.id === 'burst') {
    if (!cpuTiered) return <span className="text-xs text-amber-700 dark:text-amber-400" data-testid={`limit-status-${row.id}`}>Not in effect: this tenant still uses the legacy CPU limit</span>;
    if (cpuPending) {
      return (
        <span className="flex flex-col gap-1" data-testid={`limit-status-${row.id}`}>
          <Chip tone="warn">Waiting for Re-apply</Chip>
          <Link to="/cluster/cpu-scheduling" className="text-xs text-brand-600 hover:underline dark:text-brand-400">Cluster → CPU scheduling</Link>
        </span>
      );
    }
    return <span data-testid={`limit-status-${row.id}`}><Chip tone="ok">✓ Applied</Chip></span>;
  }
  if (row.id === 'sendsHour' || row.id === 'sendsDay') {
    if (!live) return <span className="text-gray-400">—</span>;
    if (!live.reachable) return <span className="text-xs text-amber-700 dark:text-amber-400" data-testid={`limit-status-${row.id}`}>Mail server not reachable</span>;
    if (live.domains.length === 0) return <span className="text-xs text-gray-500 dark:text-gray-400" data-testid={`limit-status-${row.id}`}>No mail domain to limit</span>;
    const off = live.domains.filter((d) => !d.inEffect);
    return off.length === 0
      ? <span data-testid={`limit-status-${row.id}`}><Chip tone="ok">✓ On the mail server</Chip></span>
      : <Link to={`/tenants/${tenantId}/email`} data-testid={`limit-status-${row.id}`}><Chip tone="warn">Mail server differs: {off.map((d) => d.domain).join(', ')}</Chip></Link>;
  }
  return <span className="text-gray-400">—</span>;
}

function PlanCompare({ tenant, tenantId, plans, current, usage, currency }: {
  readonly tenant: Tenant;
  readonly tenantId: string;
  readonly plans: readonly Plan[];
  readonly current: Plan | undefined;
  readonly usage: Partial<Record<LimitId, number>>;
  readonly currency: string;
}) {
  const updateSub = useUpdateSubscription(tenantId);
  const [switching, setSwitching] = useState<Plan | null>(null);
  const [notify, setNotify] = useState(true);
  const shown = plans.filter((p) => p.status === 'active' || p.id === current?.id);
  if (shown.length === 0) return null;
  const rows: ReadonlyArray<{ readonly label: string; readonly id?: LimitId; readonly override: unknown; readonly value: (p: Plan) => string; readonly num?: (p: Plan) => number }> = [
    { label: 'Price', override: tenant.monthlyPriceOverride, value: (p) => formatCurrency(Number(p.monthlyPriceUsd), currency) },
    { label: 'CPU', override: tenant.cpuTierOverride ?? tenant.cpuBurstCoresOverride, value: (p) => `${p.cpuTier ?? 'high'} share, bursts to ${Number(p.cpuBurstCores)} cores` },
    { label: 'Memory', override: tenant.memoryLimitOverride, value: (p) => `${p.memoryLimit} GB` },
    { label: 'Storage', id: 'storage', override: tenant.storageLimitOverride, value: (p) => `${p.storageLimit} GB`, num: (p) => Number(p.storageLimit) },
    { label: 'Bandwidth', id: 'bandwidth', override: tenant.bandwidthLimitOverride, value: (p) => `${p.bandwidthGbLimit} GB / month`, num: (p) => p.bandwidthGbLimit },
    { label: 'Mailboxes', id: 'mailboxes', override: tenant.maxMailboxesOverride, value: (p) => String(p.maxMailboxes), num: (p) => p.maxMailboxes },
    { label: 'Sends per day', id: 'sendsDay', override: tenant.emailSendRateLimitDaily, value: (p) => String(p.emailDailySendLimit) },
    { label: 'Sub-users', id: 'subUsers', override: tenant.maxSubUsersOverride, value: (p) => String(p.maxSubUsers), num: (p) => p.maxSubUsers },
  ];
  return (
    <Card
      id="plans"
      title={(
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Compare plans for this tenant</h2>
          <p className="text-[13px] text-gray-600 dark:text-gray-400">Custom limits stay when the plan changes. Warnings use this tenant&rsquo;s current use.</p>
        </div>
      )}
      bodyClassName="overflow-x-auto"
      testId="plan-compare"
    >
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
            <th scope="col" className="px-5 py-2.5 font-medium">Limit</th>
            {shown.map((p) => (
              <th key={p.id} scope="col" className={clsx('px-5 py-2.5 font-medium', p.id === current?.id && 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300')}>
                {p.name}{p.id === current?.id ? ' · current' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-gray-100 dark:border-gray-700">
              <th scope="row" className="px-5 py-2.5 font-medium text-gray-700 dark:text-gray-300">{r.label}</th>
              {shown.map((p) => {
                const used = r.id ? usage[r.id] : undefined;
                const over = r.override == null && r.num && used !== undefined && used > r.num(p);
                return (
                  <td key={p.id} className={clsx('whitespace-nowrap px-5 py-2.5 text-gray-900 dark:text-gray-100', p.id === current?.id && 'bg-brand-50 dark:bg-brand-950')}>
                    {r.value(p)}
                    {r.override != null && <span className="ml-1.5 text-xs text-gray-500 dark:text-gray-400">(custom stays)</span>}
                    {over && <span className="ml-1.5"><Chip tone="warn">{used} in use</Chip></span>}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr>
            <th scope="row" className="px-5 py-3"><span className="sr-only">Switch</span></th>
            {shown.map((p) => (
              <td key={p.id} className={clsx('px-5 py-3', p.id === current?.id && 'bg-brand-50 dark:bg-brand-950')}>
                {p.id === current?.id
                  ? <span className="text-xs text-gray-500 dark:text-gray-400">Current plan</span>
                  : <button type="button" onClick={() => { setSwitching(p); setNotify(true); updateSub.reset(); }} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700" data-testid={`switch-plan-${p.code}`}>Switch to {p.name}…</button>}
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      {switching && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4" onClick={(e) => { if (e.target === e.currentTarget && !updateSub.isPending) setSwitching(null); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="switch-plan-title" className="w-full max-w-md rounded-xl bg-white shadow-xl dark:bg-gray-800" data-testid="switch-plan-dialog">
            <div className="border-b border-gray-200 px-5 py-3.5 dark:border-gray-700">
              <h2 id="switch-plan-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">Move {tenant.name} to {switching.name}?</h2>
            </div>
            <div className="space-y-3 p-5 text-sm text-gray-700 dark:text-gray-300">
              <p>Limits that follow the plan change with it. Its {rows.filter((r) => r.override != null).length} custom limits stay as they are.</p>
              <label className="flex items-start gap-2.5">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600" />
                <span>Email the tenant about this change</span>
              </label>
              {updateSub.error && <ErrorPanel error={extractOperatorError(updateSub.error)} severity="error" />}
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3 dark:border-gray-700">
              <button type="button" onClick={() => setSwitching(null)} disabled={updateSub.isPending} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await updateSub.mutateAsync({ plan_id: switching.id, notify_tenant: notify });
                    setSwitching(null);
                  } catch { /* shown above */ }
                }}
                disabled={updateSub.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                data-testid="switch-plan-confirm"
              >
                {updateSub.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                Move to {switching.name}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
