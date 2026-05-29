import { useEffect, useMemo, useState } from 'react';
import { Bell, Lock, Loader2, Save, Clock } from 'lucide-react';
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
  useNotificationSettings,
  useUpdateNotificationSettings,
} from '@/hooks/use-notifications';
import {
  NOTIFICATION_CHANNEL_ID,
  NOTIFICATION_DIGEST_MODE,
  type NotificationChannelId,
  type NotificationDigestMode,
  type UpdateUserNotificationPreferencesInput,
} from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

interface PendingChange {
  readonly categoryId: string;
  readonly channel: NotificationChannelId;
  readonly enabled: boolean;
}

const CHANNEL_LABELS: Record<NotificationChannelId, string> = {
  in_app: 'In-app',
  email: 'Email',
};

const DIGEST_LABELS: Record<NotificationDigestMode, string> = {
  immediate: 'Immediate',
  hourly: 'Hourly digest',
  daily: 'Daily digest',
};

export default function NotificationPreferences() {
  const prefs = useNotificationPreferences();
  const settings = useNotificationSettings();
  const updatePrefs = useUpdateNotificationPreferences();
  const updateSettings = useUpdateNotificationSettings();

  const [pending, setPending] = useState<Map<string, PendingChange>>(new Map());

  const settingsForm = settings.data?.data;
  const [quietStart, setQuietStart] = useState<string>('');
  const [quietEnd, setQuietEnd] = useState<string>('');
  const [digestMode, setDigestMode] = useState<NotificationDigestMode>('immediate');
  const [timezone, setTimezone] = useState<string>('');

  // Populate form once when settings arrive. Depend on primitive fields
  // (not the parent object ref) so test-mock hooks that return a fresh
  // object every render don't ping-pong the user's input changes back
  // to defaults on every commit.
  useEffect(() => {
    if (!settingsForm) return;
    setQuietStart(settingsForm.quietHoursStart ?? '');
    setQuietEnd(settingsForm.quietHoursEnd ?? '');
    setDigestMode(settingsForm.digestMode);
    setTimezone(settingsForm.timezone ?? '');
  }, [
    settingsForm?.quietHoursStart,
    settingsForm?.quietHoursEnd,
    settingsForm?.digestMode,
    settingsForm?.timezone,
  ]);

  const byCategory = useMemo(() => {
    const m = new Map<string, { mandatory: boolean; channels: Map<NotificationChannelId, boolean> }>();
    for (const p of prefs.data?.data.preferences ?? []) {
      const existing = m.get(p.categoryId) ?? { mandatory: p.isMandatory, channels: new Map() };
      existing.channels.set(p.channel, p.enabled);
      m.set(p.categoryId, existing);
    }
    return m;
  }, [prefs.data]);

  const toggle = (categoryId: string, channel: NotificationChannelId, current: boolean): void => {
    const key = `${categoryId}::${channel}`;
    setPending((prev) => {
      const next = new Map(prev);
      next.set(key, { categoryId, channel, enabled: !current });
      return next;
    });
  };

  const effectiveValue = (categoryId: string, channel: NotificationChannelId): boolean => {
    const key = `${categoryId}::${channel}`;
    const pendingChange = pending.get(key);
    if (pendingChange) return pendingChange.enabled;
    return byCategory.get(categoryId)?.channels.get(channel) ?? true;
  };

  const onSavePreferences = async (): Promise<void> => {
    if (pending.size === 0) return;
    const updates: UpdateUserNotificationPreferencesInput['updates'] = Array.from(pending.values());
    try {
      await updatePrefs.mutateAsync({ updates });
      setPending(new Map());
    } catch {
      // Surfaced via ErrorPanel
    }
  };

  const onSaveSettings = async (): Promise<void> => {
    try {
      await updateSettings.mutateAsync({
        quietHoursStart: quietStart === '' ? null : quietStart,
        quietHoursEnd: quietEnd === '' ? null : quietEnd,
        digestMode,
        timezone: timezone === '' ? null : timezone,
      });
    } catch {
      // Surfaced via ErrorPanel
    }
  };

  if (prefs.isLoading || settings.isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 size={14} className="animate-spin" />
        Loading notification preferences…
      </div>
    );
  }

  const categoryIds = Array.from(byCategory.keys()).sort();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Bell size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="notification-prefs-heading">
          Notification Preferences
        </h1>
      </div>

      {prefs.error && (
        <ErrorPanel
          error={extractOperatorError(prefs.error)}
          severity="error"
          testId="notification-prefs-error"
        />
      )}
      {updatePrefs.error && (
        <ErrorPanel
          error={extractOperatorError(updatePrefs.error)}
          severity="error"
          testId="notification-prefs-save-error"
        />
      )}

      {/* ─── Per-category channel matrix ─────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Categories</h2>
          <button
            type="button"
            onClick={onSavePreferences}
            disabled={pending.size === 0 || updatePrefs.isPending}
            className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="save-preferences"
          >
            {updatePrefs.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save {pending.size > 0 ? `(${pending.size})` : ''}
          </button>
        </div>

        <table className="w-full text-sm">
          <thead className="text-gray-500 dark:text-gray-400">
            <tr className="border-b border-gray-200/60 dark:border-gray-700/40">
              <th className="text-left px-5 py-2">Category</th>
              {NOTIFICATION_CHANNEL_ID.map((c) => (
                <th key={c} className="text-center px-5 py-2">{CHANNEL_LABELS[c]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categoryIds.length === 0 && (
              <tr>
                <td colSpan={NOTIFICATION_CHANNEL_ID.length + 1} className="px-5 py-4 text-center text-gray-500">
                  No notification categories available.
                </td>
              </tr>
            )}
            {categoryIds.map((categoryId) => {
              const entry = byCategory.get(categoryId)!;
              return (
                <tr key={categoryId} className="border-t border-gray-200/60 dark:border-gray-700/40">
                  <td className="px-5 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">
                    <div className="flex items-center gap-2">
                      {entry.mandatory && (
                        <Lock size={12} className="text-amber-500" data-testid={`mandatory-${categoryId}`} />
                      )}
                      <span>{categoryId}</span>
                    </div>
                  </td>
                  {NOTIFICATION_CHANNEL_ID.map((channel) => {
                    const checked = effectiveValue(categoryId, channel);
                    const disabled = entry.mandatory;
                    return (
                      <td key={channel} className="px-5 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggle(categoryId, channel, checked)}
                          className="rounded"
                          aria-label={`${categoryId} via ${channel}`}
                          data-testid={`pref-${categoryId}-${channel}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="px-5 py-3 text-xs text-gray-500 dark:text-gray-400">
          <Lock size={10} className="inline" /> mandatory categories cannot be disabled (security or
          account-state events you must receive).
        </p>
      </section>

      {/* ─── Delivery settings ─────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <Clock size={18} /> Delivery Settings
        </h2>
        <form
          onSubmit={(e) => { e.preventDefault(); void onSaveSettings(); }}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        >
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Quiet hours start
            </label>
            <input
              type="time"
              value={quietStart}
              onChange={(e) => setQuietStart(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900"
              data-testid="quiet-start"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Quiet hours end
            </label>
            <input
              type="time"
              value={quietEnd}
              onChange={(e) => setQuietEnd(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900"
              data-testid="quiet-end"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Digest mode
            </label>
            <select
              value={digestMode}
              onChange={(e) => setDigestMode(e.target.value as NotificationDigestMode)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900"
              data-testid="digest-mode"
            >
              {NOTIFICATION_DIGEST_MODE.map((m) => (
                <option key={m} value={m}>{DIGEST_LABELS[m]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Timezone (IANA)
            </label>
            <input
              type="text"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="Europe/Berlin"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900"
              data-testid="timezone"
            />
          </div>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={updateSettings.isPending}
              className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="save-settings"
            >
              {updateSettings.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save settings
            </button>
          </div>
        </form>
        {updateSettings.error && (
          <div className="mt-4">
            <ErrorPanel
              error={extractOperatorError(updateSettings.error)}
              severity="error"
              testId="notification-settings-save-error"
            />
          </div>
        )}
      </section>

      <p className="px-1 text-xs text-gray-500 dark:text-gray-400">
        Quiet hours suppress non-critical notifications between the configured times. Critical
        notifications (account suspension, security alerts) always come through. Digest mode is
        coming soon — for now everything is delivered immediately regardless of selection.
      </p>
    </div>
  );
}
