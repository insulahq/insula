/**
 * Unit tests for the restic-native files-browse child-filter + sort.
 *
 * `restic ls <snap> <dir>` returns the whole subtree under <dir>; the
 * browse endpoint keeps only the DIRECT CHILDREN of the requested
 * directory and strips the `/source` capture-root prefix so the
 * api-contracts paths are relative DISPLAY paths.
 */

import { describe, it, expect } from 'vitest';
import { directChildren } from './browse-files-restic.js';
import type { ResticLsNode } from '../tenant-bundles/restic-driver.js';

function node(path: string, type: 'file' | 'dir', size = 0): ResticLsNode {
  return { path, type, size, mtime: '2026-06-14T00:00:00Z' };
}

describe('directChildren', () => {
  const tree: ResticLsNode[] = [
    node('/source', 'dir'),
    node('/source/var', 'dir'),
    node('/source/var/www', 'dir'),
    node('/source/var/www/index.php', 'file', 1234),
    node('/source/etc', 'dir'),
    node('/source/etc/app.conf', 'file', 99),
    node('/source/readme.txt', 'file', 10),
  ];

  it('lists the DIRECT CHILDREN of the root (path = "")', () => {
    const out = directChildren(tree, '');
    // Root children: var (dir), etc (dir), readme.txt (file). Dirs first,
    // then by name.
    expect(out.map((e) => e.name)).toEqual(['etc', 'var', 'readme.txt']);
    expect(out.map((e) => e.type)).toEqual(['dir', 'dir', 'file']);
  });

  it('strips the /source capture-root prefix → relative DISPLAY paths', () => {
    const out = directChildren(tree, '');
    const readme = out.find((e) => e.name === 'readme.txt');
    expect(readme?.path).toBe('readme.txt'); // no leading slash, no /source
  });

  it('lists DIRECT CHILDREN of a nested directory', () => {
    const out = directChildren(tree, 'var');
    expect(out.map((e) => e.path)).toEqual(['var/www']);
    expect(out[0]!.type).toBe('dir');
  });

  it('does not include grandchildren (only one level deep)', () => {
    const out = directChildren(tree, 'var');
    expect(out.find((e) => e.path === 'var/www/index.php')).toBeUndefined();
  });

  it('reports file size and 0 for dir size', () => {
    const out = directChildren(tree, 'etc');
    const conf = out.find((e) => e.name === 'app.conf');
    expect(conf).toEqual({ name: 'app.conf', path: 'etc/app.conf', type: 'file', size: 99 });
  });

  it('sorts dirs-first then by name', () => {
    const mixed: ResticLsNode[] = [
      node('/source/zeta', 'file', 1),
      node('/source/alpha', 'dir'),
      node('/source/beta', 'file', 2),
      node('/source/gamma', 'dir'),
    ];
    const out = directChildren(mixed, '');
    expect(out.map((e) => e.name)).toEqual(['alpha', 'gamma', 'beta', 'zeta']);
  });

  it('returns [] for a directory with no children in the node set', () => {
    expect(directChildren(tree, 'etc/app.conf')).toEqual([]);
  });
});
