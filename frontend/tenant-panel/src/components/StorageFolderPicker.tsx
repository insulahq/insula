import { useMemo, useState } from 'react';
import { Loader2, Folder, FolderOpen, ChevronRight, CornerLeftUp, AlertTriangle, Check } from 'lucide-react';
import { useStorageFolders } from '@/hooks/use-deployments';
import { MAX_FOLDER_SEGMENTS, folderProblem } from '@insula/api-contracts';

/**
 * Browse the tenant's PVC and pick any folder on it.
 *
 * The deployment storage picker used to list one flat level under
 * `<type>/<code>`, so the only reachable folders were ones the platform had
 * created for that catalog entry. A tenant with an existing site directory
 * (`business.na`) or a shared media tree could not point a deployment at it.
 * This walks the whole tree instead, one level at a time.
 *
 * A folder another deployment already uses is offered WITH A WARNING rather
 * than disabled — sharing is legitimate for web content, and the tenant panel
 * already supports it through extra mounts. Two apps writing one *database*
 * directory is the case that corrupts, so the warning says so.
 */

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export interface StorageFolderPickerProps {
  readonly tenantId: string | undefined;
  /** Where browsing starts. '' is the PVC root. */
  readonly seedPath?: string;
  /** Currently selected folder, PVC-root-relative, or null. */
  readonly value: string | null;
  readonly onChange: (path: string | null) => void;
  /**
   * The deployment being edited, if any. Its own folder is shown as "current"
   * rather than as a conflict — warning someone off the folder they already
   * use would be nonsense.
   */
  readonly ownDeploymentName?: string;
  readonly testIdPrefix?: string;
}

