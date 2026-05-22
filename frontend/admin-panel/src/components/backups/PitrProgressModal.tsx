/**
 * PitrProgressModal — Phase 4b (2026-05-22) live progress view for the
 * CNPG snapshot PITR flow. Renders a step-by-step timeline + a running
 * clock for the currently-in-flight long step.
 *
 * Data source: GET /admin/postgres-restore/status (polled every 5s by
 * useRestoreStatus). The orchestrator persists `progressSteps[]` and
 * `progressInFlight` to the DB-backed lock after every step, so the
 * modal's view tracks reality even if platform-api restarts mid-run.
 *
 * Modal lifecycle:
 *   1. Mount when SystemSnapshotsModal's PITR onSubmit succeeds.
 *   2. Polls status, renders timeline.
 *   3. When `inProgress=false`, surface terminal success/failure banner
 *      + show a "Close" button (does NOT auto-close so the operator
 *      can read the final timing).
 *
 * Distinct from BarmanRestoreWizard's InFlight view because:
 *   - PITR reads PersistedLock progress fields (orchestrator-emitted).
 *   - Barman-restore reads CNPG cluster.status.conditions.
 */

import { useEffect, useMemo, useState } from 'react';
import { X, CheckCircle2, Circle, XCircle, Loader2, AlertTriangle, Clock } from 'lucide-react';
import { useRestoreStatus } from '@/hooks/use-postgres-restore';
import type { PitrStep } from '@k8s-hosting/api-contracts';

interface Props {
  readonly jobName: string;
  readonly onClose: () => void;
}

/**
 * Step display names + estimated durations (used for the running-clock
 * label "Step <name> running for Xs of ~Ys"). Empty entry = unknown step
 * (the orchestrator emits these dynamically when retried), shown with
 * just a spinner.
 */
const STEP_LABELS: Record<string, { label: string; estSec?: number }> = {
  'preflight-wal-coverage': { label: 'WAL coverage probe', estSec: 5 },
  preflight: { label: 'Pre-flight validation', estSec: 5 },
  'wrap-volume-snapshot': { label: 'Wrap volume snapshot', estSec: 3 },
  'create-temp-cluster': { label: 'Create temp cluster CR', estSec: 3 },
  'temp-healthy': { label: 'Wait for temp cluster healthy', estSec: 170 },
  'temp-probe': { label: 'Probe temp DB connectivity', estSec: 2 },
  'quiesce-consumers': { label: 'Scale down downstream consumers', estSec: 2 },
  'suspend-flux': { label: 'Suspend Flux Kustomization', estSec: 1 },
  'snapshot-temp-primary': { label: 'Freeze temp cluster snapshot', estSec: 5 },
  'delete-source': { label: 'Delete source cluster CR', estSec: 60 },
  'recreate-source': { label: 'Recreate source (primary only)', estSec: 180 },
  'scale-up-to-source-ha': { label: 'Scale up to source HA', estSec: 1 },
  'normalize-bootstrap': { label: 'Normalize spec.bootstrap', estSec: 1 },
  'restore-consumers': { label: 'Restore downstream consumers', estSec: 1 },
  cleanup: { label: 'Cleanup temp resources', estSec: 5 },
  'resume-flux': { label: 'Resume Flux Kustomization', estSec: 1 },
  'orchestration-failed': { label: 'Orchestration FAILED', estSec: 1 },
  'auto-recovery': { label: 'Auto-recovery from failure', estSec: 30 },
};

const ORDER: ReadonlyArray<string> = [
  'preflight-wal-coverage', 'preflight', 'wrap-volume-snapshot', 'create-temp-cluster',
  'temp-healthy', 'temp-probe', 'quiesce-consumers', 'suspend-flux',
  'snapshot-temp-primary', 'delete-source', 'recreate-source', 'scale-up-to-source-ha',
  'normalize-bootstrap', 'restore-consumers', 'cleanup', 'resume-flux',
];

