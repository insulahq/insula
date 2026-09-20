/**
 * "That resize left the old volume behind — remove it?"
 *
 * A destructive resize replaces the tenant's PVC. The old Longhorn volume
 * survives detached and Released, because the tenant StorageClass is
 * `reclaimPolicy: Retain`, and it goes on holding its FULL provisioned size
 * against Longhorn's schedulable capacity however little is written in it.
 *
 * Nothing reclaims it. On production one such volume — 256 GiB expanded and
 * replaced fourteen minutes later, holding 143 MiB — came to account for 63%
 * of the cluster's entire storage commitment, and the only symptom was a
 * capacity warning that did not say why.
 *
 * The moment the operator learns the resize worked is the moment to offer
 * clearing it up: they are present, they know what they just did, and the
 * volume is unambiguously the one they replaced.
 *
 * It finds that volume rather than guessing its name — reading the same
 * orphan scan the rest of the UI uses and taking the tenant's most recently
 * released one. A name composed from a convention would be wrong the first
 * time the convention changed, and would delete nothing while looking like it
 * had worked.
 */
import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { useOrphanedVolumes, useDeleteOrphan } from '@/hooks/use-orphaned-volumes';
import { extractOperatorError } from '@/lib/extract-operator-error';
import ErrorPanel from '@/components/ErrorPanel';

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}

export default function ReleasedSourceVolumeOffer({ namespace }: { readonly namespace: string }) {
  const { data } = useOrphanedVolumes();
  const del = useDeleteOrphan();
  const [done, setDone] = useState(false);

  const candidates = (data?.data?.orphans ?? [])
    .filter((o) => o.namespace === namespace && o.longhornVolumeName)
    // Newest release first — the one this operation just produced.
    .sort((a, b) => (a.ageDays ?? 0) - (b.ageDays ?? 0));
  const target = candidates[0];

  if (done) {
    return (
      <p className="text-xs text-green-700 dark:text-green-400" data-testid="released-source-deleted">
        Old volume removed; its capacity is back in the pool.
      </p>
    );
  }

  // Nothing released — a non-destructive resize (an in-place grow) keeps the
  // same volume, and there is correctly nothing to offer.
  if (!target) return null;

  return (
    <div
      className="rounded-md border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-800 dark:bg-amber-900/20"
      data-testid="released-source-volume-offer"
    >
      <p className="text-xs text-amber-900 dark:text-amber-200">
        The previous <strong>{fmtBytes(target.sizeBytes)}</strong> volume was left behind and still
        counts against cluster storage. Delete it, or leave it and remove it later from
        Storage → Manage Orphaned Volumes.
      </p>
      {del.isError && (
        <div className="mt-2">
          <ErrorPanel error={extractOperatorError(del.error)} />
        </div>
      )}
      <button
        type="button"
        disabled={del.isPending}
        onClick={() => {
          del.mutate(
            { volumeName: target.longhornVolumeName!, pvName: target.pvName ?? undefined },
            { onSuccess: () => setDone(true) },
          );
        }}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:bg-gray-800 dark:text-amber-200 dark:hover:bg-gray-700"
        data-testid="delete-released-source-volume"
      >
        {del.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        Delete the {fmtBytes(target.sizeBytes)} volume
      </button>
    </div>
  );
}
