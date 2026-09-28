/**
 * A standing notice for a cluster still on the old CPU model (ADR-062 R3).
 *
 * ★ Why a standing notice rather than a one-off release note.
 *
 * The migration is opt-in per tenant and always will be for an existing
 * cluster — nothing moves a tenant without an operator deciding to. The
 * failure mode that leaves is a change that is never applied: an operator
 * reads a release note once, is busy that week, and the cluster keeps
 * reserving CPU nobody uses for another year. So the notice carries the
 * operator's OWN figures, from their own cluster, and a way through to the
 * page that acts on them.
 *
 * It disappears on its own when the last tenant is migrated. Nothing to
 * dismiss, because a dismissal would hide a real and continuing cost.
 */
import { Link } from 'react-router-dom';
import { Gauge } from 'lucide-react';
import { useCpuMigrationPreview } from '@/hooks/use-cpu-migration';

const cores = (millis: number) => (millis / 1000).toFixed(2);

export default function LegacyCpuNotice() {
  const { data } = useCpuMigrationPreview();
  const p = data?.data;
  if (!p) return null;

  const legacy = p.tenants.filter((t) => t.schedulingMode === 'legacy');
  // Nothing to say on a fully-migrated cluster, and nothing to say on one
  // where the saving would be trivial — a notice that appears for 30m of
  // reclaimable CPU is a notice people learn to skip.
  if (legacy.length === 0 || p.reclaimableMillis < 250) return null;

  // Only what the LEGACY tenants would hand back: quoting the cluster-wide
  // figure would promise a saving the already-migrated tenants have
  // delivered.
  const reclaimable = legacy.reduce((sum, t) => sum + t.reclaimableMillis, 0);
  if (reclaimable < 250) return null;

  const reservedPct = p.allocatableMillis > 0
    ? Math.round((p.reservedMillis / p.allocatableMillis) * 100)
    : null;
  // A measured zero is a reading; only null is "not measured".
  const usedPct = p.usedMillis !== null && p.allocatableMillis > 0
    ? Math.round((p.usedMillis / p.allocatableMillis) * 100)
    : null;

  return (
    <div
      className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-900/20"
      data-testid="legacy-cpu-notice"
    >
      <div className="flex items-start gap-2">
        <Gauge size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          <div className="font-semibold text-gray-900 dark:text-gray-100">
            {/* The VERB agrees too: "1 tenant still reserve" shipped to a
                real console before anyone read it aloud. */}
            {legacy.length === 1
              ? '1 tenant still reserves CPU it does not use'
              : `${legacy.length} tenants still reserve CPU they do not use`}
          </div>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            {reservedPct !== null && usedPct !== null ? (
              <>
                This cluster has <span className="font-mono">{reservedPct}%</span> of its CPU
                reserved and <span className="font-mono">{usedPct}%</span> of it in use.{' '}
              </>
            ) : null}
            Moving {legacy.length === 1 ? 'that tenant' : 'those tenants'} to the share model
            hands back about <span className="font-mono">{cores(reclaimable)}</span> cores —
            the same applications, the same burst headroom, without the reservation.
          </p>
          <Link
            to="/cluster/cpu-scheduling"
            className="mt-2 inline-block text-xs font-medium text-amber-900 underline dark:text-amber-200"
            data-testid="legacy-cpu-notice-link"
          >
            Review it tenant by tenant →
          </Link>
        </div>
      </div>
    </div>
  );
}
