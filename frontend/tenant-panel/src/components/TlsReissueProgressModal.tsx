import { useMemo, useState } from 'react';
import { X, Loader2, CheckCircle2, AlertTriangle, Circle } from 'lucide-react';
import { useTaskCenter } from '@/hooks/use-task-center';
import type { TaskRow } from '@insula/api-contracts';

/**
 * Progress for an on-demand certificate reissue.
 *
 * Reads from `useTaskCenter()` — already polled every 3 s while anything
 * is running — and filters to this task. Closing the modal does not
 * abandon the work: it runs server-side, and the certificate card
 * reflects the outcome either way.
 *
 * The step notes matter here: "Wait for the certificate authority"
 * carries cert-manager's own message, which is where the actual reason
 * for a stuck DNS-01 order shows up.
 */

interface Props {
  readonly taskId: string;
  readonly onClose: () => void;
}

interface ProgressStep {
  readonly name: string;
  readonly state: 'pending' | 'running' | 'done' | 'failed';
  readonly note?: string;
}

function StepIcon({ state }: { readonly state: ProgressStep['state'] }) {
  if (state === 'running') return <Loader2 size={14} className="animate-spin text-blue-600 dark:text-blue-400" />;
  if (state === 'done') return <CheckCircle2 size={14} className="text-green-600 dark:text-green-400" />;
  if (state === 'failed') return <AlertTriangle size={14} className="text-red-600 dark:text-red-400" />;
  return <Circle size={14} className="text-gray-300 dark:text-gray-600" />;
}

export default function TlsReissueProgressModal({ taskId, onClose }: Props) {
  const { data } = useTaskCenter();
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

  const details = task?.details as { steps?: ProgressStep[]; domainName?: string } | undefined;
  const steps = details?.steps ?? [];
  const isTerminal = task?.status === 'succeeded' || task?.status === 'failed';

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tls-reissue-title"
      data-testid="tls-reissue-modal"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="w-full max-w-lg rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
          <h3 id="tls-reissue-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Requesting a certificate{details?.domainName ? ` for ${details.domainName}` : ''}
          </h3>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <ol className="space-y-2" data-testid="tls-reissue-steps">
            {steps.map((step) => (
              <li key={step.name} className="flex items-start gap-2 text-sm">
                <span className="mt-0.5"><StepIcon state={step.state} /></span>
                <span className="flex-1">
                  <span className={step.state === 'pending' ? 'text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-gray-100'}>
                    {step.name}
                  </span>
                  {step.note && (
                    <span className="mt-0.5 block break-words font-mono text-xs text-gray-500 dark:text-gray-400">
                      {step.note}
                    </span>
                  )}
                </span>
              </li>
            ))}
            {steps.length === 0 && (
              <li className="text-sm text-gray-500 dark:text-gray-400">Starting…</li>
            )}
          </ol>

          {task?.status === 'failed' && (
            <p className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 px-3 py-2 text-sm text-red-800 dark:text-red-200" data-testid="tls-reissue-error">
              {task.errorMessage ?? 'The certificate could not be issued.'}
            </p>
          )}
          {task?.status === 'succeeded' && (
            <p className="rounded-lg border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/30 px-3 py-2 text-sm text-green-800 dark:text-green-200" data-testid="tls-reissue-success">
              Certificate issued and in use.
            </p>
          )}
          {!isTerminal && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              You can close this — the request continues in the background.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
