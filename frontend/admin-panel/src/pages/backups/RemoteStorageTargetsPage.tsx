/**
 * `/backups/targets` — Remote Storage Targets.
 *
 * Phase 1: thin wrapper around the existing BackupSettings page so the
 * new route is wired and operators can navigate via the new sidebar.
 * Phase 4 will replace the wrapper with a clean ~250 LOC Targets CRUD
 * lifted out of BackupSettings.tsx, and the BackupSettings monolith
 * will be deleted.
 */

import { Cloud } from 'lucide-react';
import BackupSettings from '../BackupSettings';

export default function RemoteStorageTargetsPage() {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-gray-200 px-6 pt-6 pb-3 dark:border-gray-700">
        <Cloud size={20} className="text-gray-600 dark:text-gray-300" />
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Remote Storage Targets</h1>
      </div>
      <BackupSettings />
    </div>
  );
}
