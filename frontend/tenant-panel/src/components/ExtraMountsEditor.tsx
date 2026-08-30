import { Plus, Trash2 } from 'lucide-react';
import { folderProblem, mountPathProblem, MAX_EXTRA_MOUNTS, type ExtraMount } from '@insula/api-contracts';

/**
 * Editor for tenant-defined extra mounts on a deployment.
 *
 * Validation reuses the very functions the API validates with
 * (`folderProblem` / `mountPathProblem` from @insula/api-contracts), so the
 * inline message a tenant sees here is the same rule the server enforces —
 * no second copy to drift.
 */

const INPUT =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 ' +
  'px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 ' +
  'focus:outline-none focus:ring-2 focus:ring-blue-500';

export type ExtraMountRow = ExtraMount;

/** Every problem with the current list, keyed by row index + field. */
export function extraMountErrors(rows: readonly ExtraMountRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Map<string, number>();
  rows.forEach((row, i) => {
    if (row.folder.trim() === '' && row.mount_path.trim() === '') return; // untouched row
    const fp = row.folder.trim() === '' ? 'Folder is required.' : folderProblem(row.folder);
    if (fp) errors[`${i}.folder`] = fp;
    const mp = row.mount_path.trim() === '' ? 'Mount path is required.' : mountPathProblem(row.mount_path);
    if (mp) errors[`${i}.mount_path`] = mp;
    if (!mp) {
      const key = row.mount_path.replace(/\/+$/, '') || '/';
      const first = seen.get(key);
      if (first !== undefined) errors[`${i}.mount_path`] = `Already mounted by row ${first + 1}.`;
      else seen.set(key, i);
    }
  });
  return errors;
}

interface Props {
  readonly rows: readonly ExtraMountRow[];
  readonly onChange: (rows: ExtraMountRow[]) => void;
  readonly disabled?: boolean;
}

export default function ExtraMountsEditor({ rows, onChange, disabled }: Props) {
  const errors = extraMountErrors(rows);

  const update = (i: number, patch: Partial<ExtraMountRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <div data-testid="extra-mounts-editor">
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
        Mount a folder from your storage at an extra path inside the container. Folders are
        relative to your storage root, so two deployments naming the same folder share it —
        and a shared folder is <strong>not</strong> removed when this deployment is deleted.
      </p>

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div
              key={i}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3"
              data-testid={`extra-mount-row-${i}`}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                    Folder
                  </label>
                  <input
                    className={INPUT}
                    value={row.folder}
                    disabled={disabled}
                    placeholder="shared-assets"
                    onChange={(e) => update(i, { folder: e.target.value })}
                    data-testid={`extra-mount-folder-${i}`}
                  />
                  {errors[`${i}.folder`] && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors[`${i}.folder`]}</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                    Mount at
                  </label>
                  <input
                    className={INPUT}
                    value={row.mount_path}
                    disabled={disabled}
                    placeholder="/var/www/html/media"
                    onChange={(e) => update(i, { mount_path: e.target.value })}
                    data-testid={`extra-mount-path-${i}`}
                  />
                  {errors[`${i}.mount_path`] && (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors[`${i}.mount_path`]}</p>
                  )}
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <input
                    type="checkbox"
                    checked={row.read_only}
                    disabled={disabled}
                    onChange={(e) => update(i, { read_only: e.target.checked })}
                    className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-800"
                    data-testid={`extra-mount-readonly-${i}`}
                  />
                  Read-only
                </label>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                  data-testid={`extra-mount-remove-${i}`}
                >
                  <Trash2 size={12} /> Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        disabled={disabled || rows.length >= MAX_EXTRA_MOUNTS}
        onClick={() => onChange([...rows, { folder: '', mount_path: '', read_only: false }])}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
        data-testid="extra-mount-add"
      >
        <Plus size={14} />
        Add mount
      </button>
      {rows.length >= MAX_EXTRA_MOUNTS && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Maximum of {MAX_EXTRA_MOUNTS} extra mounts reached.
        </p>
      )}
    </div>
  );
}
