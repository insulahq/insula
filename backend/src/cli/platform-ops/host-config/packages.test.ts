import { describe, it, expect } from 'vitest';
import { convergePackages, packageNameValid, packageVersionValid } from './packages.js';
import { parsePackages } from './index.js';
import type { PackageDeps, PackageSpec } from './types.js';

type Installed = Record<string, string>; // name -> version (present = installed)

function fakeDeps(
  family: 'apt' | 'dnf' | null,
  installed: Installed = {},
): {
  deps: PackageDeps;
  installed: Installed;
  installs: Array<{ name: string; version: string | null }>;
} {
  const state: Installed = { ...installed };
  const installs: Array<{ name: string; version: string | null }> = [];
  const deps: PackageDeps = {
    readDesiredPackages: async () => null,
    detectFamily: () => family,
    queryInstalled: (name) => (name in state ? { installed: true, version: state[name] } : { installed: false, version: null }),
    installPackage: (_fam, name, version) => {
      installs.push({ name, version });
      state[name] = version ?? '1.0.0-installed';
    },
  };
  return { deps, installed: state, installs };
}

const specs = (...pairs: Array<[string, string | null]>): PackageSpec[] =>
  pairs.map(([name, version]) => ({ name, version }));

describe('packageNameValid', () => {
  it('accepts conventional dpkg/rpm names', () => {
    for (const n of ['curl', 'lib32z1', 'g++', 'python3.11', 'ca-certificates', 'gnupg2', 'NetworkManager']) {
      expect(packageNameValid(n)).toBe(true);
    }
  });
  it('rejects flag-injection, shell metas, paths, empties, oversize', () => {
    for (const n of ['', '-rf', '--allow-downgrades', 'a b', 'foo;bar', 'foo|bar', '$(x)', '../etc', 'foo/bar', '.hidden', 'foo\nbar']) {
      expect(packageNameValid(n)).toBe(false);
    }
    expect(packageNameValid('a'.repeat(201))).toBe(false);
  });
});

describe('packageVersionValid', () => {
  it('accepts dpkg/rpm version strings (epoch, tilde, plus, dotted)', () => {
    for (const v of ['1.2.3', '2:1.4.1-1ubuntu0.1', '7.68.0-1+deb10u3', '1.0~beta', '20230311ubuntu1']) {
      expect(packageVersionValid(v)).toBe(true);
    }
  });
  it('rejects flag-like / shell-meta / empty versions', () => {
    for (const v of ['', '-x', 'a b', '1.0;rm', '$(x)', '1.0\n2.0']) {
      expect(packageVersionValid(v)).toBe(false);
    }
  });
});

describe('parsePackages', () => {
  it('parses name and name=version lines, skipping comments/blank', () => {
    const out = parsePackages('# header\n; also\ncurl\njq = 1.6-2.1\n\nhtop=3.0.5\n');
    expect(out).toEqual([
      { name: 'curl', version: null },
      { name: 'jq', version: '1.6-2.1' },
      { name: 'htop', version: '3.0.5' },
    ]);
  });
  it('normalises a trailing "=" (no value) to "no pin", not an empty string', () => {
    expect(parsePackages('curl=')).toEqual([{ name: 'curl', version: null }]);
  });
});

