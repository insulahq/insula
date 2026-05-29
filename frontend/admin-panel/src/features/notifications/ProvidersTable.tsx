/**
 * Notification Providers table — Platform → Notifications → Providers.
 *
 * Operator-facing CRUD for the platform's notification transport
 * endpoints (today: SMTP-based providers — stalwart-internal, generic
 * SMTP, Postmark, Brevo, Mailjet, Mailgun EU). Distinct from the
 * tenant-side SMTP relay catalogue.
 *
 * Edit / Create in a right-drawer (same shape as the Sources editor).
 * Test-Send dialog opens inline per row.
 */

import { useMemo, useState } from 'react';
import { Loader2, Plus, RotateCw, Send, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import {
  useNotificationProviders,
  useCreateNotificationProvider,
  useUpdateNotificationProvider,
  useDeleteNotificationProvider,
  useTestNotificationProvider,
} from '@/hooks/use-notification-providers';
import {
  NOTIFICATION_PROVIDER_TYPE,
  NOTIFICATION_PROVIDER_DEFAULTS,
  type CreateNotificationProviderInput,
  type NotificationProviderResponse,
  type NotificationProviderType,
} from '@k8s-hosting/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

const TEST_STATUS_BADGE: Record<'success' | 'failed', string> = {
  success: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

const PROVIDER_TYPE_LABEL: Record<NotificationProviderType, string> = {
  'stalwart-internal': 'Stalwart (in-cluster)',
  'smtp': 'Generic SMTP',
  'postmark': 'Postmark',
  'brevo': 'Brevo',
  'mailjet': 'Mailjet',
  'mailgun-eu': 'Mailgun EU',
};

export default function ProvidersTable() {
  const list = useNotificationProviders();
  const [editing, setEditing] = useState<NotificationProviderResponse | 'new' | null>(null);
  const [testTarget, setTestTarget] = useState<NotificationProviderResponse | null>(null);
  const del = useDeleteNotificationProvider();

  const onDelete = async (p: NotificationProviderResponse): Promise<void> => {
    if (p.isDefault) return;
    try { await del.mutateAsync(p.id); } catch { /* surfaced */ }
  };

  const rows = list.data?.data ?? [];

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between">
        <p className="max-w-3xl text-sm text-gray-600 dark:text-gray-400">
          Configure the SMTP endpoints the notification dispatcher uses to send platform
          notifications. The default provider is used for every notification unless a more
          specific routing rule applies. Credentials are encrypted with
          <code className="mx-1 rounded bg-gray-100 px-1 text-[11px] dark:bg-gray-700">PLATFORM_ENCRYPTION_KEY</code>
          before storage.
        </p>
        <button
          type="button"
          onClick={() => setEditing('new')}
          data-testid="provider-create"
          className="inline-flex items-center gap-1 rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          <Plus size={14} /> Add provider
        </button>
      </header>

      {list.error && (
        <ErrorPanel
          error={extractOperatorError(list.error)}
          severity="error"
          testId="providers-list-error"
        />
      )}
      {del.error && (
        <ErrorPanel
          error={extractOperatorError(del.error)}
          severity="error"
          testId="providers-delete-error"
        />
      )}

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <table className="w-full text-xs">
          <thead className="text-gray-500 dark:text-gray-400">
            <tr className="border-b border-gray-200/60 dark:border-gray-700/40">
              <th className="px-4 py-2 text-left">Name</th>
              <th className="px-4 py-2 text-left">Type</th>
              <th className="px-4 py-2 text-left">From</th>
              <th className="px-4 py-2 text-left">SMTP</th>
              <th className="px-4 py-2 text-left">Default</th>
              <th className="px-4 py-2 text-left">Last Test</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                <Loader2 size={16} className="mx-auto animate-spin" />
              </td></tr>
            )}
            {!list.isLoading && rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-3 text-center text-gray-500">
                No providers configured yet. Click "Add provider" to set up your first SMTP endpoint.
              </td></tr>
            )}
            {rows.map((p) => (
              <tr
                key={p.id}
                className="border-t border-gray-200/60 dark:border-gray-700/40"
                data-testid={`provider-row-${p.id}`}
              >
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200">
                  <button type="button" onClick={() => setEditing(p)} className="text-blue-700 hover:underline dark:text-blue-300">
                    {p.name}
                  </button>
                  {!p.enabled && <span className="ml-2 rounded bg-gray-100 px-1 text-[10px] text-gray-500 dark:bg-gray-700">disabled</span>}
                </td>
                <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{PROVIDER_TYPE_LABEL[p.providerType]}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-gray-700 dark:text-gray-200">{p.fromAddress}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-gray-600 dark:text-gray-300">
                  {p.smtpHost}:{p.smtpPort}{p.smtpSecure && <span className="ml-1 text-green-700 dark:text-green-300">TLS</span>}
                </td>
                <td className="px-4 py-2">
                  {p.isDefault && <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">default</span>}
                </td>
                <td className="px-4 py-2">
                  {p.lastTestStatus && (
                    <span
                      className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium', TEST_STATUS_BADGE[p.lastTestStatus])}
                      title={p.lastTestError ?? undefined}
                    >
                      {p.lastTestStatus}
                    </span>
                  )}
                  {p.lastTestedAt && (
                    <span className="ml-1 text-[10px] text-gray-500">{new Date(p.lastTestedAt).toLocaleString()}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => setTestTarget(p)}
                    data-testid={`provider-test-${p.id}`}
                    title="Send a test message"
                    className="mr-1 inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-[10px] hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
                  >
                    <Send size={10} /> Test
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(p)}
                    disabled={p.isDefault || del.isPending}
                    data-testid={`provider-delete-${p.id}`}
                    title={p.isDefault ? 'Cannot delete the default provider' : 'Delete provider'}
                    className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-[10px] hover:bg-red-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-red-900/30"
                  >
                    <Trash2 size={10} /> Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {editing && (
        <ProviderEditDrawer
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {testTarget && (
        <ProviderTestDialog provider={testTarget} onClose={() => setTestTarget(null)} />
      )}
    </div>
  );
}

interface DrawerProps {
  readonly provider: NotificationProviderResponse | null;
  readonly onClose: () => void;
}

function ProviderEditDrawer({ provider, onClose }: DrawerProps) {
  const isNew = provider === null;
  const create = useCreateNotificationProvider();
  const update = useUpdateNotificationProvider();

  const initialType: NotificationProviderType = provider?.providerType ?? 'smtp';
  const defaults = NOTIFICATION_PROVIDER_DEFAULTS[initialType];

  const [providerType, setProviderType] = useState<NotificationProviderType>(initialType);
  const [name, setName] = useState(provider?.name ?? '');
  const [smtpHost, setSmtpHost] = useState(provider?.smtpHost ?? defaults.smtpHost);
  const [smtpPort, setSmtpPort] = useState(String(provider?.smtpPort ?? defaults.smtpPort));
  const [smtpSecure, setSmtpSecure] = useState(provider?.smtpSecure ?? defaults.smtpSecure);
  const [authUsername, setAuthUsername] = useState(provider?.authUsername ?? '');
  const [authPassword, setAuthPassword] = useState('');
  const [fromAddress, setFromAddress] = useState(provider?.fromAddress ?? '');
  const [fromName, setFromName] = useState(provider?.fromName ?? '');
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [isDefault, setIsDefault] = useState(provider?.isDefault ?? false);

  const onProviderTypeChange = (next: NotificationProviderType): void => {
    setProviderType(next);
    // When the operator picks a SaaS type, swap in its suggested SMTP
    // defaults — but only if the host field hasn't been customised.
    const nextDefaults = NOTIFICATION_PROVIDER_DEFAULTS[next];
    setSmtpHost((prev) => (prev === NOTIFICATION_PROVIDER_DEFAULTS[providerType].smtpHost ? nextDefaults.smtpHost : prev));
    setSmtpPort((prev) => (prev === String(NOTIFICATION_PROVIDER_DEFAULTS[providerType].smtpPort) ? String(nextDefaults.smtpPort) : prev));
    setSmtpSecure(nextDefaults.smtpSecure);
  };

  const onSave = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    try {
      if (isNew) {
        const input: CreateNotificationProviderInput = {
          name,
          providerType,
          smtpHost,
          smtpPort: Number.parseInt(smtpPort, 10),
          smtpSecure,
          authUsername: authUsername || null,
          authPassword: authPassword || undefined,
          fromAddress,
          fromName: fromName || null,
          enabled,
          isDefault,
        };
        await create.mutateAsync(input);
      } else {
        await update.mutateAsync({
          id: provider!.id,
          input: {
            name,
            smtpHost,
            smtpPort: Number.parseInt(smtpPort, 10),
            smtpSecure,
            authUsername: authUsername || null,
            authPassword: authPassword || undefined,
            fromAddress,
            fromName: fromName || null,
            enabled,
            isDefault,
          },
        });
      }
      onClose();
    } catch {
      // ErrorPanel below surfaces it.
    }
  };

  const mutationError = create.error ?? update.error;
  const isPending = create.isPending || update.isPending;

  return (
    <aside
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col gap-3 overflow-y-auto border-l border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-800"
      data-testid="provider-edit-drawer"
    >
      <div className="flex items-start justify-between">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {isNew ? 'Add provider' : `Edit provider — ${provider!.name}`}
        </h3>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={16} /></button>
      </div>
      <form onSubmit={onSave} className="space-y-3 text-sm">
        {isNew && (
          <label className="block">
            <span className="text-xs text-gray-600 dark:text-gray-300">Provider type</span>
            <select
              value={providerType}
              onChange={(e) => onProviderTypeChange(e.target.value as NotificationProviderType)}
              data-testid="provider-type"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            >
              {NOTIFICATION_PROVIDER_TYPE.map((t) => (
                <option key={t} value={t}>{PROVIDER_TYPE_LABEL[t]}</option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="text-xs text-gray-600 dark:text-gray-300">Name (operator-visible)</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="provider-name"
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <div className="grid grid-cols-3 gap-2">
          <label className="col-span-2 block">
            <span className="text-xs text-gray-600 dark:text-gray-300">SMTP host</span>
            <input
              required
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
              data-testid="provider-smtp-host"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-600 dark:text-gray-300">Port</span>
            <input
              required
              type="number"
              value={smtpPort}
              onChange={(e) => setSmtpPort(e.target.value)}
              data-testid="provider-smtp-port"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={smtpSecure}
            onChange={(e) => setSmtpSecure(e.target.checked)}
            data-testid="provider-smtp-secure"
          />
          <span className="text-xs text-gray-700 dark:text-gray-200">
            Implicit TLS (SMTPS — usually port 465)
          </span>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs text-gray-600 dark:text-gray-300">Auth username</span>
            <input
              value={authUsername}
              onChange={(e) => setAuthUsername(e.target.value)}
              data-testid="provider-auth-username"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-600 dark:text-gray-300">
              Auth password {!isNew && <span className="text-gray-400">(leave empty to keep)</span>}
            </span>
            <input
              type="password"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              data-testid="provider-auth-password"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs text-gray-600 dark:text-gray-300">From address</span>
            <input
              required
              type="email"
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              data-testid="provider-from-address"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-600 dark:text-gray-300">From name (optional)</span>
            <input
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              data-testid="provider-from-name"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="provider-enabled" />
            <span className="text-xs text-gray-700 dark:text-gray-200">Enabled</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} data-testid="provider-default" />
            <span className="text-xs text-gray-700 dark:text-gray-200">Default for email</span>
          </label>
        </div>
        {mutationError && (
          <ErrorPanel error={extractOperatorError(mutationError)} severity="error" testId="provider-save-error" />
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600">
            Cancel
          </button>
          <button
            type="submit"
            disabled={isPending}
            data-testid="provider-save"
            className="inline-flex items-center gap-1 rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {isPending && <Loader2 size={12} className="animate-spin" />}
            {isNew ? 'Create' : 'Save'}
          </button>
        </div>
      </form>
    </aside>
  );
}

interface TestDialogProps {
  readonly provider: NotificationProviderResponse;
  readonly onClose: () => void;
}

function ProviderTestDialog({ provider, onClose }: TestDialogProps) {
  const [recipient, setRecipient] = useState('');
  const test = useTestNotificationProvider();
  const result = useMemo(() => test.data?.data, [test.data]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    try { await test.mutateAsync({ id: provider.id, input: { recipientEmail: recipient } }); } catch { /* surfaced */ }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-3 rounded-lg bg-white p-5 shadow-xl dark:bg-gray-800"
        data-testid="provider-test-dialog"
      >
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Test provider — {provider.name}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Sends a brief test message via this provider to the address below. Use your own
          mailbox to verify credentials before relying on this provider for live notifications.
        </p>
        <label className="block">
          <span className="text-xs text-gray-600 dark:text-gray-300">Send test to</span>
          <input
            required
            type="email"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            data-testid="provider-test-recipient"
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            placeholder="ops@example.test"
          />
        </label>
        {result && (
          <div
            className={clsx(
              'rounded p-2 text-xs',
              result.status === 'success'
                ? 'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300',
            )}
            data-testid="provider-test-result"
          >
            {result.status === 'success'
              ? `Test sent successfully at ${new Date(result.testedAt).toLocaleString()}.`
              : `Test failed: ${result.error}`}
          </div>
        )}
        {test.error && (
          <ErrorPanel error={extractOperatorError(test.error)} severity="error" testId="provider-test-error" />
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600">
            Close
          </button>
          <button
            type="submit"
            disabled={test.isPending}
            data-testid="provider-test-submit"
            className="inline-flex items-center gap-1 rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {test.isPending ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
            Send test
          </button>
        </div>
      </form>
    </div>
  );
}
