/**
 * Repository URLs and archives are fetched on a timer now: a GitHub source only
 * on github.com, URLs in errors without credentials, archives with plain files only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPlainTree, inspectTarball, parseRepoUrl, redactUrl } from './github-catalog.js';

describe('parseRepoUrl', () => {
  it('is GitHub only on github.com', () => {
    expect(parseRepoUrl('https://github.com/insulahq/application-catalog')).toEqual({ type: 'github', owner: 'insulahq', repo: 'application-catalog' });
    expect(parseRepoUrl('https://github.com/insulahq/application-catalog.git/')).toEqual({ type: 'github', owner: 'insulahq', repo: 'application-catalog' });
    expect(parseRepoUrl('https://github.com/insulahq/application-catalog/tree/main')).toMatchObject({ type: 'github', owner: 'insulahq', repo: 'application-catalog' });
    expect(parseRepoUrl('git+https://github.com/insulahq/application-catalog.git')).toMatchObject({ type: 'github', repo: 'application-catalog' });
    expect(parseRepoUrl('http://10.0.0.5/github.com/a/b').type).toBe('http');
    expect(parseRepoUrl('https://github.com.example.test/a/b').type).toBe('http');
    expect(parseRepoUrl('https://catalog.example.test/x/')).toEqual({ type: 'http', baseUrl: 'https://catalog.example.test/x' });
  });
});

describe('redactUrl', () => {
  it('drops credentials, query and fragment', () => {
    expect(redactUrl('https://user:secret@catalog.example.test/c/catalog.json?token=abc#x')).toBe('https://catalog.example.test/c/catalog.json');
    expect(redactUrl('not a url')).toBe('(an unparseable URL)');
  });
});

describe('assertPlainTree', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('accepts plain files and directories', async () => {
    dir = await mkdtemp(join(tmpdir(), 'plain-'));
    await mkdir(join(dir, 'alpha'));
    await writeFile(join(dir, 'catalog.json'), '{}');
    await writeFile(join(dir, 'alpha', 'manifest.json'), '{}');
    await expect(assertPlainTree(dir)).resolves.toBeUndefined();
  });

  it('refuses a symlink anywhere in the tree, naming it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'plain-'));
    await mkdir(join(dir, 'alpha'));
    await writeFile(join(dir, 'catalog.json'), '{}');
    await symlink('/etc/hostname', join(dir, 'alpha', 'manifest.json'));
    await expect(assertPlainTree(dir)).rejects.toMatchObject({ code: 'INVALID_CATALOG', message: expect.stringContaining('alpha/manifest.json') });
  });
});

describe('inspectTarball', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  const tarball = async (build: (src: string) => Promise<void>): Promise<string> => {
    dir = await mkdtemp(join(tmpdir(), 'tarball-'));
    const src = join(dir, 'repo-abc123');
    await mkdir(join(src, 'alpha'), { recursive: true });
    await writeFile(join(src, 'catalog.json'), JSON.stringify({ entries: ['alpha'] }));
    await writeFile(join(src, 'alpha', 'manifest.json'), '{}');
    await build(src);
    const out = join(dir, 'repo.tar.gz');
    await promisify(execFile)('tar', ['czf', out, '-C', dir, 'repo-abc123']);
    return out;
  };

  it('passes an archive of plain files and directories', async () => {
    await expect(inspectTarball(await tarball(async () => {}))).resolves.toBeUndefined();
  });

  it('refuses a symlink or a hard link before anything is extracted', async () => {
    const withSymlink = await tarball(async (src) => { await symlink('/etc/hostname', join(src, 'alpha', 'icon.png')); });
    await expect(inspectTarball(withSymlink)).rejects.toMatchObject({ code: 'INVALID_CATALOG', message: expect.stringContaining('link or special file') });
    const withHardlink = await tarball(async (src) => { await link(join(src, 'catalog.json'), join(src, 'alpha', 'copy.json')); });
    await expect(inspectTarball(withHardlink)).rejects.toMatchObject({ code: 'INVALID_CATALOG' });
  });

  it('stops at the unpacked-size and entry limits', async () => {
    const big = await tarball(async (src) => { await writeFile(join(src, 'alpha', 'blob.bin'), Buffer.alloc(3 * 1024 * 1024)); });
    await expect(inspectTarball(big, 1024 * 1024)).rejects.toMatchObject({ message: expect.stringContaining('unpacks to more than 1 MB') });
    await expect(inspectTarball(big, 64 * 1024 * 1024, 3)).rejects.toMatchObject({ message: expect.stringContaining('more than 3 entries') });
  });
});
