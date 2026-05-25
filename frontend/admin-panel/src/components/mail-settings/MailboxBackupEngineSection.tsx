import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, Save, CheckCircle, AlertTriangle, Info } from 'lucide-react';
import {
  useMailboxBackupSettings,
  useUpdateMailboxBackupSettings,
} from '@/hooks/use-mailbox-backup-settings';
import type { MailboxBackupEngineValue } from '@k8s-hosting/api-contracts';

const ENGINES: { value: MailboxBackupEngineValue; label: string; tagline: string }[] = [
  {
    value: 'imap',
    label: 'IMAP MULTIAPPEND',
    tagline:
      'Stalwart-native FETCH + parallel MULTIAPPEND with byte-budgeted batching. Recommended default — measured ~16% faster than JMAP on capture and ~35% faster on parallel restore (K=4), plus byte-exact preservation of UTF-8 folder names + IMAP keywords. IMAP4rev2 + CONDSTORE + LITERAL+ all supported.',
  },
  {
    value: 'jmap',
    label: 'JMAP (legacy)',
    tagline:
      'Original engine — JSON-over-HTTP with per-tenant Email/changes state. Kept for compatibility; known to corrupt UTF-8 folder names on restore (e.g. "Geschäftlich" → "Gesch_ftlich"). Use only if IMAP path is unavailable.',
  },
];

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

/**
 * Per-tenant mailbox-backup engine + worker cap selector.
 *
 * Reads from platform_settings.mailbox_backup_engine + .mailbox_backup_max_concurrent.
 * Backend route: GET/PATCH /admin/mailbox-backup-settings.
 *
 * Operator semantics:
 *  - Engine flip applies on the NEXT bundle the orchestrator dispatches —
 *    no Stalwart restart, no Job interruption mid-flight.
 *  - Worker cap [1, 64] applies cluster-wide. Default 4 keeps worst-case
 *    Stalwart RSS during simultaneous bulk-restore at ~400 MiB rather
 *    than 1.6 GiB at the per-user IMAP maxConcurrent of 16.
 */
export default function MailboxBackupEngineSection() {
  const query = useMailboxBackupSettings();
  const mutation = useUpdateMailboxBackupSettings();
  const settings = query.data?.data;

  const [engine, setEngine] = useState<MailboxBackupEngineValue>('imap');
  const [maxConcurrent, setMaxConcurrent] = useState<number>(4);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setEngine(settings.engine);
      setMaxConcurrent(settings.maxConcurrent);
    }
  }, [settings]);

  const dirty =
    settings != null &&
    (engine !== settings.engine || maxConcurrent !== settings.maxConcurrent);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    setError(null);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64) {
      setError('Max concurrent workers must be an integer between 1 and 64.');
      return;
    }
    // Send only the fields that actually changed — keeps lastUpdatedAt
    // honest (advances only on a real change) and matches the PATCH
    // schema's "at least one of engine|maxConcurrent" refine.
    const patch: { engine?: typeof engine; maxConcurrent?: number } = {};
    if (settings && engine !== settings.engine) patch.engine = engine;
    if (settings && maxConcurrent !== settings.maxConcurrent) patch.maxConcurrent = maxConcurrent;
    if (Object.keys(patch).length === 0) {
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
      return;
    }
    try {
      await mutation.mutateAsync(patch);
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading mailbox-backup settings…
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">
        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
        <span>Failed to load: {(query.error as Error).message}</span>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="flex items-start gap-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 p-3 text-sm text-blue-900 dark:text-blue-100">
        <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <p>
          Controls the engine used by <span className="font-mono">tenant-bundles</span> to capture and restore
          per-tenant mailbox contents. The change applies to the <strong>next</strong> bundle the orchestrator
          dispatches — running Jobs are not interrupted. Tenant bundles are always{' '}
          <strong>COMPLETE</strong> (no incremental).
        </p>
      </div>

      <fieldset className="space-y-3" data-testid="mailbox-backup-engine-fieldset">
        <legend className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Engine
        </legend>
        {ENGINES.map((opt) => (
          <label
            key={opt.value}
            className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
              engine === opt.value
                ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
            }`}
          >
            <input
              type="radio"
              name="mbx-backup-engine"
              value={opt.value}
              checked={engine === opt.value}
              onChange={() => setEngine(opt.value)}
              className="mt-1 h-4 w-4 text-brand-600 focus:ring-brand-500"
              data-testid={`mbx-backup-engine-${opt.value}`}
            />
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {opt.label}
                </span>
                {opt.value === 'imap' && (
                  <span className="rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-800 dark:text-green-200">
                    Recommended
                  </span>
                )}
                {settings?.engine === opt.value && (
                  <span className="rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                    Active
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-400">{opt.tagline}</p>
            </div>
          </label>
        ))}
      </fieldset>

      <div className="space-y-2">
        <label
          htmlFor="mbx-backup-max-concurrent"
          className="block text-sm font-semibold text-gray-900 dark:text-gray-100"
        >
          Max concurrent workers
        </label>
        <input
          id="mbx-backup-max-concurrent"
          type="number"
          min={1}
          max={64}
          value={maxConcurrent}
          // valueAsNumber returns NaN on empty/non-numeric — fall back
          // to the current persisted value (or 1) so the input never
          // silently drops to 0, which previously bypassed dirty-check.
          onChange={(e) => {
            const n = e.target.valueAsNumber;
            setMaxConcurrent(Number.isFinite(n) ? n : settings?.maxConcurrent ?? 1);
          }}
          className={`${INPUT_CLASS} max-w-[120px]`}
          data-testid="mbx-backup-max-concurrent"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Cluster-wide cap on simultaneous mailbox-capture + mailbox-restore Jobs.{' '}
          Default <strong>4</strong>. Caps Stalwart RSS during bulk-restore drills —
          worst-case ≈ <span className="font-mono">workers × 100 MiB</span> per active user.
        </p>
      </div>

      <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-700 pt-4">
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {settings?.lastUpdatedAt
            ? `Last updated ${new Date(settings.lastUpdatedAt).toLocaleString()}`
            : 'Using default values (no operator override yet)'}
        </div>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="flex items-center gap-1 text-sm text-green-700 dark:text-green-300">
              <CheckCircle className="h-4 w-4" />
              Saved
            </span>
          )}
          {error && (
            <span className="text-sm text-red-700 dark:text-red-300" data-testid="mbx-backup-engine-error">
              {error}
            </span>
          )}
          <button
            type="submit"
            disabled={!dirty || mutation.isPending}
            className="flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="mbx-backup-save"
          >
            {mutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save
          </button>
        </div>
      </div>
    </form>
  );
}
