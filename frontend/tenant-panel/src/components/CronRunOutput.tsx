import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * What a job's last run printed: the command's output, a webcron's response
 * body, or why it did not run at all (the platform could not reach the
 * cluster, the deployment was stopped). Without it a failed run is a red
 * badge and an exit code, and the reason is only in the API.
 */
export function CronOutputToggle({ jobId, open, onToggle }: {
  readonly jobId: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="inline-flex w-fit items-center gap-0.5 text-xs text-blue-600 hover:underline dark:text-blue-400"
      data-testid={`cron-output-toggle-${jobId}`}
    >
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      Output
    </button>
  );
}

export function CronOutputRow({ jobId, output, running, colSpan }: {
  readonly jobId: string;
  readonly output: string;
  /** A run is in flight: what is stored is still the previous run's. */
  readonly running: boolean;
  readonly colSpan: number;
}) {
  return (
    <tr className="border-b border-gray-100 dark:border-gray-700 last:border-0" data-testid={`cron-output-${jobId}`}>
      <td colSpan={colSpan} className="px-6 pb-4 pt-0">
        <p className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
          {running ? 'Output of the previous run' : 'Output of the last run'}
        </p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
          {output}
        </pre>
      </td>
    </tr>
  );
}
