import type { OperatorError } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { useClearFailedState } from '@/hooks/use-storage-lifecycle';
import { extractOperatorError } from '@/lib/extract-operator-error';

/** The OperatorError envelope a failed operation stored, else its plain text. */
function readLastError(lastError: string | null): { envelope: OperatorError | null; plain: string } {
  const text = lastError?.trim() ?? '';
  if (!text) return { envelope: null, plain: '' };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.code && parsed.title) return { envelope: parsed as OperatorError, plain: '' };
  } catch { /* not JSON: the plain message */ }
  return { envelope: null, plain: text };
}

/**
 * The storage operation that left a tenant in the `failed` state: what went
 * wrong, and Reset to idle. Every storage operation, restore included, refuses
 * a tenant that is not idle, so the reset is the way out. It keeps the failed
 * operation's row, and brings back any workloads that operation stopped.
 *
 * `op` null: the tenant is failed and its failed operation could not be read.
 * The reset is still offered, as the API finds that operation itself.
 */
export function FailedStorageOperation({ tenantId, op }: {
  readonly tenantId: string;
  readonly op: { readonly opType: string; readonly lastError: string | null } | null;
}) {
  const clearFailed = useClearFailedState();
  const { envelope, plain } = readLastError(op?.lastError ?? null);
  const heading = op ? `Last ${op.opType} failed` : 'A storage operation failed';

  const clearButton = (
    <button
      type="button"
      onClick={() => {
        if (confirm("Reset this tenant's storage state back to 'idle'? The failed operation's log is kept for debugging.")) {
          clearFailed.mutate(tenantId);
        }
      }}
      disabled={clearFailed.isPending}
      className="shrink-0 rounded-md border border-red-300 dark:border-red-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50"
      data-testid="lifecycle-clear-failed-button"
    >
      {clearFailed.isPending ? 'Clearing…' : 'Reset to idle'}
    </button>
  );
  const clearError = clearFailed.isError && (
    <div className="mt-2">
      <ErrorPanel error={extractOperatorError(clearFailed.error)} severity="error" compact testId="lifecycle-clear-failed-error" />
    </div>
  );

  if (envelope) {
    return (
      <div className="mb-3" data-testid="lifecycle-failed-op">
        <div className="mb-1 text-xs font-medium text-red-800 dark:text-red-200">
          {heading}
        </div>
        <ErrorPanel error={envelope} severity="error" testId="lifecycle-error-panel" />
        <div className="mt-2 flex justify-end">{clearButton}</div>
        {clearError}
      </div>
    );
  }
  return (
    <div className="mb-3 rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm" data-testid="lifecycle-failed-op">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium text-red-800 dark:text-red-200">{heading}</div>
          {plain && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{plain}</p>}
        </div>
        {clearButton}
      </div>
      {clearError}
    </div>
  );
}
