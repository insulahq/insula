/**
 * "There are orphaned volumes" — wherever the operator already is.
 *
 * The orphaned-volumes modal is on the Storage tab, which nobody opens unless
 * they already suspect something. A 256 GiB volume once sat Released on
 * production holding 63% of the cluster's schedulable storage, and the only
 * thing that surfaced was a capacity warning that did not say why. An orphan
 * is worth mentioning where people actually look.
 *
 * Two placements, one component and one query, presented differently on
 * purpose:
 *   - the Dashboard: a COUNT, and a click that opens the management modal.
 *     The dashboard's job is to say something is there, not to explain it —
 *     the modal already does that properly, so repeating a summary of it
 *     between the health banner and the incident cards would be noise on a
 *     page read during incidents.
 *   - a tenant's detail page: the volumes themselves, filtered to that
 *     tenant's namespace, because there the question is "what is MINE" and
 *     the answer is short.
 *
 * Both read the shared `['orphaned-volumes']` cache, so they cost one scan
 * between them and can never disagree with the modal about what exists.
 *
 * Renders NOTHING when there is nothing to report — including while the scan
 * is in flight, and when it fails. A card that appears empty or errored on
 * every dashboard load would be trained away within a week, and the modal
 * remains the place to go when a real answer is needed.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { HardDrive } from 'lucide-react';
import type { OrphanedVolumeEntry } from '@insula/api-contracts';
import { useOrphanedVolumes } from '@/hooks/use-orphaned-volumes';
import OrphanedVolumesModal from '@/components/OrphanedVolumesModal';

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}

interface Props {
  /**
   * Restrict to one tenant's namespace. Omit for the cluster-wide view.
   *
   * Filtering here rather than server-side keeps both placements on the one
   * cached scan; the report is small (one row per orphan, not per volume on
   * the cluster) so there is nothing to gain by splitting it.
   */
  readonly namespace?: string;
}

export default function OrphanedVolumesAlert({ namespace }: Props) {
  const { data, isLoading, isError } = useOrphanedVolumes();

  // Silence while loading or broken — see the note at the top of this file.
  if (isLoading || isError) return null;

  const all: readonly OrphanedVolumeEntry[] = data?.data?.orphans ?? [];
  const rows = namespace ? all.filter((o) => o.namespace === namespace) : all;
  if (rows.length === 0) return null;

  const bytes = rows.reduce((sum, o) => sum + o.sizeBytes, 0);
  const scoped = Boolean(namespace);

  if (!scoped) return <DashboardCount count={rows.length} />;

  return (
    <div
      className="rounded-xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm dark:border-amber-800 dark:bg-amber-900/10"
      data-testid={scoped ? 'tenant-orphaned-volumes-alert' : 'dashboard-orphaned-volumes-alert'}
    >
      <div className="flex items-start gap-3">
        <HardDrive size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            {rows.length} orphaned volume{rows.length === 1 ? '' : 's'}
            {scoped ? ' for this tenant' : ''}
          </h3>
          <p className="mt-0.5 text-xs text-amber-800/90 dark:text-amber-300/90">
            {/* The size is the point: an orphan holds its FULL provisioned
                size against Longhorn's schedulable capacity however little is
                written in it, which is what turns one into a capacity
                warning nobody can explain. */}
            Holding <strong>{fmtBytes(bytes)}</strong> of schedulable storage.
            {scoped
              ? ' Released by a resize or a deleted claim, and still charged against the cluster.'
              : ' They stay charged against the cluster until they are removed.'}
          </p>

          <ul className="mt-2 space-y-1">
            {rows.slice(0, 4).map((o) => (
              <li
                key={o.pvName ?? o.longhornVolumeName ?? o.namespace ?? Math.random().toString(36)}
                className="flex flex-wrap items-baseline gap-x-2 text-xs text-amber-900/90 dark:text-amber-200/90"
              >
                <span className="font-mono">{fmtBytes(o.sizeBytes)}</span>
                {!scoped && <span className="opacity-80">{o.ownerLabel}</span>}
                <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-amber-900/40">
                  {o.reason.replace(/_/g, ' ')}
                </span>
                {o.ageDays !== null && (
                  <span className="opacity-70">
                    {o.ageDays === 0 ? 'today' : `${o.ageDays}d ago`}
                  </span>
                )}
              </li>
            ))}
            {rows.length > 4 && (
              <li className="text-xs opacity-70">and {rows.length - 4} more</li>
            )}
          </ul>

          <Link
            to="/settings/storage"
            className="mt-2 inline-block text-xs font-medium text-amber-900 underline hover:opacity-80 dark:text-amber-200"
            data-testid="orphaned-volumes-alert-link"
          >
            Manage orphaned volumes →
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Dashboard presentation: the number, and a way in.
 *
 * Opens the same modal the Storage tab does rather than navigating there —
 * an operator who clicks a count wants the list, not a settings page they
 * then have to find the button on.
 */
function DashboardCount({ count }: { readonly count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-3 rounded-xl border border-l-4 border-gray-200 border-l-amber-500 bg-amber-50/50 px-4 py-3 text-left shadow-sm transition-colors hover:bg-amber-100/60 dark:border-gray-700 dark:border-l-amber-400 dark:bg-amber-950/30 dark:hover:bg-amber-950/50"
        data-testid="dashboard-orphaned-volumes-alert"
      >
        <HardDrive size={18} className="shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-sm text-gray-900 dark:text-gray-100">
          <strong className="font-semibold">{count}</strong>
          {' '}orphaned volume{count === 1 ? '' : 's'}
        </span>
        <span className="ml-auto text-xs font-medium text-amber-800 underline dark:text-amber-300">
          Manage →
        </span>
      </button>
      {open && <OrphanedVolumesModal onClose={() => setOpen(false)} />}
    </>
  );
}