function fmtElapsed(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function fmtElapsedFromIso(iso: string, now: number): string {
  const elapsed = Math.max(0, now - new Date(iso).getTime());
  return fmtElapsed(elapsed);
}

export default function PitrProgressModal({ jobName, onClose }: Props) {
  // Use a clock tick so the running step's elapsed time updates every second.
  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const statusQ = useRestoreStatus({ enabled: true });
  const s = statusQ.data?.data;
  const progressSteps = (s?.progressSteps ?? []) as ReadonlyArray<PitrStep>;
  const inFlight = s?.progressInFlight;
  const phase = s?.phase;

  // Render order: union of expected order + any custom-emitted steps,
  // so the timeline carries through any unexpected orchestrator output.
  const rows = useMemo<ReadonlyArray<{ name: string; record: PitrStep | null }>>(() => {
    const seen = new Set<string>();
    const out: Array<{ name: string; record: PitrStep | null }> = [];
    for (const expected of ORDER) {
      const found = progressSteps.find((p) => p.step === expected);
      seen.add(expected);
      out.push({ name: expected, record: found ?? null });
    }
    // Any unexpected step the orchestrator emitted (auto-recovery, orchestration-failed)
    for (const p of progressSteps) {
      if (!seen.has(p.step)) {
        out.push({ name: p.step, record: p });
        seen.add(p.step);
      }
    }
    return out;
  }, [progressSteps]);

  const isDone = s !== undefined && s.inProgress === false;
  const lastStep = progressSteps[progressSteps.length - 1];
  const failed = lastStep?.ok === false || progressSteps.some((p) => p.step === 'orchestration-failed');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pitr-progress-title"
      data-testid="pitr-progress-modal"
    >
      <div className="w-full max-w-2xl rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <header className="flex items-start justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-700">
          <div>
            <h2 id="pitr-progress-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Postgres PITR — live progress
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              <span className="font-mono">{jobName}</span>
              {phase && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] uppercase dark:bg-gray-700">phase: {phase}</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={16} />
          </button>
        </header>

        <div className="p-4 text-sm">
          {isDone && failed && (
            <div role="alert" className="mb-3 flex items-start gap-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>
                <strong>Restore FAILED.</strong> Source PVCs retain reclaim — operator can recover via the auto-recovery
                runbook (see <code className="font-mono">scripts/reset-mail-pg.sh --restore-from-backup</code> or
                inspect the Job pod logs: <code className="font-mono">kubectl -n platform logs job/{jobName}</code>).
              </span>
            </div>
          )}
          {isDone && !failed && (() => {
            const scaleStep = progressSteps.find((p) => p.step === 'scale-up-to-source-ha');
            const scaleSucceeded = scaleStep?.ok === true;
            const scaleFailed = scaleStep?.ok === false;
            return (
              <div role="status" className={scaleFailed
                ? 'mb-3 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200'
                : 'mb-3 flex items-start gap-2 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'}
              >
                {scaleFailed
                  ? <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  : <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />}
                <span>
                  <strong>Restore complete.</strong> Primary is up.
                  {scaleSucceeded && (
                    <> Replicas continue building in the background; the cluster reaches full HA over the next few minutes.</>
                  )}
                  {scaleFailed && (
                    <> <strong>BUT scale-up to source HA FAILED</strong> — cluster is at instances=1 (NOT HA). Scroll the timeline to see the failure detail and run the manual scale-up kubectl command surfaced there.</>
                  )}
                </span>
              </div>
            );
          })()}

          <ol className="space-y-1" data-testid="pitr-step-timeline">
            {rows.map(({ name, record }) => {
              const meta = STEP_LABELS[name] ?? { label: name };
              const isInFlight = inFlight?.step === name && !record;
              const ok = record?.ok === true;
              const errored = record?.ok === false;
              return (
                <li
                  key={name}
                  className="flex items-start gap-2 rounded px-2 py-1 text-xs"
                  data-testid={`pitr-step-${name}`}
                >
                  <span className="mt-0.5 flex-shrink-0">
                    {ok && <CheckCircle2 size={12} className="text-emerald-600 dark:text-emerald-400" />}
                    {errored && <XCircle size={12} className="text-rose-600 dark:text-rose-400" />}
                    {isInFlight && <Loader2 size={12} className="animate-spin text-brand-600 dark:text-brand-400" />}
                    {!ok && !errored && !isInFlight && <Circle size={12} className="text-gray-300 dark:text-gray-600" />}
                  </span>
                  <span className="flex-1">
                    <span className={ok ? 'text-gray-900 dark:text-gray-100' : errored ? 'text-rose-700 dark:text-rose-300' : isInFlight ? 'text-brand-700 dark:text-brand-300 font-medium' : 'text-gray-400 dark:text-gray-500'}>
                      {meta.label}
                    </span>
                    {record?.detail && (
                      <span className="ml-2 font-mono text-[10px] text-gray-500 dark:text-gray-400">{record.detail}</span>
                    )}
                  </span>
                  <span className="flex-shrink-0 font-mono text-[10px] text-gray-500 dark:text-gray-400">
                    {record && fmtElapsed(record.elapsedMs)}
                    {isInFlight && inFlight && (
                      <>
                        <Clock size={9} className="-mt-0.5 mr-0.5 inline" />
                        {fmtElapsedFromIso(inFlight.startedAt, now)}
                        {meta.estSec && <span className="text-gray-400"> / ~{meta.estSec}s</span>}
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-gray-200 p-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            data-testid="pitr-progress-close"
          >
            {isDone ? 'Close' : 'Run in background'}
          </button>
        </footer>
      </div>
    </div>
  );
}
