/**
 * The cart's databases picker: a bundle's databases per instance, restored in
 * place, as a copy, or as a test (contracts DatabaseRestoreMode).
 */
import { useState } from 'react';
import { AlertCircle, Info } from 'lucide-react';
import type { DatabaseRestoreMode } from '@insula/api-contracts';
import { AddBtn, PickerError, PickerSkeleton, formatSize } from './picker-parts.js';
import type { PickerProps } from './RestoreCartLayout.js';

const TARGET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const MODES: ReadonlyArray<{ readonly mode: DatabaseRestoreMode; readonly label: string; readonly help: string }> = [
  {
    mode: 'copy',
    label: 'As a copy',
    help: 'Restores into a new database next to the original, named <name>_restored_<time> unless you name it. The original is not touched.',
  },
  {
    mode: 'test',
    label: 'Test only',
    help: 'Restores into a scratch database, counts the tables or collections that came back, and drops it again. Changes nothing.',
  },
  {
    mode: 'replace',
    label: 'In place',
    help: 'Restores into the database of the same name, over what is there: the tables, views and routines in the backup are recreated, so changes to them since the backup are lost. Anything created since stays. PostgreSQL restores all or nothing; on MariaDB, MySQL and MongoDB a failure part-way leaves some tables restored — try a test restore first.',
  },
];

function modeLabel(mode: DatabaseRestoreMode): string {
  return mode === 'replace' ? 'in place' : mode === 'copy' ? 'as a copy' : 'test';
}

export function DatabasesPicker({ hooks, bundleId, cartReady, addItem }: PickerProps) {
  const q = hooks.useBrowseDatabases(bundleId);
  const [mode, setMode] = useState<DatabaseRestoreMode>('copy');
  const [names, setNames] = useState<Record<string, string>>({});
  if (q.isLoading) return <PickerSkeleton />;
  if (q.isError) return <PickerError msg={(q.error as Error)?.message ?? 'failed to load'} />;
  const data = q.data?.data;
  const instances = data?.instances ?? [];
  if (instances.length === 0) return <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">No databases were backed up in this bundle.</p>;
  const perDatabase = data?.perDatabase ?? false;
  const effectiveMode: DatabaseRestoreMode = perDatabase ? mode : 'replace';
  const help = MODES.find((m) => m.mode === effectiveMode)?.help ?? '';

  return (
    <div className="space-y-3">
      {perDatabase ? (
        <div>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="How to restore">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                role="radio"
                aria-checked={mode === m.mode}
                onClick={() => setMode(m.mode)}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                  mode === m.mode
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className={`mt-2 flex gap-1.5 text-xs ${effectiveMode === 'replace' ? 'text-amber-700 dark:text-amber-300' : 'text-gray-600 dark:text-gray-400'}`}>
            {effectiveMode === 'replace' ? <AlertCircle className="h-4 w-4 flex-shrink-0" /> : <Info className="h-4 w-4 flex-shrink-0" />}
            <span>{help}</span>
          </p>
        </div>
      ) : (
        <p className="flex gap-1.5 rounded-md bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-400">
          <Info className="h-4 w-4 flex-shrink-0" />
          <span>This bundle was taken before databases were backed up one by one: an instance restores whole, in place. {MODES.find((m) => m.mode === 'replace')?.help}</span>
        </p>
      )}

      {instances.map((inst) => (
        <div key={inst.deploymentId} className="rounded-md border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-2 dark:border-gray-700">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{inst.deploymentName}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {inst.engine ?? 'database'} · {inst.databases.length} database(s)
              </div>
            </div>
            <button
              type="button"
              disabled={!cartReady || addItem.isPending || !inst.available}
              onClick={() => addItem.mutate({
                type: 'databases-by-id',
                bundleId,
                selector: { kind: 'ids', deploymentIds: [inst.deploymentId], mode: effectiveMode },
                label: `All databases of ${inst.deploymentName} (${modeLabel(effectiveMode)})`,
              })}
              className="flex-shrink-0 rounded-md border border-brand-500 px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-brand-300 dark:hover:bg-brand-900"
            >
              Add all
            </button>
          </div>
          {!inst.available && inst.unavailableReason && (
            <p className="px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{inst.unavailableReason}</p>
          )}
          {perDatabase && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700">
              {inst.databases.map((d) => {
                const key = `${inst.deploymentId}:${d.name}`;
                const typed = (names[key] ?? '').trim();
                const nameOk = typed === '' || TARGET_NAME_RE.test(typed);
                return (
                  <li key={key} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-gray-900 dark:text-gray-100">{d.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {formatSize(d.sizeBytes)}{d.serverVersion ? ` · ${d.serverVersion}` : ''}
                      </div>
                    </div>
                    {effectiveMode === 'copy' && (
                      <input
                        type="text"
                        value={names[key] ?? ''}
                        onChange={(e) => setNames((prev) => ({ ...prev, [key]: e.target.value }))}
                        placeholder="new name (optional)"
                        aria-label={`New database name for ${d.name}`}
                        aria-invalid={!nameOk}
                        className={`w-44 rounded-md border px-2 py-1 text-xs dark:bg-gray-900 dark:text-gray-100 ${
                          nameOk ? 'border-gray-300 dark:border-gray-600' : 'border-red-500 dark:border-red-400'
                        }`}
                      />
                    )}
                    <AddBtn
                      disabled={!cartReady || addItem.isPending || !inst.available || !nameOk}
                      onClick={() => addItem.mutate({
                        type: 'databases-by-id',
                        bundleId,
                        selector: {
                          kind: 'databases',
                          deploymentId: inst.deploymentId,
                          databases: [{ name: d.name, ...(effectiveMode === 'copy' && typed ? { targetName: typed } : {}) }],
                          mode: effectiveMode,
                        },
                        label: `Database ${d.name} of ${inst.deploymentName} (${modeLabel(effectiveMode)}${effectiveMode === 'copy' && typed ? ` → ${typed}` : ''})`,
                      })}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {effectiveMode === 'copy' && perDatabase && (
            <p className="px-3 pb-2 text-xs text-gray-500 dark:text-gray-400">
              A new name: letters, digits and underscores, starting with a letter or underscore.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
