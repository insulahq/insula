import { AlertCircle, CheckCircle, Loader2, RefreshCw } from 'lucide-react';
import type { IntegrityFinding } from '@insula/api-contracts';
import {
  useTenantNamespaceIntegrity,
  useRepairTenantNamespace,
} from '@/hooks/use-namespace-integrity';

/**
 * Namespace health banner for the tenant detail page.
 *
 * Renders NOTHING when the namespace is consistent — it only appears when the
 * audit has something to say, so the detail page stays tight in the normal
 * case. Two kinds of finding land here:
 *
 *   missing objects        the reconciler recreates them from the plan, so the
 *                          banner offers "Run reconciler"
 *   wrong-sized objects    the tenant holds more than their subscription
 *                          allows (a volume created under a bigger plan and
 *                          never shrunk). The reconciler cannot help — the
 *                          object exists, it is just too big — so the button
 *                          is hidden and the banner shows the numbers instead.
 *
 * Extracted from TenantDetail.tsx 2026-09-03; that file was over 3300 lines.
 */
const FINDING_LABEL: Record<IntegrityFinding, string> = {
  namespace_missing: 'Namespace missing',
  pvc_missing: 'Tenant PVC missing',
  resource_quota_missing: 'ResourceQuota missing',
  network_policy_missing: 'NetworkPolicies missing',
  provisioned_exceeds_plan: 'Provisioned resources exceed the subscription',
  resource_quota_exceeded: 'Over quota — new resources are being rejected',
};

/**
 * Findings the reconciler cannot fix. Everything else is a missing object it
 * recreates from the plan; these two are objects that exist and are the wrong
 * size, so only the operator can resolve them (raise the plan, or shrink what
 * exists). The banner must not offer "Run reconciler" as the remedy.
 */
const UNREPAIRABLE_FINDINGS: ReadonlySet<IntegrityFinding> = new Set<IntegrityFinding>([
  'provisioned_exceeds_plan',
  'resource_quota_exceeded',
]);

function NamespaceIntegrityBanner({ tenantId }: { readonly tenantId: string }) {
  const { data, isLoading } = useTenantNamespaceIntegrity(tenantId);
  const repair = useRepairTenantNamespace(tenantId);
  const report = data?.data;

  if (isLoading || !report) return null;
  // Defensive — when the test harness or an in-flight rollout supplies a
  // partial payload, treat missing arrays as empty so the banner never
  // blows up the whole detail page.
  const stillBroken = report.findings ?? [];
  const justRepaired = repair.data?.data.repaired ?? [];
  const repairErrors = repair.data?.data.errors ?? [];
  // Rows where the subscription and the cluster disagree. `quota` may be
  // absent on an in-flight rollout where the API predates this field.
  const quotaRows = report.quota ?? [];
  const mismatchedRows = quotaRows.filter((q) => q.exceedsSubscription || q.enforcedDiffers || q.blocked);
  // Only offer "Run reconciler" when at least one finding is something it can
  // actually repair — otherwise the button is a dead end that reports success
  // while the tenant stays blocked.
  const hasRepairable = stillBroken.some((f) => !UNREPAIRABLE_FINDINGS.has(f));

  if (stillBroken.length === 0 && justRepaired.length === 0 && repairErrors.length === 0 && !repair.error) {
    // Healthy + nothing repaired this session — render nothing to keep the page tight.
    return null;
  }
  const tone = stillBroken.length > 0
    ? 'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-900/20'
    : 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-900/20';

  return (
    <div className={`rounded-xl border p-4 text-sm ${tone}`} data-testid="namespace-integrity-banner">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {stillBroken.length > 0 ? (
            <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
          ) : (
            <CheckCircle size={18} className="mt-0.5 shrink-0 text-green-600 dark:text-green-400" />
          )}
          <div>
            <div className="font-semibold text-gray-900 dark:text-gray-100">
              {stillBroken.length > 0 ? 'Namespace integrity issues detected' : 'Namespace integrity restored'}
            </div>
            {hasRepairable && (
              <p className="mt-0.5 text-xs text-red-800 dark:text-red-300">
                The reconciler will retry every 30 minutes. You can also run it now.
              </p>
            )}
            {stillBroken.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs">
                {stillBroken.map((f) => (
                  <li key={f} className="text-red-800 dark:text-red-300">• {FINDING_LABEL[f]}</li>
                ))}
              </ul>
            )}
            {mismatchedRows.length > 0 && (
              <div className="mt-3" data-testid="quota-mismatch-detail">
                <p className="text-xs text-red-800 dark:text-red-300">
                  What this tenant actually has does not match what their subscription allows.
                  Lowering a plan does not shrink anything the tenant already holds, so a volume
                  created under a bigger plan stays at its old size until someone resizes it.
                </p>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[26rem] max-w-xl text-left text-xs">
                    <thead>
                      <tr className="text-red-900/70 dark:text-red-300/70">
                        <th scope="col" className="pb-1 pr-4 font-medium">Resource</th>
                        <th scope="col" className="pb-1 pr-4 font-medium">Subscription</th>
                        <th scope="col" className="pb-1 pr-4 font-medium">Enforced quota</th>
                        <th scope="col" className="pb-1 font-medium">Provisioned</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-red-800 dark:text-red-300">
                      {/* Every row, not just the mismatched ones — the point is
                          to let the operator compare the three columns. */}
                      {quotaRows.map((q) => (
                        <tr key={q.resource} data-testid={`quota-row-${q.resource}`}>
                          <td className="pr-4 font-sans">{q.label}</td>
                          <td className="pr-4">{q.subscription}</td>
                          <td className={`pr-4 ${q.enforcedDiffers ? 'font-semibold' : 'opacity-70'}`}>
                            {q.enforced ?? '—'}
                          </td>
                          <td className={q.exceedsSubscription ? 'font-semibold' : 'opacity-70'}>
                            {q.provisioned ?? '—'}
                            {q.exceedsSubscription && (
                              <span className="ml-1.5 font-sans font-normal">over plan</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-red-800/80 dark:text-red-300/80">
                  <strong>Provisioned</strong> is the size the volume <em>requests</em>, not how
                  much has been written into it — which is why the tenant&apos;s own storage figure
                  can look comfortably inside the plan while this does not.
                  {mismatchedRows.some((q) => q.blocked) && (
                    <> Kubernetes is already refusing new resources in this namespace.</>
                  )}
                </p>
                <p className="mt-2 text-xs text-red-800 dark:text-red-300">
                  The reconciler cannot fix this — it recreates missing objects, and here the
                  object exists and is the wrong size. Either raise the limit under{' '}
                  <strong>Resource Limits</strong>, or shrink the volume there (a destructive
                  resize, which will ask you to confirm).
                </p>
              </div>
            )}
            {justRepaired.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs">
                {justRepaired.map((f) => (
                  <li key={`r-${f}`} className="text-green-800 dark:text-green-300">✓ Repaired: {FINDING_LABEL[f]}</li>
                ))}
              </ul>
            )}
            {repairErrors.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs">
                {repairErrors.map((e, i) => (
                  <li key={`e-${i}`} className="font-mono text-red-700 dark:text-red-400">{e}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {(hasRepairable || justRepaired.length > 0 || repairErrors.length > 0) && (
          <button
            type="button"
            onClick={() => repair.mutate()}
            disabled={repair.isPending}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            data-testid="namespace-integrity-repair-button"
          >
            {repair.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Run reconciler
          </button>
        )}
      </div>
    </div>
  );
}

export default NamespaceIntegrityBanner;
