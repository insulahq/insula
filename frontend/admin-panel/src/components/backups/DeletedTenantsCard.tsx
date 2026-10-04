import { Link } from 'react-router-dom';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useRecoverableTenants } from '@/hooks/use-dr-recover';

/** Where a deleted tenant is recovered — the DR Recover Tenant tab, preselected. */
export function recoverTenantPath(tenantId: string): string {
  return `/backups/disaster-recovery?section=recover&tenant=${encodeURIComponent(tenantId)}`;
}

/**
 * Deleted tenants whose off-site bundles are still kept — and so can still be
 * recovered. A deleted tenant has no row any more, so it appears in no tenant
 * list; its bundles are kept for the deleted-tenant retention window
 * (Platform → Limits) precisely so it can come back. This is where an operator
 * finds it. Renders nothing when there are none.
 */
export default function DeletedTenantsCard() {
  const { data } = useRecoverableTenants();
  const deleted = (data?.data ?? []).filter((t) => t.deleted);
  if (deleted.length === 0) return null;
  return (
    <section
      className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-800 dark:bg-amber-900/10"
      data-testid="deleted-tenants-card"
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
        <Trash2 size={15} aria-hidden="true" /> Deleted tenants — still recoverable
      </h3>
      <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
        Deleting a tenant keeps its off-site bundles for the deleted-tenant retention window (Platform → Limits),
        so it can be re-created with its original id and namespace until they expire.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-amber-800/80 dark:text-amber-300/80">
              <th className="py-1.5 pr-4 font-medium">Tenant</th>
              <th className="py-1.5 pr-4 font-medium">Deleted</th>
              <th className="py-1.5 pr-4 font-medium">Bundles</th>
              <th className="py-1.5 pr-4 font-medium">Recoverable until</th>
              <th className="py-1.5" />
            </tr>
          </thead>
          <tbody>
            {deleted.map((t) => (
              <tr key={t.tenantId} className="border-t border-amber-200/70 dark:border-amber-800/60" data-testid={`deleted-tenant-${t.tenantId}`}>
                <td className="py-2 pr-4 font-medium text-gray-900 dark:text-gray-100">{t.name}</td>
                <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">{t.deletedAt ? t.deletedAt.slice(0, 10) : '—'}</td>
                <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">
                  {t.bundleCount}, newest {t.newestBundleAt.slice(0, 10)}
                  {!t.newestCompletedBundleId && <span className="ml-1 text-amber-700 dark:text-amber-400">(none complete)</span>}
                </td>
                <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">{t.keptUntil ? t.keptUntil.slice(0, 10) : 'no expiry'}</td>
                <td className="py-2 text-right">
                  <Link
                    to={recoverTenantPath(t.tenantId)}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-gray-800 dark:text-amber-200 dark:hover:bg-gray-700"
                    data-testid={`recover-deleted-${t.tenantId}`}
                  >
                    <RotateCcw size={12} aria-hidden="true" /> Recover…
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
