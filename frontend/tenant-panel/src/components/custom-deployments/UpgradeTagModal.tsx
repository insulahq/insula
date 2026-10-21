import { useState } from 'react';
import type { CustomDeploymentSpec, UpdateCheckResult } from '@insula/api-contracts';
import { useUpgradeTag, type CustomDeploymentRow } from '@/hooks/use-custom-deployments';

// Change a custom container's image tag. Opened from the Custom Containers
// tab and from an app's details modal (CustomUpdatesCard) — its own file so
// the modal does not pull the tab's editors into its bundle.

/** The image to pre-fill the upgrade modal with: the current one, at the newer tag. */
export function suggestedUpgradeImage(
  spec: Pick<CustomDeploymentSpec, 'services'> | null | undefined,
  updates: UpdateCheckResult | undefined,
): string {
  const s = Object.values(spec?.services ?? {})[0];
  // Only a SEMVER bump yields a real tag to pre-fill. For `digest`,
  // `latest` is a truncated display digest (`sha256:…`, with an
  // ellipsis) — pre-filling it would build an invalid image ref, so
  // the digest path uses re-pull (onRepull), never this modal.
  const isSemverBump = updates?.status === 'patch' || updates?.status === 'minor' || updates?.status === 'major';
  if (s && updates?.latest && isSemverBump) {
    const idx = s.image.lastIndexOf(':');
    return idx > 0 && !s.image.includes('@') ? `${s.image.slice(0, idx)}:${updates.latest}` : s.image;
  }
  return s?.image ?? '';
}

/** Also opened from the details modal (CustomUpdatesCard), so it stacks above z-50. */
export function UpgradeTagModal({
  tenantId,
  row,
  suggestedImage,
  onClose,
}: {
  tenantId: string;
  row: Pick<CustomDeploymentRow, 'id' | 'name'>;
  suggestedImage: string;
  onClose: () => void;
}) {
  const [image, setImage] = useState(suggestedImage);
  const [error, setError] = useState<string | null>(null);
  const mutation = useUpgradeTag(tenantId);

  const submit = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({ id: row.id, image });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upgrade failed');
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Upgrade tag</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Replace the image for <span className="font-mono">{row.name}</span>. The Pod restarts immediately.
        </p>
        <label className="mt-4 block text-sm font-medium text-gray-700 dark:text-gray-300">New image</label>
        <input
          type="text"
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder="nginx:1.27.5"
          autoFocus
        />
        {error && <div className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={mutation.isPending || !image.trim()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {mutation.isPending ? 'Upgrading…' : 'Upgrade'}
          </button>
        </div>
      </div>
    </div>
  );
}
