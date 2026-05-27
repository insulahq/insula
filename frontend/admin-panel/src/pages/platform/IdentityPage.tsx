import { useState, useEffect } from 'react';
import { Loader2, Save, CheckCircle, AlertCircle } from 'lucide-react';
import { useSystemSettings, useUpdateSystemSettings } from '@/hooks/use-system-settings';
import { useUrlHealth } from '@/hooks/use-url-health';
import UrlStatusBadges from '@/components/UrlStatusBadges';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

/**
 * Platform Identity — name, panel URLs, support contacts.
 *
 * Sends a partial PATCH covering only its own fields. Backend supports
 * partial updates (api-contracts updateSystemSettingsSchema makes every
 * field .optional()), so a Save here doesn't touch Networking or Limits.
 */
export default function IdentityPage() {
  const { data: response, isLoading, isError, error } = useSystemSettings();
  const updateSettings = useUpdateSystemSettings();
  const { data: health } = useUrlHealth();
  const settings = response?.data;

  const [platformName, setPlatformName] = useState('Hosting Platform');
  const [adminPanelUrl, setAdminPanelUrl] = useState('');
  const [tenantPanelUrl, setTenantPanelUrl] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [supportUrl, setSupportUrl] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setPlatformName(settings.platformName);
      setAdminPanelUrl(settings.adminPanelUrl ?? '');
      setTenantPanelUrl(settings.tenantPanelUrl ?? '');
      setSupportEmail(settings.supportEmail ?? '');
      setSupportUrl(settings.supportUrl ?? '');
    }
  }, [settings]);

  const handleSave = () => {
    setSaved(false);
    setSaveError(null);
    updateSettings.mutate(
      {
        platformName,
        adminPanelUrl: adminPanelUrl || null,
        tenantPanelUrl: tenantPanelUrl || null,
        supportEmail: supportEmail || null,
        supportUrl: supportUrl || null,
      },
      {
        onSuccess: () => {
          setSaved(true);
          setTimeout(() => setSaved(false), 3000);
        },
        onError: (err) => {
          setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8">
        <Loader2 size={20} className="animate-spin text-brand-500" />
        <span className="text-sm text-gray-500 dark:text-gray-400">Loading…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400">
        <AlertCircle size={16} />
        <span>Failed to load identity settings: {error?.message ?? 'Unknown error'}</span>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="space-y-6" data-testid="platform-identity-page">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Identity</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">Platform name, panel URLs, support contacts</p>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Platform Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={platformName}
              onChange={(e) => setPlatformName(e.target.value)}
              className={INPUT_CLASS}
              placeholder="Hosting Platform"
              required
              data-testid="platform-name-input"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Admin Panel URL</label>
                <UrlStatusBadges panel="admin" health={health?.admin} />
              </div>
              <input
                type="url"
                value={adminPanelUrl}
                onChange={(e) => setAdminPanelUrl(e.target.value)}
                className={INPUT_CLASS}
                placeholder="https://admin.example.com"
                data-testid="admin-panel-url-input"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Hostname is applied to the platform Ingress on save. cert-manager issues a TLS cert automatically.
              </p>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Tenant Panel URL</label>
                <UrlStatusBadges panel="tenant" health={health?.tenant} />
              </div>
              <input
                type="url"
                value={tenantPanelUrl}
                onChange={(e) => setTenantPanelUrl(e.target.value)}
                className={INPUT_CLASS}
                placeholder="https://my.example.com"
                data-testid="tenant-panel-url-input"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Same routing semantics as Admin Panel URL.</p>
            </div>
          </div>

          <div
            className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
            data-testid="panel-url-dns-note"
          >
            <span className="leading-5">
              <strong>Before saving in production:</strong> point the hostname&apos;s DNS record at the cluster&apos;s load balancer IP first. With Let&apos;s Encrypt (HTTP-01), cert-manager can&apos;t issue a cert until the hostname resolves — HTTPS will serve a stale cert for 30-60s until DNS propagates. Hostnames must be FQDNs; IP literals and <code className="font-mono">localhost</code> are rejected at save.
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Support Email</label>
              <input
                type="email"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                className={INPUT_CLASS}
                placeholder="support@example.com"
                data-testid="support-email-input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Support URL</label>
              <input
                type="url"
                value={supportUrl}
                onChange={(e) => setSupportUrl(e.target.value)}
                className={INPUT_CLASS}
                placeholder="https://docs.example.com"
                data-testid="support-url-input"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {saved && (
          <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
            <CheckCircle size={14} /> Settings saved
          </span>
        )}
        {saveError && (
          <span className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
            <AlertCircle size={14} /> {saveError}
          </span>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={updateSettings.isPending || !platformName.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="save-identity"
        >
          {updateSettings.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save
        </button>
      </div>
    </div>
  );
}
