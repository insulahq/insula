/**
 * `/backups/mail` — placeholder until Phase 3 builds the per-class
 * shell (Snapshots / Backups / Targets+Schedules+Retention).
 */

import { Mail, Construction } from 'lucide-react';

export default function MailBackupsPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center gap-2">
        <Mail size={20} className="text-gray-600 dark:text-gray-300" />
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Mail Backups</h1>
      </header>
      <div
        className="flex items-start gap-3 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
        data-testid="mail-backups-stub"
      >
        <Construction size={20} className="mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
        <div>
          <p className="font-semibold text-gray-900 dark:text-gray-100">Phase 3 — coming up</p>
          <p className="mt-1">
            This page will host the Mail backup-class view: snapshots list, backups list, and targets+schedules+retention.
            For now, mail backup admin lives at the legacy surfaces while the new IA is rolled out.
          </p>
        </div>
      </div>
    </div>
  );
}
