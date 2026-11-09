/** The fields of a listing row that its order depends on. */
export interface SortableFileEntry {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size: number;
  readonly modifiedAt: string | null;
}

export type FileSortColumn = 'name' | 'size' | 'modifiedAt';
export type FileSortDirection = 'asc' | 'desc';

export interface FileSort {
  readonly column: FileSortColumn;
  readonly direction: FileSortDirection;
}

/**
 * Clicking the sorted column reverses it; clicking another column sorts it
 * ascending. Pure, so React may call it as often as it likes.
 */
export function nextFileSort(prev: FileSort, column: FileSortColumn): FileSort {
  if (prev.column !== column) return { column, direction: 'asc' };
  return { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
}

/** The header's `aria-sort`, so assistive tech hears which column sorts and which way. */
export function ariaSort(sort: FileSort, column: FileSortColumn): 'ascending' | 'descending' | 'none' {
  if (sort.column !== column) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

function compareNames(a: SortableFileEntry, b: SortableFileEntry): number {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

/**
 * The value a row sorts by, or null when the row shows none. A folder's
 * listed `size` is its directory inode (4096, 12288, …), which the Size
 * column never shows, so a folder sorts by the size calculated for it and
 * has no value until one is.
 */
function sortValue(
  entry: SortableFileEntry, column: 'size' | 'modifiedAt', folderBytes: (name: string) => number | undefined,
): number | null {
  if (column === 'size') {
    return entry.type === 'directory' ? folderBytes(entry.name) ?? null : entry.size;
  }
  if (!entry.modifiedAt) return null;
  const at = Date.parse(entry.modifiedAt);
  return Number.isNaN(at) ? null : at;
}

/**
 * Folders first, then files, each group ordered by the column. Rows without
 * a value sort last in either direction, and equal values fall back to the
 * name so the order is the same on every render.
 */
export function sortFileEntries<T extends SortableFileEntry>(
  entries: readonly T[],
  sort: FileSort,
  folderBytes: (name: string) => number | undefined = () => undefined,
): T[] {
  const dir = sort.direction === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    if (sort.column === 'name') return dir * compareNames(a, b);
    const va = sortValue(a, sort.column, folderBytes);
    const vb = sortValue(b, sort.column, folderBytes);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
      return compareNames(a, b);
    }
    return dir * (va - vb) || compareNames(a, b);
  });
}
