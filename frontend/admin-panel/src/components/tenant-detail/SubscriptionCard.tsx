import { useState, type FormEvent } from 'react';
import { Edit, Loader2, CreditCard, Save } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import { useUpdateSubscription } from '@/hooks/use-subscription';
import { useSystemInfo } from '@/hooks/use-system-info';
import { usePlans } from '@/hooks/use-plans';
import { formatCurrency } from '@/lib/format-currency';

export function SubscriptionCard({
  tenantId,
  data,
  isLoading,
}: {
  readonly tenantId: string;
  readonly data: import('@/types/api').SubscriptionResponse | undefined;
  readonly isLoading: boolean;
}) {
  const updateSub = useUpdateSubscription(tenantId);
  const { data: plansData } = usePlans();
  const { data: sysInfo } = useSystemInfo();
  const currency = sysInfo?.currency ?? 'USD';
  const plans = plansData?.data ?? [];

  const [editing, setEditing] = useState(false);
  const [planId, setPlanId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  // Defaults to notifying: an operator changing someone's plan or renewal date
  // should normally say so. Reset on every open so a previous silent edit
  // cannot make the next one silent by accident.
  const [notifyTenant, setNotifyTenant] = useState(true);

  const startEditing = () => {
    setPlanId(data?.plan?.id ?? '');
    setExpiresAt(data?.subscription_expires_at?.slice(0, 10) ?? '');
    setNotifyTenant(true);
    setEditing(true);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await updateSub.mutateAsync({
        plan_id: planId || undefined,
        subscription_expires_at: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        notify_tenant: notifyTenant,
      });
      setEditing(false);
    } catch { /* error via updateSub.error */ }
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <Loader2 size={16} className="animate-spin text-gray-400" />
          <span className="text-sm text-gray-500 dark:text-gray-400">Loading subscription...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid="subscription-card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <CreditCard size={18} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Subscription</h2>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={startEditing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            data-testid="edit-subscription-button"
          >
            <Edit size={14} />
            Edit
          </button>
        )}
      </div>

      {!editing ? (
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Plan</dt>
            <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">{data?.plan?.name ?? 'No plan'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Status</dt>
            <dd className="mt-1">
              <StatusBadge status={(data?.status ?? 'active') as 'active' | 'pending' | 'suspended'} />
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Expires</dt>
            <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
              {data?.subscription_expires_at
                ? new Date(data.subscription_expires_at).toLocaleDateString()
                : 'Not set'}
            </dd>
          </div>
        </dl>
      ) : (
        <form onSubmit={handleSave} className="space-y-4" data-testid="subscription-edit-form">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="sub-plan" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Plan</label>
              <select
                id="sub-plan"
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100"
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                data-testid="sub-plan-select"
              >
                <option value="">No plan</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} — {formatCurrency(p.monthlyPriceUsd, currency)}/mo</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="sub-expires" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Expires</label>
              <input
                id="sub-expires"
                type="date"
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                data-testid="sub-expires-input"
              />
            </div>
          </div>
          <label className="flex items-start gap-2.5 rounded-lg bg-gray-50 p-3 dark:bg-gray-700/40">
            <input
              type="checkbox"
              checked={notifyTenant}
              onChange={(e) => setNotifyTenant(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800"
              data-testid="sub-notify-tenant"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Email the tenant about this change
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                Untick when the change does not concern them — correcting a
                mistyped date, or recording a renewal already agreed by phone.
              </span>
            </span>
          </label>
          {updateSub.error && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {updateSub.error instanceof Error ? updateSub.error.message : 'Failed to update subscription'}
            </p>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={updateSub.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="save-subscription-button"
            >
              {updateSub.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
