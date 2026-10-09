import { Database, Server, Boxes } from 'lucide-react';
import type { UpgradeChangesResponse } from '@insula/api-contracts';
import NodeName from '@/components/nodes/NodeName';
import { formatVersion } from '@/lib/format-version';

/**
 * "What changes" in the upgrade review (ADR-064 §6): the services' version, the
 * migrations still to run, and each host change with the nodes it runs on and
 * when — before the services roll, or after them.
 */
const PHASE_LABEL = {
  'before-services': 'before the services',
  'after-services': 'after the services',
} as const;

export default function UpgradeChangesSection({ changes, target }: { readonly changes: UpgradeChangesResponse; readonly target?: string }) {
  // The stored contents belong to the AVAILABLE release; an explicit other target
  // has none to show.
  if (target && changes.toVersion && target !== changes.toVersion) return null;
  const nodeCount = new Set(changes.hostChanges.flatMap((c) => c.nodes)).size;
  return (
    <div className="space-y-2 rounded border border-gray-200 p-3 text-xs dark:border-gray-700" data-testid="upgrade-changes">
      <div className="font-medium text-gray-900 dark:text-gray-100">What changes</div>
      <div className="flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
        <Boxes className="h-3.5 w-3.5 text-gray-400" />
        Services {changes.fromVersion ? formatVersion(changes.fromVersion) : '—'} → {changes.toVersion ? formatVersion(changes.toVersion) : '—'}
      </div>
      {!changes.known ? (
        <p className="text-gray-500 dark:text-gray-400" data-testid="upgrade-changes-unknown">
          This release does not list its database or host changes (it was cut before releases did).
        </p>
      ) : (
        <>
          <div className="flex items-center gap-1.5 text-gray-700 dark:text-gray-300" data-testid="upgrade-changes-migrations">
            <Database className="h-3.5 w-3.5 text-gray-400" />
            {changes.databaseMigrations === 0 && changes.platformMigrations === 0
              ? 'No database or platform migrations'
              : `${changes.databaseMigrations} database migration(s), ${changes.platformMigrations} platform migration(s) — they run as the new services start`}
          </div>
          <div className="flex items-start gap-1.5 text-gray-700 dark:text-gray-300">
            <Server className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
            {changes.hostChanges.length === 0 ? (
              <span data-testid="upgrade-changes-hosts">No host changes</span>
            ) : (
              <div className="min-w-0 flex-1" data-testid="upgrade-changes-hosts">
                {changes.hostChanges.length} host change(s){nodeCount > 0 ? ` on ${nodeCount} node(s)` : ''}:
                <ul className="mt-1 space-y-1">
                  {changes.hostChanges.map((c) => (
                    <li key={c.key} data-testid={`upgrade-change-${c.key}`}>
                      <span className="mr-1 rounded bg-gray-100 px-1 py-0.5 text-[11px] text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                        {PHASE_LABEL[c.phase]}
                      </span>
                      {c.description}
                      <span className="text-gray-500 dark:text-gray-400">
                        {' — '}
                        {c.nodes.length === nodeCount
                          ? 'every node'
                          : c.nodes.map((n, i) => <span key={n}>{i > 0 ? ', ' : ''}<NodeName name={n} /></span>)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {changes.unreportedNodes.length > 0 && (
            <p className="text-amber-700 dark:text-amber-300" data-testid="upgrade-changes-unreported">
              {changes.unreportedNodes.map((n, i) => <span key={n}>{i > 0 ? ', ' : ''}<NodeName name={n} /></span>)}
              {changes.unreportedNodes.length === 1 ? ' has' : ' have'} not reported host state — its host changes are not known.
            </p>
          )}
        </>
      )}
    </div>
  );
}
