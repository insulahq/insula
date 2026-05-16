import { useEffect, useState, type FormEvent } from 'react';
import { Save, Loader2, CheckCircle, Server, AlertTriangle, RotateCcw } from 'lucide-react';
import { useWebmailSettings, useUpdateWebmailSettings } from '@/hooks/use-webmail-settings';
import { usePlatformUrls, useUpdatePlatformUrls } from '@/hooks/use-platform-urls';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

const FQDN_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/i;

/**
 * Mail-side platform settings — the SMTP/IMAP hostname Stalwart
 * advertises and the URL the admin panel uses to embed Stalwart's
 * upstream web-admin UI.
 *
 * Hostname changes go through Stalwart's JMAP `SystemSettings.defaultHostname`
 * first; only after Stalwart accepts does the platform_settings row
 * update. The Stalwart Web-Admin URL lives in platform_urls — moved
 * here from the System Settings → Integrations card so all
 * mail-related toggles are co-located.
 */
export default function MailSettingsTab() {
  const webmail = useWebmailSettings();
  const updateWebmail = useUpdateWebmailSettings();
  const urls = usePlatformUrls();
  const updateUrls = useUpdatePlatformUrls();

  const settings = webmail.data?.data;
  const stalwartUrl = urls.data?.stalwartAdminUrl;

  const [mailServerHostname, setMailServerHostname] = useState('');
  const [stalwartAdminUrl, setStalwartAdminUrl] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setMailServerHostname(settings.mailServerHostname ?? '');
  }, [settings]);

  useEffect(() => {
    if (stalwartUrl) setStalwartAdminUrl(stalwartUrl.source === 'db' ? stalwartUrl.value : '');
  }, [stalwartUrl]);

  const trimmedHostname = mailServerHostname.trim();
  const hostnameChanged =
    trimmedHostname.length > 0 && trimmedHostname !== (settings?.mailServerHostname ?? '');
  const hostnameLooksValid = !hostnameChanged || FQDN_RE.test(trimmedHostname);

  const stalwartUrlChanged =
    (stalwartUrl?.source === 'db' ? stalwartUrl.value : '') !== stalwartAdminUrl;

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    setSaveError(null);

    // Validate hostname before any network call so a typo doesn't get a
    // half-applied save (hostname rejected, but Stalwart URL committed).
    if (hostnameChanged && !hostnameLooksValid) {
      setSaveError('Mail server hostname must be a valid FQDN (e.g. mail.example.com).');
      return;
    }

    const tasks: Array<Promise<unknown>> = [];

    if (hostnameChanged) {
      tasks.push(
        updateWebmail.mutateAsync({ mailServerHostname: trimmedHostname }),
      );
    }
    if (stalwartUrlChanged) {
      tasks.push(
        updateUrls.mutateAsync({
          stalwartAdminUrl: stalwartAdminUrl.trim() === '' ? null : stalwartAdminUrl.trim(),
        }),
      );
    }

    if (tasks.length === 0) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      return;
    }

    try {
      await Promise.all(tasks);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save mail settings');
    }
  };

  const handleResetStalwart = async () => {
    setSaved(false);
    setSaveError(null);
    try {
      await updateUrls.mutateAsync({ stalwartAdminUrl: null });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Reset failed');
    }
  };

  if (webmail.isLoading || urls.isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading mail settings…
        </div>
      </div>
    );
  }

  if (webmail.isError) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 shadow-sm p-5 text-sm text-red-700 dark:text-red-300">
        Failed to load mail settings:{' '}
        {webmail.error instanceof Error ? webmail.error.message : 'unknown error'}
      </div>
    );
  }

  const saving = updateWebmail.isPending || updateUrls.isPending;

  return (
    <form
      onSubmit={handleSave}
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-5"
      data-testid="mail-settings-tab"
    >
      <div className="flex items-center gap-3">
        <Server size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Mail Settings</h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        The SMTP/IMAP hostname drives Stalwart&apos;s connection banners and
        outbound EHLO. The Stalwart Web-Admin URL is embedded in the
        &ldquo;Stalwart admin UI&rdquo; card below for direct access to the
        upstream admin.
      </p>

      <div>
        <label
          htmlFor="mail-hostname"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          SMTP/IMAP hostname
        </label>
        <input
          id="mail-hostname"
          type="text"
          inputMode="url"
          value={mailServerHostname}
          onChange={(e) => setMailServerHostname(e.target.value)}
          placeholder="mail.example.com"
          className={`mt-1 ${INPUT_CLASS} font-mono ${
            hostnameChanged && !hostnameLooksValid
              ? 'border-amber-400 dark:border-amber-500 focus:border-amber-500 focus:ring-amber-500'
              : ''
          }`}
          data-testid="mail-hostname-input"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={hostnameChanged && !hostnameLooksValid}
        />
        {hostnameChanged && !hostnameLooksValid ? (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            Must be a valid FQDN (e.g. mail.example.com).
          </p>
        ) : (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Pushes to Stalwart&apos;s <code>SystemSettings.defaultHostname</code>{' '}
            — drives banners + outbound EHLO. Cert SAN, DNS MX records, and
            reverse DNS still need operator-side coordination.
          </p>
        )}
      </div>

      <div>
        <div className="flex items-end justify-between gap-3">
          <label
            htmlFor="stalwart-admin-url"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Stalwart Web-Admin URL
          </label>
          <button
            type="button"
            onClick={handleResetStalwart}
            disabled={stalwartUrl?.source !== 'db' || saving}
            className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-brand-600 dark:hover:text-brand-400 disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="stalwart-admin-url-reset"
          >
            <RotateCcw size={11} /> Reset to default
          </button>
        </div>
        <input
          id="stalwart-admin-url"
          type="url"
          value={stalwartAdminUrl}
          onChange={(e) => setStalwartAdminUrl(e.target.value)}
          placeholder={stalwartUrl?.default || 'https://stalwart.example.com'}
          className={`mt-1 ${INPUT_CLASS}`}
          data-testid="stalwart-admin-url-input"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Embedded in the &ldquo;Stalwart admin UI&rdquo; card. Leave blank to
          use the apex-derived default.
          {stalwartUrl?.default && (
            <>
              {' '}
              <span className="text-gray-400">
                Default: <code className="font-mono">{stalwartUrl.default}</code>
              </span>
              {stalwartUrl.source === 'default' && (
                <span className="ml-1 inline-flex items-center rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-300">
                  using default
                </span>
              )}
            </>
          )}
        </p>
      </div>

      {hostnameChanged && (
        <div
          className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
          role="alert"
          data-testid="hostname-change-warning"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <strong>Hostname change requires manual follow-up.</strong> After
            saving: (1) add the new hostname to the Stalwart Domain&apos;s{' '}
            <code>subjectAlternativeNames</code> so the ACME loop re-issues a
            cert that covers it; (2) update the cluster&apos;s DNS MX + A
            records to point at the new name; (3) coordinate reverse DNS /
            FCrDNS at the IP-provider level so outbound mail isn&apos;t
            penalised.
          </span>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-600 disabled:opacity-50"
          data-testid="mail-settings-save"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving…' : 'Save'}
        </button>

        {saved && (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle size={14} /> Saved
          </span>
        )}

        {saveError && <span className="text-sm text-red-600 dark:text-red-400">{saveError}</span>}
      </div>
    </form>
  );
}
