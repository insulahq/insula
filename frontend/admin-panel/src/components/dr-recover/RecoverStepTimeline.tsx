/**
 * The phases of a tenant recovery as a checklist — what has run, what is
 * running (with its clock), what was not needed, and where it stopped.
 */

import { CheckCircle2, Circle, Loader2, MinusCircle, XCircle } from 'lucide-react';
import type { DrRecoverStep, DrRecoverStepState } from '@insula/api-contracts';

/** "850ms" / "12s" / "3m 05s" / "1h 02m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

function StepIcon({ state }: { readonly state: DrRecoverStepState }) {
  if (state === 'done') return <CheckCircle2 size={16} className="text-green-600 dark:text-green-400" aria-hidden />;
  if (state === 'failed') return <XCircle size={16} className="text-red-600 dark:text-red-400" aria-hidden />;
  if (state === 'running') return <Loader2 size={16} className="animate-spin text-brand-600 dark:text-brand-400" aria-hidden />;
  if (state === 'skipped') return <MinusCircle size={16} className="text-gray-300 dark:text-gray-600" aria-hidden />;
  return <Circle size={16} className="text-gray-300 dark:text-gray-600" aria-hidden />;
}

const LABEL_CLASS: Record<DrRecoverStepState, string> = {
  pending: 'text-gray-400 dark:text-gray-500',
  running: 'font-medium text-brand-700 dark:text-brand-300',
  done: 'text-gray-900 dark:text-gray-100',
  failed: 'font-medium text-red-700 dark:text-red-300',
  skipped: 'text-gray-400 dark:text-gray-500',
};

function elapsed(step: DrRecoverStep, now: number): string | null {
  if (!step.startedAt) return null;
  const start = Date.parse(step.startedAt);
  if (Number.isNaN(start)) return null;
  if (step.state === 'running') return formatDuration(now - start);
  if (!step.finishedAt) return null;
  const end = Date.parse(step.finishedAt);
  return Number.isNaN(end) ? null : formatDuration(end - start);
}

export default function RecoverStepTimeline({ steps, now }: { readonly steps: readonly DrRecoverStep[]; readonly now: number }) {
  return (
    <ol className="space-y-1" data-testid="dr-recover-steps">
      {steps.map((step) => {
        const clock = elapsed(step, now);
        return (
          <li
            key={step.key}
            className="flex items-start gap-2 rounded-md px-2 py-1 text-sm"
            data-testid={`dr-recover-step-${step.key}`}
            data-state={step.state}
          >
            <span className="mt-0.5 flex-shrink-0"><StepIcon state={step.state} /></span>
            <span className="min-w-0 flex-1">
              <span className={LABEL_CLASS[step.state]}>{step.label}</span>
              {step.note && (
                <span className="block text-xs text-gray-500 dark:text-gray-400">{step.note}</span>
              )}
            </span>
            {clock && (
              <span className="flex-shrink-0 font-mono text-xs tabular-nums text-gray-500 dark:text-gray-400">{clock}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