export default function StorageFolderPicker({
  tenantId,
  seedPath = '',
  value,
  onChange,
  ownDeploymentName,
  testIdPrefix = 'folder-picker',
}: StorageFolderPickerProps) {
  const [browsePath, setBrowsePath] = useState(seedPath);
  const [newFolderName, setNewFolderName] = useState('');

  const { data, isLoading, isError } = useStorageFolders(tenantId, undefined, undefined, browsePath);
  const listing = data?.data;

  const segments = browsePath === '' ? [] : browsePath.split('/');
  const atMaxDepth = segments.length >= MAX_FOLDER_SEGMENTS;

  const newFolderPath = newFolderName
    ? (browsePath === '' ? newFolderName : `${browsePath}/${newFolderName}`)
    : null;

  const newFolderError = useMemo(() => {
    if (!newFolderName) return null;
    if (atMaxDepth) {
      return `Folders can be at most ${MAX_FOLDER_SEGMENTS} levels deep — go up a level to create one here.`;
    }
    return newFolderPath ? folderProblem(newFolderPath) : null;
  }, [newFolderName, newFolderPath, atMaxDepth]);

  const selectFolder = (path: string) => {
    setNewFolderName('');
    onChange(value === path ? null : path);
  };

  // The selected folder's row data, when it happens to be in the level we are
  // looking at. Used for the shared-folder and has-data notices below.
  const selectedRow = listing?.folders.find((f) => f.path === value);
  const conflictName = selectedRow?.usedByDeployment && selectedRow.usedByDeployment !== ownDeploymentName
    ? selectedRow.usedByDeployment
    : null;

  return (
    <div className="space-y-3" data-testid={testIdPrefix}>
      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => setBrowsePath('')}
          className="rounded px-1.5 py-0.5 font-mono text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30"
          data-testid={`${testIdPrefix}-crumb-root`}
        >
          storage root
        </button>
        {segments.map((seg, i) => (
          <span key={`${seg}-${i}`} className="flex items-center gap-1">
            <span className="text-gray-400 dark:text-gray-500">/</span>
            <button
              type="button"
              onClick={() => setBrowsePath(segments.slice(0, i + 1).join('/'))}
              className="rounded px-1.5 py-0.5 font-mono text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30"
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
        {/* Up one level */}
        {listing?.parentPath !== null && listing?.parentPath !== undefined && (
          <button
            type="button"
            onClick={() => setBrowsePath(listing.parentPath ?? '')}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            data-testid={`${testIdPrefix}-up`}
          >
            <CornerLeftUp size={14} className="shrink-0" />
            Up one level
          </button>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={14} className="animate-spin" />
            Loading folders…
          </div>
        )}

        {isError && (
          <div className="px-3 py-4 text-sm text-red-600 dark:text-red-400">
            Could not read your storage. Try again, or type a folder name below to create one.
          </div>
        )}

        {!isLoading && !isError && listing && listing.folders.length === 0 && (
          <div className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
            No folders here yet.
          </div>
        )}

        {!isLoading && !isError && listing?.folders.map((folder) => {
          const isSelected = value === folder.path;
          const usedByOther = folder.usedByDeployment !== null && folder.usedByDeployment !== ownDeploymentName;
          const isOwn = folder.usedByDeployment !== null && folder.usedByDeployment === ownDeploymentName;
          return (
            <div
              key={folder.path}
              className={`flex items-stretch ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
            >
              <button
                type="button"
                onClick={() => selectFolder(folder.path)}
                className="flex flex-1 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700/50 min-w-0"
                data-testid={`${testIdPrefix}-folder-${folder.name}`}
              >
                {isSelected
                  ? <Check size={14} className="shrink-0 text-blue-600 dark:text-blue-400" />
                  : <Folder size={14} className="shrink-0 text-gray-500 dark:text-gray-400" />}
                <span className="truncate font-medium text-gray-900 dark:text-gray-100">{folder.name}</span>
                {isOwn && (
                  <span className="shrink-0 rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                    current
                  </span>
                )}
                {usedByOther && (
                  <span className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-[11px] text-amber-800 dark:text-amber-300">
                    in use by {folder.usedByDeployment}
                  </span>
                )}
                {!folder.usedByDeployment && (
                  <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">
                    {folder.isEmpty ? 'empty' : 'has data'}
                  </span>
                )}
              </button>
              {folder.hasSubfolders && (
                <button
                  type="button"
                  onClick={() => { setBrowsePath(folder.path); setNewFolderName(''); }}
                  className="flex items-center px-3 text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:text-gray-600 dark:hover:text-gray-200"
                  aria-label={`Open ${folder.name}`}
                  title={`Open ${folder.name}`}
                  data-testid={`${testIdPrefix}-open-${folder.name}`}
                >
                  <ChevronRight size={16} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Select the folder we are standing in — the one a tenant reaches by
          drilling into an existing site directory. */}
      {browsePath !== '' && value !== browsePath && (
        <button
          type="button"
          onClick={() => selectFolder(browsePath)}
          className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
          data-testid={`${testIdPrefix}-select-current`}
        >
          Use this folder (<span className="font-mono">{browsePath}</span>)
        </button>
      )}

      {conflictName && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300" data-testid={`${testIdPrefix}-shared-warning`}>
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <strong>{conflictName}</strong> also uses this folder. Sharing is fine
            for web content, but two applications writing the same database
            directory will corrupt it.
          </div>
        </div>
      )}

      {selectedRow && !selectedRow.isEmpty && !conflictName && (
        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
          This folder already has data. The deployment will use it as-is.
        </div>
      )}

      {/* Create a new folder in the directory being browsed */}
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
          Or create a new folder here
        </label>
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 font-mono text-xs text-gray-400 dark:text-gray-500">
            {browsePath === '' ? '' : `${browsePath}/`}
          </span>
          <input
            type="text"
            maxLength={63}
            value={newFolderName}
            onChange={(e) => {
              setNewFolderName(e.target.value);
              const next = e.target.value
                ? (browsePath === '' ? e.target.value : `${browsePath}/${e.target.value}`)
                : null;
              onChange(next);
            }}
            className={INPUT_CLASS}
            placeholder="my-folder"
            disabled={atMaxDepth}
            data-testid={`${testIdPrefix}-new-folder-input`}
          />
        </div>
        {newFolderError && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400" data-testid={`${testIdPrefix}-new-folder-error`}>
            {newFolderError}
          </p>
        )}
      </div>

      {value && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2">
          <FolderOpen size={14} className="shrink-0 text-gray-500 dark:text-gray-400" />
          <span className="font-mono text-xs text-gray-900 dark:text-gray-100" data-testid={`${testIdPrefix}-selected`}>
            {value}
          </span>
        </div>
      )}
    </div>
  );
}
