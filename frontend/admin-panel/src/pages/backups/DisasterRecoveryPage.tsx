/**
 * `/backups/disaster-recovery` — Disaster Recovery hub.
 *
 * Phase 1: placeholder + a deep-link out to today's locations for the
 * three pieces this page will consolidate (Secrets Bundle audit + DR
 * Drill + Restore Instructions). Phase 5 lifts SecretsCoverageSection
 * here, folds in DR Drill from System Backups, and renders restore
 * commands pre-filled with the operator's cluster context.
 */

import { Link } from 'react-router-dom';
import { LifeBuoy, ShieldCheck, Stethoscope, BookOpen, Construction } from 'lucide-react';

export default function DisasterRecoveryPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center gap-2">
        <LifeBuoy size={20} className="text-gray-600 dark:text-gray-300" />
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Disaster Recovery</h1>
      </header>

      <div
        className="flex items-start gap-3 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
        data-testid="dr-page-stub"
      >
        <Construction size={20} className="mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
        <div>
          <p className="font-semibold text-gray-900 dark:text-gray-100">Phase 5 — coming up</p>
          <p className="mt-1">
            This hub will host the three DR surfaces that are currently scattered:
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <ShieldCheck size={18} className="text-blue-600 dark:text-blue-300" />
          <h3 className="mt-2 font-semibold text-gray-900 dark:text-gray-100">Secrets Bundle</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Bundle-everything secret backups + audit table + restore profile picker. Today this lives on the System Backups page.
          </p>
          <Link
            to="/backups/system"
            className="mt-3 inline-flex text-xs font-medium text-blue-600 hover:underline dark:text-blue-300"
          >
            Open System Backups →
          </Link>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <Stethoscope size={18} className="text-emerald-600 dark:text-emerald-300" />
          <h3 className="mt-2 font-semibold text-gray-900 dark:text-gray-100">DR Drill</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Schedule + run + diff drill restores. Today this lives as a tab on System Backups.
          </p>
          <Link
            to="/backups/system?tab=dr-drill"
            className="mt-3 inline-flex text-xs font-medium text-blue-600 hover:underline dark:text-blue-300"
          >
            Open DR Drill →
          </Link>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <BookOpen size={18} className="text-purple-600 dark:text-purple-300" />
          <h3 className="mt-2 font-semibold text-gray-900 dark:text-gray-100">Restore Instructions</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Copy-pasteable commands for bootstrap import, postgres restore, mail restore — pre-filled with this cluster's context.
          </p>
          <span className="mt-3 inline-flex text-xs text-gray-400 dark:text-gray-500">Phase 5</span>
        </div>
      </div>
    </div>
  );
}
