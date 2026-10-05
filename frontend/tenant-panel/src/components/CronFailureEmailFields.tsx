import { Mail } from 'lucide-react';
import { failureEmailRecipientMissing } from '@insula/api-contracts';

/** The three failure-email settings as the form holds them. */
export interface CronFailureEmailValue {
  readonly notifyOnFailure: boolean;
  readonly notifyTenantEmail: boolean;
  /** Blank means "no extra address"; sent as null. */
  readonly notifyEmail: string;
}

export const DEFAULT_FAILURE_EMAIL: CronFailureEmailValue = {
  notifyOnFailure: false,
  notifyTenantEmail: true,
  notifyEmail: '',
};

/** Shared with the page so Save is disabled by the same rule the API applies. */
export function failureEmailIncomplete(value: CronFailureEmailValue): boolean {
  return failureEmailRecipientMissing(value);
}

/**
 * The fields as the API takes them. A blank extra address is null (none),
 * never '' — the contract rejects an empty string as a malformed address.
 */
export function failureEmailBody(value: CronFailureEmailValue) {
  return {
    notify_on_failure: value.notifyOnFailure,
    notify_tenant_email: value.notifyTenantEmail,
    notify_email: value.notifyEmail.trim() || null,
  };
}

interface CronFailureEmailFieldsProps {
  readonly value: CronFailureEmailValue;
  readonly onChange: (next: CronFailureEmailValue) => void;
  /**
   * The address "tenant email" resolves to. `undefined` while it loads,
   * `null` when the account has none on record.
   */
  readonly tenantEmail: string | null | undefined;
  readonly maxPerDay?: number;
}

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';
const CHECKBOX_CLASS = 'h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700';

/**
 * Opt-in email when a scheduled run fails. Off by default; the account's
 * admins see every failure in the panel regardless.
 */
export default function CronFailureEmailFields({ value, onChange, tenantEmail, maxPerDay }: CronFailureEmailFieldsProps) {
  const missing = failureEmailIncomplete(value);
  const tenantLabel = tenantEmail === undefined
    ? 'loading…'
    : tenantEmail ?? 'no tenant email on record';

  return (
    <fieldset
      className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
      data-testid="cron-failure-email"
    >
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className={CHECKBOX_CLASS + ' mt-0.5'}
          checked={value.notifyOnFailure}
          onChange={(e) => onChange({ ...value, notifyOnFailure: e.target.checked })}
          data-testid="cron-notify-toggle"
        />
        <span>
          <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
            <Mail size={14} className="text-gray-500 dark:text-gray-400" />
            Email when a scheduled run fails
          </span>
          <span className="mt-0.5 block text-[11px] text-gray-500 dark:text-gray-400">
            At most one email per task per day while it keeps failing
            {maxPerDay ? `, and at most ${maxPerDay} a day across all of this account’s tasks` : ''}.
            Run Now never emails. Account admins see every failure in the panel either way.
          </span>
        </span>
      </label>

      {value.notifyOnFailure && (
        <div className="mt-3 space-y-3 pl-6">
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              className={CHECKBOX_CLASS}
              checked={value.notifyTenantEmail}
              onChange={(e) => onChange({ ...value, notifyTenantEmail: e.target.checked })}
              data-testid="cron-notify-tenant-email"
            />
            <span>
              Tenant email{' '}
              <span className="font-mono text-xs text-gray-500 dark:text-gray-400" data-testid="cron-notify-tenant-email-address">
                ({tenantLabel})
              </span>
            </span>
          </label>
          <div>
            <label htmlFor="cj-notify-email" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              Additional address
            </label>
            <input
              id="cj-notify-email"
              type="email"
              maxLength={255}
              className={INPUT_CLASS + ' mt-1 sm:max-w-sm'}
              placeholder="ops@example.com"
              value={value.notifyEmail}
              onChange={(e) => onChange({ ...value, notifyEmail: e.target.value })}
              data-testid="cron-notify-email-input"
            />
            <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
              Optional. Someone outside the panel who should hear about it.
            </p>
          </div>
          {missing && (
            <p className="text-xs text-red-600 dark:text-red-400" data-testid="cron-notify-recipient-error">
              Choose at least one recipient — tick the tenant email or enter an address.
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}
