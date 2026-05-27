import { useState } from 'react';
import { AlertTriangle, RotateCcw, X, Loader2, CheckCircle2, ChevronDown, ExternalLink, Info } from 'lucide-react';
import EmailPageHeader from '@/components/email/EmailPageHeader';
import MailSectionCard from '@/components/MailSectionCard';
import { useMailDrift, useDismissMailDrift, useRecreateMailDriftEmpty } from '@/hooks/use-mail-drift';
import type { MailDriftItem } from '@k8s-hosting/api-contracts';

/**
 * Email → Data Drift.
 *
 * Surfaces the platform_db / Stalwart drift items detected by the
 * principals-sync reconciler. Typical cause: a failed mail-stack
 * failover prior to the 2026-05-27 silent-loss fix. Two destructive
 * actions per item:
 *
 *   - "Restore from snapshot" — disabled until a whole-stack
 *     Stalwart snapshot-restore wizard ships. Preserves DKIM keys
 *     + mailbox messages but rolls Stalwart's entire datastore back
 *     to the snapshot moment.
 *   - "Recreate empty" — recreates the missing Stalwart entry empty.
 *     For domains this generates new DKIM keys (operator MUST
 *     republish at the tenant's registrar before outbound mail can
 *     pass DMARC). For mailboxes the new principal is empty (messages
 *     unrecoverable from Stalwart). Type-to-confirm guarded.
 */
export default function EmailDriftPage() {
  const { data, isLoading, error } = useMailDrift();
  const items = data?.data.items ?? [];
  const active = items.filter((i) => i.resolvedAt === null);
  const resolved = items.filter((i) => i.resolvedAt !== null);

  return (
    <div className="space-y-6">
      <EmailPageHeader subtitle="Platform DB ↔ Stalwart drift surface — operator remediation." />

      <MailSectionCard
        icon={AlertTriangle}
        title="Mail data drift"
        summary={`Active: ${active.length} • Resolved: ${resolved.length}`}
        dataTestId="mail-drift-section"
        storageKey="drift"
        defaultOpen
      >
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
          <Info size={14} className="mt-0.5 shrink-0" />
          <div>
            <strong>What this means.</strong> The principals-sync reconciler
            found platform DB rows whose Stalwart entries no longer exist
            — typically caused by a failed mail-stack failover before the
            2026-05-27 silent-loss fix. The fix itself prevents future
            occurrences (init container CrashLoopBackOffs instead of
            silently fresh-starting; the migration verifies restored
            content). This page exists to surface PRE-EXISTING drift and
            give you a controlled path to remediate.
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-gray-500">
            <Loader2 size={14} className="animate-spin" /> Loading drift list...
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
            Failed to load drift list: {(error as Error).message}
          </div>
        )}

        {!isLoading && !error && active.length === 0 && (
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2.5 text-sm text-emerald-800 dark:text-emerald-200 flex items-start gap-2">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            <span>No active drift detected. Platform DB and Stalwart are in sync.</span>
          </div>
        )}

        {active.length > 0 && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
            {active.map((item) => <DriftRow key={item.id} item={item} />)}
          </div>
        )}

        {resolved.length > 0 && <ResolvedHistory items={resolved} />}
      </MailSectionCard>
    </div>
  );
}

