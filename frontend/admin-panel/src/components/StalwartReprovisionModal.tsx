import { useState } from 'react';
import { Loader2, CheckCircle, AlertTriangle, X, Wrench } from 'lucide-react';
import { useMailStalwartReprovision } from '@/hooks/use-mail-stalwart-reprovision';
import type { StalwartReprovisionResponse } from '@k8s-hosting/api-contracts';
import { ApiError } from '@/lib/api-client';

/**
 * Render a useful error string even when the underlying message is
 * empty. Common case: HTTP/2 strips res.statusText, so an ApiError
 * built from a non-2xx response without an error.message field ends
 * up with an empty Error.message — the modal would otherwise render
 * an invisible red banner. Falls back to the HTTP status + error
 * code so the operator at least gets something to grep server logs
 * for.
 */
function formatReprovisionError(err: unknown): string {
  if (err instanceof ApiError) {
    const parts: string[] = [];
    if (err.message && err.message.trim() !== '') parts.push(err.message);
    parts.push(`HTTP ${err.status}`);
    if (err.code && err.code !== 'UNKNOWN') parts.push(err.code);
    return parts.join(' — ');
  }
  if (err instanceof Error && err.message && err.message.trim() !== '') {
    return err.message;
  }
  return 'Re-provision failed — see platform-api logs (no error message returned)';
}

interface Props {
  readonly onClose: () => void;
}

/**
 * Stalwart re-provision confirmation + result modal.
 *
 * Explicitly walks the operator through:
 *   - what the button does (re-runs the 6-step Stalwart bring-up)
 *   - what it does NOT do (won't delete operator-customized objects,
 *     won't touch other domains, won't restart pods, won't trigger
 *     a DNS publish)
 *   - idempotency: safe to click multiple times; each step checks
 *     existence first and only acts when something is missing or drifted
 *   - when to use: after bootstrap dropped a step, after editing the
 *     mail hostname, after upstream Stalwart admin UI edits drifted
 *     the listener set
 */