describe('convergePackages', () => {
  it('absent desired → benign empty result', () => {
    const { deps } = fakeDeps('apt');
    const r = convergePackages(null, 'apt', true, deps);
    expect(r.desiredSource).toBe('absent');
    expect(r.items).toHaveLength(0);
  });

  it('no package manager on host → every entry "unsupported", never acts', () => {
    const { deps, installs } = fakeDeps(null);
    const r = convergePackages(specs(['curl', null]), null, true, deps);
    expect(r.family).toBeNull();
    expect(r.items[0].state).toBe('unsupported');
    expect(installs).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it('installs a missing package in enforce mode', () => {
    const { deps, installs, installed } = fakeDeps('apt');
    const r = convergePackages(specs(['curl', null]), 'apt', true, deps);
    expect(r.mode).toBe('enforce');
    expect(r.items[0].state).toBe('installed');
    expect(r.installedCount).toBe(1);
    expect(installs).toEqual([{ name: 'curl', version: null }]);
    expect(installed['curl']).toBeDefined();
  });

  it('dry-run reports would-install and installs nothing', () => {
    const { deps, installs } = fakeDeps('apt');
    const r = convergePackages(specs(['curl', null]), 'apt', false, deps);
    expect(r.mode).toBe('dry-run');
    expect(r.items[0].state).toBe('would-install');
    expect(r.installedCount).toBe(0);
    expect(installs).toHaveLength(0);
  });

  it('installs a missing pinned package with its version', () => {
    const { deps, installs } = fakeDeps('apt');
    const r = convergePackages(specs(['jq', '1.6-2.1']), 'apt', true, deps);
    expect(installs).toEqual([{ name: 'jq', version: '1.6-2.1' }]);
    expect(r.items[0].state).toBe('installed');
  });

  it('already-installed, no pin → ok, no action', () => {
    const { deps, installs } = fakeDeps('apt', { curl: '7.68.0' });
    const r = convergePackages(specs(['curl', null]), 'apt', true, deps);
    expect(r.items[0].state).toBe('ok');
    expect(installs).toHaveLength(0);
  });

  it('installed, pin matches → ok', () => {
    const { deps, installs } = fakeDeps('apt', { jq: '1.6-2.1' });
    const r = convergePackages(specs(['jq', '1.6-2.1']), 'apt', true, deps);
    expect(r.items[0].state).toBe('ok');
    expect(installs).toHaveLength(0);
  });

  it('installed, pin MISMATCHES → reported, NEVER auto-changed (no churn of live host)', () => {
    const { deps, installs } = fakeDeps('apt', { jq: '1.5' });
    const r = convergePackages(specs(['jq', '1.6-2.1']), 'apt', true, deps);
    expect(r.items[0].state).toBe('version-mismatch');
    expect(r.items[0].actualVersion).toBe('1.5');
    expect(installs).toHaveLength(0); // additive-only: a live downgrade/upgrade is never automatic
    expect(r.ok).toBe(true); // a pin drift is an advisory, not a runtime failure
  });

  it('NEVER acts on an invalid name/version, even in enforce mode', () => {
    const { deps, installs } = fakeDeps('apt');
    const r = convergePackages(
      specs(['-rf', null], ['foo;bar', null], ['curl', '$(x)']),
      'apt',
      true,
      deps,
    );
    expect(installs).toHaveLength(0);
    for (const it of r.items) expect(it.state).toBe('not-allowed');
  });

  it('refuses a suspiciously large policy wholesale (DoS guard), installing nothing', () => {
    const { deps, installs } = fakeDeps('apt');
    const many = Array.from({ length: 201 }, (_, i): [string, string | null] => [`pkg${i}`, null]);
    const r = convergePackages(specs(...many), 'apt', true, deps);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/201 packages.*cap/);
    expect(r.items).toHaveLength(0);
    expect(installs).toHaveLength(0);
  });

  it('records an install failure without halting later packages', () => {
    const { deps: base } = fakeDeps('apt');
    const state: Installed = {};
    const installs: Array<{ name: string; version: string | null }> = [];
    const deps: PackageDeps = {
      ...base,
      queryInstalled: (name) => (name in state ? { installed: true, version: state[name] } : { installed: false, version: null }),
      installPackage: (_f, name, version) => {
        if (name === 'curl') throw new Error('apt mirror unreachable');
        installs.push({ name, version });
        state[name] = version ?? 'x';
      },
    };
    const r = convergePackages(specs(['curl', null], ['jq', null]), 'apt', true, deps);
    expect(r.ok).toBe(false);
    expect(r.items[0].state).toBe('install-failed');
    expect(r.items[1].state).toBe('installed');
  });
});
