/** Small pieces every bundle picker uses. */
import { AlertCircle, Plus } from 'lucide-react';

export function AddBtn(props: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}

export function PickerSkeleton() {
  return (
    <div className="space-y-2 py-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-7 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
      ))}
    </div>
  );
}

export function PickerError({ msg }: { msg: string }) {
  return (
    <div className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      <AlertCircle className="mr-1 inline h-4 w-4" /> {msg}
    </div>
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}