export default function StalwartReprovisionModal({ onClose }: Props) {
  const mut = useMailStalwartReprovision();
  const [result, setResult] = useState<StalwartReprovisionResponse | null>(null);

  const handleRun = async () => {
    try {
      const r = await mut.mutateAsync();
      setResult(r.data);
    } catch {
      // surfaced via mut.isError
    }
  };

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid="stalwart-reprovision-modal"
    >
      <div
        className="w-full max-w-xl rounded-xl bg-white dark:bg-gray-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-6 py-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <Wrench size={18} className="text-amber-500" />
            Re-provision Stalwart
          </h3>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            data-testid="reprovision-modal-close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {!result && (
            <>
              <p className="text-sm text-gray-700 dark:text-gray-300">
                Re-runs the Stalwart bring-up sequence: ensures the platform
                domain entry, ACME provider, automatic certificate
                management, and the three required network listeners
                (<code className="font-mono">http-acme/80</code>,{' '}
                <code className="font-mono">submission/587</code>,{' '}
                <code className="font-mono">imap/143</code>) all exist
                inside Stalwart, then fires an ACME renewal task.
              </p>

              <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2.5 text-xs text-emerald-800 dark:text-emerald-200 flex items-start gap-2">
                <CheckCircle size={14} className="mt-0.5 shrink-0" />
                <div>
                  <strong>Safe to click multiple times.</strong> Each step
                  checks whether the underlying Stalwart object already
                  exists before creating it. A fully-configured Stalwart
                  yields a no-op result (4 read calls + one ACME-renewal
                  fire that Stalwart itself skips when the cert is fresh).
                  Operator-customized listeners or additional domains are
                  never touched.
                </div>
              </div>

              <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 space-y-1">
                <p>
                  <strong>When to use:</strong>
                </p>
                <ul className="space-y-0.5 ml-4 list-disc text-gray-600 dark:text-gray-400">
                  <li>Bootstrap dropped a step (cluster installed before this reconciler existed, or earlier bootstrap version)</li>
                  <li>After editing the mail hostname (Settings → Server) without seeing the cert flip from self-signed to Let&apos;s Encrypt</li>
                  <li>If the upstream Stalwart admin UI was used to delete a listener and you want it back</li>
                </ul>
              </div>

              <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2.5 text-xs text-gray-700 dark:text-gray-300 space-y-1">
                <p>
                  <strong>Does NOT:</strong>
                </p>
                <ul className="space-y-0.5 ml-4 list-disc text-gray-600 dark:text-gray-400">
                  <li>Restart the Stalwart pod or interrupt running connections</li>
                  <li>Publish or modify any DNS records (MX/SPF/DKIM/DMARC) — those are tenant-domain concerns handled separately</li>
                  <li>Delete any existing Stalwart domain, account, listener, or AcmeProvider</li>
                  <li>Touch other tenant domains — only ensures the platform&apos;s own mail-hostname apex is configured</li>
                </ul>
              </div>

              {mut.isError && (
                <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span data-testid="reprovision-error">{formatReprovisionError(mut.error)}</span>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                  data-testid="reprovision-cancel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleRun}
                  disabled={mut.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="reprovision-run"
                >
                  {mut.isPending ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Wrench size={14} />
                  )}
                  {mut.isPending ? 'Running…' : 'Re-provision now'}
                </button>
              </div>
            </>
          )}

          {result && <ReprovisionResultView result={result} onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}

function ReprovisionResultView({
  result,
  onClose,
}: {
  readonly result: StalwartReprovisionResponse;
  readonly onClose: () => void;
}) {
  const rows: Array<{ label: string; done: boolean; value: string }> = [
    {
      label: 'Domain',
      done: result.domainCreated,
      value: result.apex ?? '—',
    },
    {
      label: 'ACME provider',
      done: result.acmeProviderCreated,
      value: result.acmeProviderCreated ? 'Created Let’s Encrypt' : 'Already present',
    },
    {
      label: 'Cert management',
      done: result.certManagementUpdated,
      value: result.certManagementUpdated
        ? `Set Automatic with SAN ${result.sanKey ?? ''}`
        : 'Already set to Automatic',
    },
    {
      label: 'Network listeners',
      done: result.listenersCreated.length > 0,
      value:
        result.listenersCreated.length > 0
          ? `Created: ${result.listenersCreated.join(', ')}`
          : 'All present (http-acme, submission, imap)',
    },
    {
      label: 'ACME renewal task',
      done: result.acmeRenewalFired,
      value: result.acmeRenewalFired
        ? 'Fired (Stalwart will contact Let’s Encrypt if cert needs renewal)'
        : 'Suppressed (Stalwart task with same key in-flight or recent)',
    },
  ];

  return (
    <div className="space-y-3">
      <div
        className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${
          result.noOp
            ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-200'
            : 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200'
        }`}
      >
        <CheckCircle size={14} className="mt-0.5 shrink-0" />
        <div>
          {result.noOp ? (
            <span>
              <strong>No changes needed.</strong> Stalwart was already
              fully provisioned for{' '}
              <code className="font-mono">{result.apex ?? 'this mail hostname'}</code>.
              Mail health card will reflect any cert renewal within
              ~30 seconds.
            </span>
          ) : (
            <span>
              <strong>Re-provision complete.</strong> Stalwart now has
              the required objects. Wait ~30–60 seconds for the mail
              health card to re-probe; the certificate may take a few
              minutes more if Let&apos;s Encrypt is contacted.
            </span>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start gap-3 px-3 py-2">
            <span
              className={`mt-1 inline-flex h-2 w-2 shrink-0 rounded-full ${
                r.done ? 'bg-amber-500' : 'bg-emerald-500'
              }`}
              title={r.done ? 'Action taken' : 'Already correct'}
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {r.label}
              </div>
              <div className="text-sm text-gray-900 dark:text-gray-100">{r.value}</div>
            </div>
          </div>
        ))}
      </div>

      {result.notes.length > 0 && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2 text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
          <div className="font-medium text-gray-700 dark:text-gray-300">Notes</div>
          {result.notes.map((n, i) => (
            <div key={i}>• {n}</div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end pt-1">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600"
          data-testid="reprovision-close"
        >
          Close
        </button>
      </div>
    </div>
  );
}
