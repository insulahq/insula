/**
 * A standing notice while any tenant is still on the old CPU model (ADR-062).
 *
 * CPU cores are retired, and the platform moves every such tenant to CPU
 * shares by itself, one at a time (backend cpu-migration/auto-migrate.ts),
 * retrying a failure a day later. The notice says that is happening and
 * links to where it can be followed — or hurried, one tenant at a time. It
 * disappears on its own when the last tenant is moved.
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
  if (legacy.length === 0) return null;

  // Only what the LEGACY tenants will hand back: quoting the cluster-wide
  // figure would promise a saving the already-migrated tenants have
  // delivered.
  const reclaimable = legacy.reduce((sum, t) => sum + t.reclaimableMillis, 0);

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
              ? '1 tenant is still on the old CPU model — it is being moved to CPU shares'
              : `${legacy.length} tenants are still on the old CPU model — they are being moved to CPU shares`}
          </div>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            {reservedPct !== null && usedPct !== null ? (
              <>
                This cluster has <span className="font-mono">{reservedPct}%</span> of its CPU
                reserved and <span className="font-mono">{usedPct}%</span> of it in use.{' '}
              </>
            ) : null}
            The platform moves them one at a time, with the same checks as a manual
            migration, and retries a failure a day later. Moving them hands back about{' '}
            <span className="font-mono">{cores(reclaimable)}</span> cores — the same
            applications, the same burst headroom, without the reservation.
          </p>
          <Link
            to="/cluster/cpu-scheduling"
            className="mt-2 inline-block text-xs font-medium text-amber-900 underline dark:text-amber-200"
            data-testid="legacy-cpu-notice-link"
          >
            Follow it tenant by tenant →
          </Link>
        </div>
      </div>
    </div>
  );
}
