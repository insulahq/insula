import { describe, it, expect } from 'vitest';
import { sortFileEntries, nextFileSort, ariaSort, type SortableFileEntry, type FileSort } from './sort-file-entries';

const dir = (name: string, size: number, modifiedAt: string | null = '2026-01-01T00:00:00.000Z'): SortableFileEntry =>
  ({ name, type: 'directory', size, modifiedAt });
const file = (name: string, size: number, modifiedAt: string | null = '2026-01-01T00:00:00.000Z'): SortableFileEntry =>
  ({ name, type: 'file', size, modifiedAt });
const names = (rows: readonly SortableFileEntry[]): string[] => rows.map((r) => r.name);
const by = (column: FileSort['column'], direction: FileSort['direction']): FileSort => ({ column, direction });

describe('sortFileEntries by size', () => {
  // A folder's listed size is its directory inode: it grows with the number of
  // entries, not with what the folder holds, and the Size column never shows it.
  const listing = [
    dir('big-media', 4096), dir('cache', 36864), dir('empty', 4096), dir('vendor', 12288),
    file('b.txt', 10), file('a.log', 2_000_000), file('c.zip', 300),
  ];

  it('orders files by their bytes, both ways', () => {
    expect(names(sortFileEntries(listing, by('size', 'asc'))).slice(4)).toEqual(['b.txt', 'c.zip', 'a.log']);
    expect(names(sortFileEntries(listing, by('size', 'desc'))).slice(4)).toEqual(['a.log', 'c.zip', 'b.txt']);
  });

  it('never orders folders by their inode size', () => {
    // No size calculated yet: nothing to order by, so folders stay by name either way.
    expect(names(sortFileEntries(listing, by('size', 'asc'))).slice(0, 4)).toEqual(['big-media', 'cache', 'empty', 'vendor']);
    expect(names(sortFileEntries(listing, by('size', 'desc'))).slice(0, 4)).toEqual(['big-media', 'cache', 'empty', 'vendor']);
  });

  it('orders folders by their calculated size, uncalculated ones last in either direction', () => {
    const calculated: Record<string, number> = { 'big-media': 9_000_000_000, empty: 0, vendor: 40_000_000 };
    const bytes = (n: string): number | undefined => calculated[n];
    expect(names(sortFileEntries(listing, by('size', 'asc'), bytes)).slice(0, 4)).toEqual(['empty', 'vendor', 'big-media', 'cache']);
    expect(names(sortFileEntries(listing, by('size', 'desc'), bytes)).slice(0, 4)).toEqual(['big-media', 'vendor', 'empty', 'cache']);
  });

  it('keeps folders ahead of files in both directions', () => {
    for (const direction of ['asc', 'desc'] as const) {
      const types = sortFileEntries(listing, by('size', direction)).map((r) => r.type);
      expect(types).toEqual(['directory', 'directory', 'directory', 'directory', 'file', 'file', 'file']);
    }
  });
});

describe('sortFileEntries by date', () => {
  const listing = [
    file('old.txt', 1, '2024-03-01T10:00:00.000Z'),
    file('broken-link', 0, null),
    file('new.txt', 1, '2026-11-06T09:30:00.000Z'),
    file('mid.txt', 1, '2025-06-15T12:00:00.000Z'),
    dir('uploads', 4096, '2026-11-01T00:00:00.000Z'),
    dir('assets', 4096, '2023-01-01T00:00:00.000Z'),
  ];

  it('orders by the instant, both ways, folders first', () => {
    expect(names(sortFileEntries(listing, by('modifiedAt', 'asc')))).toEqual(['assets', 'uploads', 'old.txt', 'mid.txt', 'new.txt', 'broken-link']);
    expect(names(sortFileEntries(listing, by('modifiedAt', 'desc')))).toEqual(['uploads', 'assets', 'new.txt', 'mid.txt', 'old.txt', 'broken-link']);
  });

  it('sorts a row without a date last in either direction', () => {
    expect(names(sortFileEntries(listing, by('modifiedAt', 'asc'))).at(-1)).toBe('broken-link');
    expect(names(sortFileEntries(listing, by('modifiedAt', 'desc'))).at(-1)).toBe('broken-link');
  });
});

describe('sortFileEntries ties', () => {
  // An extracted archive or a git checkout gives many files the same mtime and size.
  const same = '2026-11-06T08:00:00.000Z';
  const listing = [file('zeta.php', 512, same), file('Alpha.php', 512, same), file('mu.php', 512, same)];

  it('falls back to the name, whatever order the listing arrived in', () => {
    for (const column of ['size', 'modifiedAt'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        expect(names(sortFileEntries(listing, by(column, direction)))).toEqual(['Alpha.php', 'mu.php', 'zeta.php']);
        expect(names(sortFileEntries([...listing].reverse(), by(column, direction)))).toEqual(['Alpha.php', 'mu.php', 'zeta.php']);
      }
    }
  });

  it('does not reorder its input', () => {
    const input = [file('b', 2), file('a', 1)];
    sortFileEntries(input, by('size', 'asc'));
    expect(names(input)).toEqual(['b', 'a']);
  });
});

describe('sortFileEntries by name', () => {
  it('ignores case and reverses on desc', () => {
    const listing = [file('beta', 1), file('Alpha', 1), dir('zz', 4096), file('gamma', 1)];
    expect(names(sortFileEntries(listing, by('name', 'asc')))).toEqual(['zz', 'Alpha', 'beta', 'gamma']);
    expect(names(sortFileEntries(listing, by('name', 'desc')))).toEqual(['zz', 'gamma', 'beta', 'Alpha']);
  });
});

describe('nextFileSort', () => {
  it('reverses the sorted column and starts another one ascending', () => {
    expect(nextFileSort(by('size', 'asc'), 'size')).toEqual(by('size', 'desc'));
    expect(nextFileSort(by('size', 'desc'), 'size')).toEqual(by('size', 'asc'));
    expect(nextFileSort(by('size', 'desc'), 'modifiedAt')).toEqual(by('modifiedAt', 'asc'));
  });

});

describe('ariaSort', () => {
  it('names the direction on the sorted column only', () => {
    expect(ariaSort(by('size', 'asc'), 'size')).toBe('ascending');
    expect(ariaSort(by('size', 'desc'), 'size')).toBe('descending');
    expect(ariaSort(by('size', 'desc'), 'name')).toBe('none');
  });
});
