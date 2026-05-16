import { useState, useMemo } from 'react';
import { X, Loader2, CheckCircle2, AlertTriangle, ChevronRight } from 'lucide-react';
import { useTaskCenter } from '@/hooks/use-task-center';
import type { TaskRow } from '@k8s-hosting/api-contracts';

/**
 * Generic mail-operation progress modal.
 *
 * Reads task state from `useTaskCenter()` (already polled every 3s while
 * any task is running) and filters by `taskId`. Operator triggers a
 * long-running mail op → response returns `taskId` → page calls
 * `setActiveTaskId(taskId)` which mounts this modal.
 *
 * The modal also opens when the operator clicks the task-center chip and
 * the task target is `{ type: 'modal', modal: 'mail-operation', modalProps: { taskId } }`.
 *
 * Rendering model:
 *   - `progressText` is the operator-readable current-step message
 *     (e.g. "Removing host ports from Stalwart Deployment").
 *   - `progressPct` is 0..100 if known.
 *   - `details.steps[]` (when present) is rendered as a checklist —
 *     each step has `{name, state}` where state ∈ pending|running|done|failed.
 *
 * Close behaviour: button is enabled the whole time. While the task is
 * running, closing dismisses the modal but the chip continues to track
 * the task in the background — clicking the chip re-opens this modal.
 */

interface Props {
  readonly taskId: string;
  readonly onClose: () => void;
}

/**
 * Per-step state we render in the checklist. Stored under
 * `task.details.steps` by the backend when it wants to surface a
 * fine-grained breakdown (port-exposure, snapshot, etc).
 */
interface ProgressStep {
  readonly name: string;
  readonly state: 'pending' | 'running' | 'done' | 'failed';
  readonly note?: string;
}

export default function MailTaskProgressModal({ taskId, onClose }: Props) {
  const { data, isLoading, isError } = useTaskCenter();
  const [dismissed, setDismissed] = useState(false);

  const task: TaskRow | undefined = useMemo(() => {
    const tasks = data?.data?.tasks ?? [];
    return tasks.find((t) => t.id === taskId);
  }, [data, taskId]);

  if (dismissed) return null;

  const handleClose = () => {
    setDismissed(true);
    onClose();
  };

  const close = (
    <button
      type="button"
      onClick={handleClose}
      data-testid="mail-task-progress-close"
      className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
      aria-label="Close"
    >
      <X size={16} />
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mail-task-progress-title"
      data-testid="mail-task-progress-modal"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-3">
          <h3
            id="mail-task-progress-title"
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            {task?.label ?? 'Mail operation'}
          </h3>
          {close}
        </div>

        <div className="px-5 py-4 space-y-4">
          {isLoading && !task && (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" />
              Loading task state…
            </div>
          )}

          {isError && (
            <div className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>Could not read task state. The chip may still be tracking it — refresh the page or check the task-center chip.</span>
            </div>
          )}

          {task && (
            <>
              <StatusHeader task={task} />
              <ProgressBar task={task} />
              {extractSteps(task).length > 0 && (
                <StepChecklist steps={extractSteps(task)} />
              )}
              {task.progressText && (
                <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="mail-task-progress-text">
                  {task.progressText}
                </p>
              )}
              {task.status === 'failed' && task.errorMessage && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300"
                >
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>{task.errorMessage}</span>
                </div>
              )}
            </>
          )}

          {task === undefined && !isLoading && !isError && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
              Task <code className="font-mono">{taskId.slice(0, 8)}…</code> is no longer in the active set (likely completed and cleared from the 5-min terminal window).
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusHeader({ task }: { task: TaskRow }) {
  if (task.status === 'succeeded') {
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400">
        <CheckCircle2 size={16} /> Completed
      </div>
    );
  }
  if (task.status === 'failed') {
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-400">
        <AlertTriangle size={16} /> Failed
      </div>
    );
  }
  if (task.status === 'cancelled') {
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
        Cancelled
      </div>
    );
  }
  // queued | running
  return (
    <div className="flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-400">
      <Loader2 size={16} className="animate-spin" />
      {task.status === 'queued' ? 'Queued' : 'Running'}
    </div>
  );
}

function ProgressBar({ task }: { task: TaskRow }) {
  const pct = task.progressPct ?? null;
  // When pct is unknown (null) but task is running, show an
  // indeterminate-style striped bar.
  const isIndeterminate = pct === null && task.status === 'running';
  const fillPct =
    pct !== null ? Math.max(0, Math.min(100, pct))
    : task.status === 'succeeded' ? 100
    : task.status === 'failed' ? 100
    : 0;
  const fillColor =
    task.status === 'failed' ? 'bg-red-500'
    : task.status === 'succeeded' ? 'bg-green-500'
    : 'bg-blue-500';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>Progress</span>
        <span data-testid="mail-task-progress-pct">{pct === null ? '—' : `${pct}%`}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          className={`h-full ${fillColor} ${isIndeterminate ? 'animate-pulse' : ''} transition-all duration-300`}
          style={{ width: `${fillPct}%` }}
        />
      </div>
    </div>
  );
}

function StepChecklist({ steps }: { steps: readonly ProgressStep[] }) {
  return (
    <ul className="space-y-1.5" data-testid="mail-task-progress-steps">
      {steps.map((step, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <StepIcon state={step.state} />
          <div className="flex-1">
            <div
              className={
                step.state === 'done' ? 'text-gray-500 dark:text-gray-400 line-through'
                : step.state === 'failed' ? 'text-red-700 dark:text-red-400'
                : step.state === 'running' ? 'font-medium text-gray-900 dark:text-gray-100'
                : 'text-gray-500 dark:text-gray-400'
              }
            >
              {step.name}
            </div>
            {step.note && (
              <div className="text-xs text-gray-500 dark:text-gray-400">{step.note}</div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function StepIcon({ state }: { state: ProgressStep['state'] }) {
  switch (state) {
    case 'done':
      return <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-green-500" />;
    case 'failed':
      return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" />;
    case 'running':
      return <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-blue-500" />;
    case 'pending':
    default:
      return <ChevronRight size={14} className="mt-0.5 shrink-0 text-gray-400" />;
  }
}

/**
 * Extract `details.steps` from the task row, validating shape defensively
 * (TaskRow.details is `Record<string, unknown>`).
 */
function extractSteps(task: TaskRow): readonly ProgressStep[] {
  const details = task.details;
  if (!details || typeof details !== 'object') return [];
  const raw = (details as { steps?: unknown }).steps;
  if (!Array.isArray(raw)) return [];
  const out: ProgressStep[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const name = (item as { name?: unknown }).name;
      const state = (item as { state?: unknown }).state;
      const note = (item as { note?: unknown }).note;
      if (
        typeof name === 'string'
        && (state === 'pending' || state === 'running' || state === 'done' || state === 'failed')
      ) {
        out.push({
          name,
          state,
          note: typeof note === 'string' ? note : undefined,
        });
      }
    }
  }
  return out;
}