function DriftRow({ item }: { readonly item: MailDriftItem }) {
  const [showRecreate, setShowRecreate] = useState(false);
  const dismiss = useDismissMailDrift();

  const kindLabel = item.kind === 'domain' ? 'Stalwart Domain' : 'Stalwart mailbox';

  return (
    <div className="px-3 py-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-amber-600 dark:text-amber-400">
            <AlertTriangle size={12} /> {kindLabel} missing
          </div>
          <div className="mt-1 font-mono text-sm text-gray-900 dark:text-gray-100">
            {item.expectedName}
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Stale Stalwart id: <code className="font-mono">{item.expectedStalwartId ?? '—'}</code>
            {' • '}
            First seen: {new Date(item.firstDetectedAt).toLocaleString()}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled
            title="Stalwart snapshot-restore wizard is not built yet. To preserve DKIM + mailbox messages, restore Stalwart from a snapshot manually using scripts/mail-stack-consolidate.sh — see docs/02-operations/MAIL_STACK_CONSOLIDATION.md."
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-2.5 py-1 text-xs font-medium text-gray-400 cursor-not-allowed"
            data-testid={`drift-restore-snapshot-${item.id}`}
          >
            <RotateCcw size={12} /> Restore from snapshot
            <ExternalLink size={10} className="opacity-50" />
          </button>
          <button
            type="button"
            onClick={() => setShowRecreate(true)}
            className="inline-flex items-center gap-1 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-2.5 py-1 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40"
            data-testid={`drift-recreate-${item.id}`}
          >
            <AlertTriangle size={12} /> Recreate empty
          </button>
          <button
            type="button"
            onClick={() => dismiss.mutate(item.id)}
            disabled={dismiss.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            data-testid={`drift-dismiss-${item.id}`}
          >
            <X size={12} /> Dismiss
          </button>
        </div>
      </div>

      {showRecreate && (
        <RecreateEmptyModal item={item} onClose={() => setShowRecreate(false)} />
      )}
    </div>
  );
}

function RecreateEmptyModal({ item, onClose }: {
  readonly item: MailDriftItem;
  readonly onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<{ newStalwartId: string; followUp: string } | null>(null);
  const recreate = useRecreateMailDriftEmpty();

  const handleRun = async () => {
    try {
      const r = await recreate.mutateAsync({ id: item.id, confirmName: typed });
      setResult({ newStalwartId: r.data.newStalwartId, followUp: r.data.followUp });
    } catch {
      // surfaced via recreate.isError
    }
  };

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid={`drift-recreate-modal-${item.id}`}
    >
      <div
        className="w-full max-w-xl rounded-xl bg-white dark:bg-gray-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-6 py-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <AlertTriangle size={18} className="text-red-500" />
            Recreate {item.kind === 'domain' ? 'Stalwart Domain' : 'Stalwart mailbox'} empty
          </h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {!result && (
            <>
              <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-800 dark:text-red-200 flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div>
                  <strong>This is destructive and irreversible.</strong>
                  {item.kind === 'domain' ? (
                    <p className="mt-1 text-xs">
                      Stalwart will generate NEW DKIM keys for this Domain. The
                      tenant&apos;s DNS at their registrar still lists the OLD DKIM
                      records, so any mail signed by the new keys WILL fail DMARC
                      at receivers. You MUST republish the new DKIM TXT records
                      (visible after recreation in Admin UI → Email → Domain → DKIM
                      tab) before the tenant can rely on outbound mail.
                    </p>
                  ) : (
                    <p className="mt-1 text-xs">
                      A new EMPTY mailbox principal will be created. All
                      previously-stored messages are PERMANENTLY UNRECOVERABLE
                      from Stalwart. If a tenant-bundle backup snapshot covers
                      this mailbox, you can ingest messages out-of-band via
                      Admin UI → Tenants → &lt;tenant&gt; → Backups → Restore.
                    </p>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Type <code className="font-mono px-1 rounded bg-gray-100 dark:bg-gray-700">{item.expectedName}</code> to confirm
                </label>
                <input
                  type="text"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500"
                  data-testid="drift-recreate-confirm-input"
                  autoFocus
                />
              </div>

              {recreate.isError && (
                <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
                  Recreate failed: {(recreate.error as Error).message}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleRun}
                  disabled={typed !== item.expectedName || recreate.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="drift-recreate-run"
                >
                  {recreate.isPending ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
                  {recreate.isPending ? 'Recreating…' : 'Recreate empty'}
                </button>
              </div>
            </>
          )}

          {result && (
            <div className="space-y-3">
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2.5 text-sm text-emerald-800 dark:text-emerald-200 flex items-start gap-2">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                <div>
                  <strong>Recreated.</strong> New Stalwart id: <code className="font-mono">{result.newStalwartId}</code>
                </div>
              </div>
              <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200 whitespace-pre-wrap">
                {result.followUp}
              </div>
              <div className="flex items-center justify-end pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResolvedHistory({ items }: { readonly items: ReadonlyArray<MailDriftItem> }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="rounded-lg border border-gray-200 dark:border-gray-700">
      <summary
        className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-400 list-none flex items-center gap-1.5"
        onClick={() => setOpen(!open)}
      >
        <ChevronDown size={12} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
        Resolved history ({items.length})
      </summary>
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {items.map((i) => (
          <div key={i.id} className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
            <span className="font-mono">{i.expectedName}</span>
            {' — '}
            <span className="uppercase tracking-wider">{i.resolvedVia}</span>
            {' at '}
            {i.resolvedAt ? new Date(i.resolvedAt).toLocaleString() : '—'}
          </div>
        ))}
      </div>
    </details>
  );
}
