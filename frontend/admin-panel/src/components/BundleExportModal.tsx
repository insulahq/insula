/**
 * Bundle export download dialog.
 *
 * Before this existed, "Download" was a button whose entire feedback was the
 * browser's own download indicator — which does not appear until the first byte
 * arrives. Two things could delay that first byte for minutes with nothing on
 * screen:
 *
 *   1. Traefik's buffering middleware spooled the whole response to disk before
 *      releasing a byte (fixed in the ingress reconciler's GET carve-out, but
 *      the UI should not depend on that staying fixed).
 *   2. A restic-backed component cannot start while the cluster-wide capture
 *      gate is full, so an export legitimately queues behind an unrelated
 *      tenant's backup.
 *
 * Neither was distinguishable from a hang. This dialog opens on click — before
 * any request — and names the step it is on.
 *
 * ★ The gate warning PAUSES rather than blocks. The preflight is advisory: the
 * export would still succeed, it would just wait. Refusing here would be wrong
 * twice over — the answer can go stale between check and click, and a capture
 * finishing one second later would have the UI denying an export that works. So
 * the operator is told what they are walking into and decides.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileText, Loader2, Lock, Mail, Database, X } from 'lucide-react';

import { apiFetch } from '@/lib/api-client';
import { downloadBundleExport } from '@/hooks/use-backup-bundles';

/** Mirrors `ExportPreflight` in backend/src/modules/tenant-bundles/export-preflight.ts. */
interface ExportPreflight {
  readonly bundleId: string;
  readonly bundleStatus: string;
  readonly components: ReadonlyArray<{
    readonly component: string;
    readonly artifactName: string;
    readonly sizeBytes: number;
    readonly source: 'restic' | 'object';
  }>;
  readonly totalBytes: number;
  readonly needsRestic: boolean;
  readonly capture: {
    readonly inFlight: number;
    readonly cap: number;
    readonly slotsFree: number;
    readonly thisBundleCapturing: boolean;
  };
  readonly blocked: boolean;
  readonly warnings: ReadonlyArray<string>;
}

type Phase = 'checking' | 'awaiting-confirm' | 'minting' | 'handoff' | 'started' | 'error';

const STEPS: ReadonlyArray<{ readonly key: Phase; readonly label: string }> = [
  { key: 'checking', label: 'Checking what this export contains' },
  { key: 'minting', label: 'Preparing a secure download link' },
  { key: 'handoff', label: 'Handing off to your browser' },
];

/** Order used to decide whether a step is done, active, or still ahead. */
const ORDER: ReadonlyArray<Phase> = ['checking', 'awaiting-confirm', 'minting', 'handoff', 'started'];

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function componentIcon(c: string) {
  if (c === 'files') return <FileText className="h-4 w-4" />;
  if (c === 'mailboxes') return <Mail className="h-4 w-4" />;
  if (c === 'secrets') return <Lock className="h-4 w-4" />;
  return <Database className="h-4 w-4" />;
}

export interface BundleExportModalProps {
  readonly bundleId: string;
  readonly format?: 'tar' | 'zip';
  readonly password?: string | null;
  readonly onClose: () => void;
}

export function BundleExportModal({ bundleId, format = 'tar', password = null, onClose }: BundleExportModalProps) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [pre, setPre] = useState<ExportPreflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards React 18 StrictMode's double-effect: without it the preflight fires
  // twice and, worse, the auto-advance mints two download tokens.
  const startedRef = useRef(false);

  const beginDownload = useCallback(async () => {
    setPhase('minting');
    try {
      // downloadBundleExport mints the token and clicks a hidden anchor. The
      // browser takes over from there — there is no completion event to await,
      // which is exactly why the old button felt like nothing happened.
      await downloadBundleExport(bundleId, format, password);
      setPhase('handoff');
      // Give the browser a beat to raise its own download UI before we claim
      // the handoff succeeded.
      window.setTimeout(() => setPhase('started'), 600);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [bundleId, format, password]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        const r = await apiFetch<{ data: ExportPreflight }>(
          `/api/v1/admin/tenant-bundles/${bundleId}/export-preflight`,
        );
        setPre(r.data);
        // Only a full capture gate is worth stopping for. Every other warning
        // (partial bundle, same-bundle capture) is shown alongside the running
        // download rather than in front of it.
        if (r.data.blocked) setPhase('awaiting-confirm');
        else await beginDownload();
      } catch (e) {
        // A preflight failure must NOT block the download — it is advisory.
        // Fall through and let the operator start it anyway.
        setError(e instanceof Error ? e.message : String(e));
        setPhase('awaiting-confirm');
      }
    })();
  }, [bundleId, beginDownload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const idx = ORDER.indexOf(phase);
  const stepState = (key: Phase): 'done' | 'active' | 'todo' => {
    if (phase === 'error') return ORDER.indexOf(key) < idx ? 'done' : 'todo';
    if (ORDER.indexOf(key) < idx) return 'done';
    if (key === phase) return 'active';
    return 'todo';
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bundle-export-title"
      data-testid="bundle-export-modal"
    >
      <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <header className="flex items-start justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div>
            <h2 id="bundle-export-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Preparing your download
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Large exports stream straight to disk — you can close this once the browser takes over.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="space-y-4 p-4">
          <ol className="space-y-2" data-testid="export-steps">
            {STEPS.map((s) => {
              const st = stepState(s.key);
              return (
                <li key={s.key} className="flex items-center gap-2 text-sm">
                  {st === 'done' && <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />}
                  {st === 'active' && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />}
                  {st === 'todo' && <span className="h-4 w-4 shrink-0 rounded-full border border-gray-300 dark:border-gray-600" />}
                  <span className={
                    st === 'todo'
                      ? 'text-gray-400 dark:text-gray-500'
                      : 'text-gray-800 dark:text-gray-200'
                  }>{s.label}</span>
                </li>
              );
            })}
          </ol>

          {pre && pre.components.length > 0 && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700" data-testid="export-contents">
              <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 dark:border-gray-700 dark:text-gray-300">
                <span>Contents</span>
                <span data-testid="export-total">{formatBytes(pre.totalBytes)}</span>
              </div>
              <ul className="max-h-48 divide-y divide-gray-100 overflow-y-auto dark:divide-gray-700">
                {pre.components.map((c) => (
                  <li key={`${c.component}/${c.artifactName}`} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <span className="text-gray-400 dark:text-gray-500">{componentIcon(c.component)}</span>
                    <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-300">{c.artifactName}</span>
                    <span className="shrink-0 tabular-nums text-xs text-gray-500 dark:text-gray-400">
                      {formatBytes(c.sizeBytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {pre?.warnings.map((w) => (
            <div
              key={w}
              data-testid="export-warning"
              className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{w}</span>
            </div>
          ))}

          {error && (
            <div
              data-testid="export-error"
              className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200"
            >
              {error}
            </div>
          )}

          {phase === 'started' && (
            <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="export-started">
              Your browser is downloading the archive. It is safe to close this dialog —
              the transfer continues in the background.
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-gray-200 p-4 dark:border-gray-700">
          {phase === 'awaiting-confirm' && (
            <button
              type="button"
              data-testid="export-start-anyway"
              onClick={() => { void beginDownload(); }}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Download className="h-4 w-4" />
              Download anyway
            </button>
          )}
          {phase === 'error' && (
            <button
              type="button"
              data-testid="export-retry"
              onClick={() => { setError(null); void beginDownload(); }}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            {phase === 'started' ? 'Close' : 'Cancel'}
          </button>
        </footer>
      </div>
    </div>
  );
}
