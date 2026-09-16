/**
 * The master notification switch.
 *
 * Exists because of 2026-09-16: a reconciler bug mailed five tenants every
 * five minutes for 45 minutes, and the only way to stop it was an operator
 * running `UPDATE notification_categories SET is_active = false` against the
 * production database — per category, during an incident, which requires
 * knowing which category is storming and having psql access at all.
 *
 * Disabling is deliberately two-click. It is not destructive, but it silences
 * every channel including security and backup alerts, and a switch that is
 * easy to flip by accident is a switch that gets left off.
 */
import { useState } from 'react';
import { BellOff, Bell, Loader2, ShieldAlert } from 'lucide-react';
import { useSystemSettings, useUpdateSystemSettings } from '@/hooks/use-system-settings';
import ErrorPanel from '@/components/ErrorPanel';
import type { OperatorError } from '@insula/api-contracts';

const TOGGLE_FAILED: OperatorError = {
  code: 'NOTIFICATION_SWITCH_UPDATE_FAILED',
  title: 'Could not change the notification switch',
  detail:
    'The platform settings update did not go through, so notifications are still in their previous state.',
  remediation: [
    'Retry — the update is idempotent.',
    'If it keeps failing, check that the management API can reach the platform database.',
  ],
  retryable: true,
};

export default function MasterSwitchCard() {
  const { data, isLoading } = useSystemSettings();
  const update = useUpdateSystemSettings();
  const [confirming, setConfirming] = useState(false);

  const enabled = data?.data.notificationsEnabled ?? true;

  const apply = (next: boolean): void => {
    setConfirming(false);
    update.mutate({ notificationsEnabled: next });
  };

  if (isLoading) {
    return (
      <div className="h-24 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800" />
    );
  }

  return (
    <div className="space-y-3">
      <div
        data-testid="notification-master-switch"
        className={
          enabled
            ? 'flex flex-wrap items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800'
            : 'flex flex-wrap items-center justify-between gap-4 rounded-lg border-2 border-red-400 bg-red-50 p-4 dark:border-red-600 dark:bg-red-900/30'
        }
      >
        <div className="flex items-start gap-3">
          {enabled ? (
            <Bell size={20} className="mt-0.5 shrink-0 text-green-600 dark:text-green-400" />
          ) : (
            <ShieldAlert size={20} className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
          )}
          <div className="space-y-1">
            <p
              className={
                enabled
                  ? 'text-sm font-semibold text-gray-900 dark:text-gray-100'
                  : 'text-sm font-semibold text-red-900 dark:text-red-200'
              }
            >
              {enabled
                ? 'Notifications are ON'
                : 'Notifications are OFF — nobody is being told anything'}
            </p>
            <p
              className={
                enabled
                  ? 'max-w-2xl text-sm text-gray-600 dark:text-gray-400'
                  : 'max-w-2xl text-sm text-red-800 dark:text-red-300'
              }
            >
              {enabled
                ? 'Every channel is live. Turn this off to stop all notification traffic immediately — the dispatcher checks it on every event, so it takes effect on the next one.'
                : 'Every channel is suppressed, including security, backup and certificate alerts. Tenants and operators are receiving nothing. Turn it back on as soon as the cause is contained.'}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {update.isPending && (
            <Loader2 size={16} className="animate-spin text-gray-500 dark:text-gray-400" />
          )}
          {enabled ? (
            confirming ? (
              <>
                <button
                  type="button"
                  data-testid="confirm-disable-notifications"
                  disabled={update.isPending}
                  onClick={() => apply(false)}
                  className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50 dark:bg-red-700 dark:hover:bg-red-600"
                >
                  Confirm — silence everything
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="disable-notifications"
                disabled={update.isPending}
                onClick={() => setConfirming(true)}
                className="inline-flex items-center gap-2 rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/40"
              >
                <BellOff size={16} />
                Stop all notifications
              </button>
            )
          ) : (
            <button
              type="button"
              data-testid="enable-notifications"
              disabled={update.isPending}
              onClick={() => apply(true)}
              className="inline-flex items-center gap-2 rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 disabled:opacity-50 dark:bg-green-700 dark:hover:bg-green-600"
            >
              <Bell size={16} />
              Resume notifications
            </button>
          )}
        </div>
      </div>

      {update.isError && (
        <ErrorPanel
          error={TOGGLE_FAILED}
          onRetry={() => apply(!enabled)}
          retryPending={update.isPending}
          testId="master-switch-error"
        />
      )}
    </div>
  );
}
