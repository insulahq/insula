import { AlertTriangle } from 'lucide-react';

/**
 * The "Delete permanently (skip recycle bin)" opt-in shared by every delete
 * dialog that routes through the trash.
 *
 * DELIBERATELY STATELESS. The checked value is owned by the dialog and reset
 * when it OPENS, never when it closes. A remembered opt-out is the worst
 * possible failure mode here: tick it once, cancel, delete something else a
 * week later, and the file is gone with the dialog still headed "Move to
 * Trash". The deployment delete modal already has this bug shape with its
 * `deleteDataFolder` checkbox, which resets on success but not on cancel.
 */
export function PermanentDeleteToggle({
  checked, onChange, disabled, testId = 'permanent-delete-toggle',
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
}) {
  return (
    <label className={`mt-3 flex items-start gap-2 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-red-600 focus:ring-red-500 dark:border-gray-600 dark:bg-gray-700"
        data-testid={testId}
      />
      <span className="text-sm text-gray-700 dark:text-gray-300">
        Delete permanently <span className="text-gray-500 dark:text-gray-400">(skip recycle bin)</span>
      </span>
    </label>
  );
}

/**
 * The consequence line under the toggle. Shown in both states on purpose: the
 * recoverable path has a cost the tenant needs to know about (the bin keeps
 * consuming their quota), and the permanent path has no undo.
 */
export function DeleteConsequence({ permanent, retentionDays }: {
  readonly permanent: boolean;
  readonly retentionDays: number;
}) {
  if (permanent) {
    return (
      <p className="mt-3 flex items-start gap-1.5 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
        <AlertTriangle size={14} className="mt-px shrink-0" />
        <span>This cannot be undone. The files are erased immediately and are not recoverable.</span>
      </p>
    );
  }
  return (
    <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
      Kept in the recycle bin for {retentionDays} day{retentionDays === 1 ? '' : 's'}, then removed automatically.
      Trashed files still count toward your storage until then.
    </p>
  );
}
