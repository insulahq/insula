import { describe, it, expect, vi } from 'vitest';
import type { Deps, DrBundleManifest, DrRescueOutcome, DrRestoreOutcome, DrRestoreRequest } from './deps.js';
import { parseDrArgs, drCommand } from './dr.js';

// ── Fixtures ────────────────────────────────────────────────────────────────
const MANIFEST: DrBundleManifest = {
  apexDomain: 'staging.example.net',
  clusterName: 'staging',
  platformVersion: '2026.6.2',
  createdAt: '2026-06-01T12:00:00.000Z',
  bundleTopology: 'single',
  cnpgClusters: [
    { namespace: 'platform-system', clusterName: 'system-db', serverName: 'system-db', objectStoreName: 'system-db-store' },
  ],
  secretYamlCount: 7,
};

function fakeDeps(over: Partial<Deps> = {}, drOver: Partial<Deps['dr']> = {}): {
  deps: Deps; out: string[]; err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const deps: Deps = {
    env: {},
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    versionFromDb: vi.fn(async () => null),
    readFile: vi.fn(() => null),
    buildVersion: '2026.6.2',
    dr: {
      verifyBundle: vi.fn(async () => MANIFEST),
      runRestore: vi.fn(async (): Promise<DrRestoreOutcome> => ({ ok: true, bundleInfo: MANIFEST, summary: ['done'] })),
      rescue: vi.fn(async (): Promise<DrRescueOutcome> => ({ ok: true, snapshots: [] })),
      ...drOver,
    },
    snapshot: {
      capture: vi.fn(async () => ({ ok: true })),
      list: vi.fn(async () => ({ ok: true, backups: [] })),
    },
    ...over,
  };
  return { deps, out, err };
}

// ── parseDrArgs ──────────────────────────────────────────────────────────────
describe('parseDrArgs', () => {
  it('rejects a missing subcommand', () => {
    const r = parseDrArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe(2); expect(r.message).toMatch(/subcommand/i); }
  });

  it('rejects an unknown subcommand', () => {
    const r = parseDrArgs(['frobnicate']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(2);
  });

  describe('verify', () => {
    it('requires --bundle', () => {
      const r = parseDrArgs(['verify', '--age-key', '/k']);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.code).toBe(2); expect(r.message).toMatch(/--bundle/); }
    });

    it('requires --age-key', () => {
      const r = parseDrArgs(['verify', '--bundle', '/b']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/--age-key/);
    });

    it('parses a minimal verify', () => {
      const r = parseDrArgs(['verify', '--bundle', '/b.tar.age', '--age-key', '/op.key']);
      expect(r.ok).toBe(true);
      if (r.ok && r.sub === 'verify') {
        expect(r.bundlePath).toBe('/b.tar.age');
        expect(r.ageKeyPath).toBe('/op.key');
        expect(r.ageBinary).toBeUndefined();
      }
    });

    it('accepts --age-binary', () => {
      const r = parseDrArgs(['verify', '--bundle', '/b', '--age-key', '/k', '--age-binary', '/usr/bin/age']);
      expect(r.ok).toBe(true);
      if (r.ok && r.sub === 'verify') expect(r.ageBinary).toBe('/usr/bin/age');
    });

    it('rejects an unknown flag', () => {
      const r = parseDrArgs(['verify', '--bundle', '/b', '--age-key', '/k', '--frob']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(2);
    });

    it('rejects a value-flag with no value', () => {
      const r = parseDrArgs(['verify', '--bundle']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/requires a value/);
    });

    it('treats a following --flag as a missing value (not the value)', () => {
      const r = parseDrArgs(['verify', '--bundle', '--age-key']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/requires a value/);
    });
  });

  describe('restore', () => {
    it('requires --mode', () => {
      const r = parseDrArgs(['restore', '--bundle', '/b', '--age-key', '/k']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/--mode/);
    });

    it('rejects an invalid --mode', () => {
      const r = parseDrArgs(['restore', '--bundle', '/b', '--age-key', '/k', '--mode', 'sideways']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(2);
    });

    it('parses a minimal partial restore (strict off)', () => {
      const r = parseDrArgs(['restore', '--bundle', '/b', '--age-key', '/k', '--mode', 'partial']);
      expect(r.ok).toBe(true);
      if (r.ok && r.sub === 'restore') {
        expect(r.req.mode).toBe('partial');
        expect(r.req.strict).toBe(false);
        // The discriminated union: a partial request carries no confirmations.
        expect('confirmClusterNames' in r.req).toBe(false);
      }
    });

    it('rejects a value-flag with no value (restore)', () => {
      const r = parseDrArgs(['restore', '--bundle', '--age-key']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/requires a value/);
    });

    it('sets --strict', () => {
      const r = parseDrArgs(['restore', '--bundle', '/b', '--age-key', '/k', '--mode', 'partial', '--strict']);
      expect(r.ok).toBe(true);
      if (r.ok && r.sub === 'restore') expect(r.req.strict).toBe(true);
    });

    it('full mode requires --target-mail-node', () => {
      const r = parseDrArgs(['restore', '--bundle', '/b', '--age-key', '/k', '--mode', 'full', '--confirm-cluster', 'system-db']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/--target-mail-node/);
    });

    it('full mode requires at least one --confirm-cluster', () => {
      const r = parseDrArgs(['restore', '--bundle', '/b', '--age-key', '/k', '--mode', 'full', '--target-mail-node', 'node-1']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/--confirm-cluster/);
    });

    it('parses a full restore with confirmations (key === value)', () => {
      const r = parseDrArgs([
        'restore', '--bundle', '/b', '--age-key', '/k', '--mode', 'full',
        '--target-mail-node', 'node-1',
        '--confirm-cluster', 'system-db', '--confirm-cluster', 'tenant-db',
      ]);
      expect(r.ok).toBe(true);
      if (r.ok && r.sub === 'restore') {
        expect(r.req.mode).toBe('full');
        expect(r.req.targetMailNode).toBe('node-1');
        expect(r.req.confirmClusterNames.get('system-db')).toBe('system-db');
        expect(r.req.confirmClusterNames.get('tenant-db')).toBe('tenant-db');
      }
    });

    it('passes through --kubeconfig + --age-binary', () => {
      const r = parseDrArgs([
        'restore', '--bundle', '/b', '--age-key', '/k', '--mode', 'partial',
        '--kubeconfig', '/kc', '--age-binary', '/age',
      ]);
      expect(r.ok).toBe(true);
      if (r.ok && r.sub === 'restore') {
        expect(r.req.kubeconfig).toBe('/kc');
        expect(r.req.ageBinary).toBe('/age');
      }
    });
  });
});

// ── drCommand: verify ────────────────────────────────────────────────────────
describe('drCommand verify', () => {
  it('prints the manifest and exits 0', async () => {
    const { deps, out } = fakeDeps();
    const code = await drCommand(['verify', '--bundle', '/b', '--age-key', '/k'], deps);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('staging.example.net');
    expect(text).toContain('2026.6.2');
    expect(text).toContain('system-db');
  });

  it('emits machine JSON with --json', async () => {
    const { deps, out } = fakeDeps();
    const code = await drCommand(['verify', '--bundle', '/b', '--age-key', '/k', '--json'], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.apexDomain).toBe('staging.example.net');
    expect(parsed.secretYamlCount).toBe(7);
  });

  it('maps a decrypt failure to a label and exits 1', async () => {
    const boom = Object.assign(new Error('Failed to decrypt bundle: age exit 1: /secret/op.key bad'), { name: 'BundleDecryptError' });
    const { deps, err } = fakeDeps({}, { verifyBundle: vi.fn(async () => { throw boom; }) });
    const code = await drCommand(['verify', '--bundle', '/b', '--age-key', '/k'], deps);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/DECRYPT_ERROR/);
  });

  it('does NOT leak the error body in --json (label only)', async () => {
    const boom = Object.assign(new Error('Failed to decrypt bundle: age exit 1: /secret/op.key bad'), { name: 'BundleDecryptError' });
    const { deps, out } = fakeDeps({}, { verifyBundle: vi.fn(async () => { throw boom; }) });
    const code = await drCommand(['verify', '--bundle', '/b', '--age-key', '/k', '--json'], deps);
    expect(code).toBe(1);
    const joined = out.join('\n');
    expect(joined).not.toContain('/secret/op.key');
    expect(JSON.parse(joined)).toEqual({ ok: false, errorCode: 'DECRYPT_ERROR' });
  });

  it('labels a legacy bundle', async () => {
    const boom = Object.assign(new Error('Bundle predates A2'), { name: 'LegacyBundleError' });
    const { deps, err } = fakeDeps({}, { verifyBundle: vi.fn(async () => { throw boom; }) });
    const code = await drCommand(['verify', '--bundle', '/b', '--age-key', '/k'], deps);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/LEGACY_BUNDLE/);
  });
});

// ── drCommand: restore ───────────────────────────────────────────────────────
describe('drCommand restore', () => {
  it('runs a partial restore and exits 0', async () => {
    const runRestore = vi.fn(async (): Promise<DrRestoreOutcome> => ({
      ok: true, bundleInfo: MANIFEST, summary: ['imported 12 backup_configurations rows (read-only)'],
    }));
    const { deps, out } = fakeDeps({}, { runRestore });
    const code = await drCommand(['restore', '--bundle', '/b', '--age-key', '/k', '--mode', 'partial'], deps);
    expect(code).toBe(0);
    const req = runRestore.mock.calls[0][0] as DrRestoreRequest;
    expect(req.mode).toBe('partial');
    expect(out.join('\n')).toContain('imported 12 backup_configurations');
  });

  it('surfaces drift notes as warnings on success', async () => {
    const runRestore = vi.fn(async (): Promise<DrRestoreOutcome> => ({
      ok: true, bundleInfo: MANIFEST, summary: ['ok'], driftNotes: ['apex domain differs: bundle=a live=b'],
    }));
    const { deps, err } = fakeDeps({}, { runRestore });
    const code = await drCommand(['restore', '--bundle', '/b', '--age-key', '/k', '--mode', 'partial'], deps);
    expect(code).toBe(0);
    expect(err.join('\n')).toMatch(/drift/i);
    expect(err.join('\n')).toContain('apex domain differs');
  });

  it('passes confirmations through for a full restore', async () => {
    const runRestore = vi.fn(async (): Promise<DrRestoreOutcome> => ({ ok: true, bundleInfo: MANIFEST, summary: ['ok'] }));
    const { deps } = fakeDeps({}, { runRestore });
    const code = await drCommand([
      'restore', '--bundle', '/b', '--age-key', '/k', '--mode', 'full',
      '--target-mail-node', 'node-1', '--confirm-cluster', 'system-db',
    ], deps);
    expect(code).toBe(0);
    const req = runRestore.mock.calls[0][0] as DrRestoreRequest;
    expect(req.mode).toBe('full');
    expect(req.targetMailNode).toBe('node-1');
    expect(req.confirmClusterNames.get('system-db')).toBe('system-db');
  });

  it('reports a restore failure (errorCode + exit 1)', async () => {
    const runRestore = vi.fn(async (): Promise<DrRestoreOutcome> => ({
      ok: false, errorCode: 'CNPG_RECOVERY_ERROR', detail: 'promote timed out on system-db',
    }));
    const { deps, err } = fakeDeps({}, { runRestore });
    const code = await drCommand(['restore', '--bundle', '/b', '--age-key', '/k', '--mode', 'partial'], deps);
    expect(code).toBe(1);
    const text = err.join('\n');
    expect(text).toMatch(/CNPG_RECOVERY_ERROR/);
    expect(text).toContain('promote timed out');
  });

  it('emits failure JSON with only the label (no detail leak)', async () => {
    const runRestore = vi.fn(async (): Promise<DrRestoreOutcome> => ({
      ok: false, errorCode: 'DECRYPT_ERROR', detail: '/secret/op.key bad',
    }));
    const { deps, out } = fakeDeps({}, { runRestore });
    const code = await drCommand(['restore', '--bundle', '/b', '--age-key', '/k', '--mode', 'partial', '--json'], deps);
    expect(code).toBe(1);
    const joined = out.join('\n');
    expect(joined).not.toContain('/secret/op.key');
    expect(JSON.parse(joined)).toEqual({ ok: false, errorCode: 'DECRYPT_ERROR' });
  });

  it('returns a usage error (exit 2) without calling runRestore', async () => {
    const runRestore = vi.fn(async (): Promise<DrRestoreOutcome> => ({ ok: true }));
    const { deps, err } = fakeDeps({}, { runRestore });
    const code = await drCommand(['restore', '--bundle', '/b', '--age-key', '/k'], deps); // no --mode
    expect(code).toBe(2);
    expect(runRestore).not.toHaveBeenCalled();
    expect(err.join('\n')).toMatch(/--mode/);
  });
});

// ── parseDrArgs: rescue ──────────────────────────────────────────────────────
describe('parseDrArgs rescue', () => {
  it('parses a bare rescue (snapshot all system volumes)', () => {
    const r = parseDrArgs(['rescue']);
    expect(r.ok).toBe(true);
    if (r.ok && r.sub === 'rescue') {
      expect(r.req.volume).toBeUndefined();
      expect(r.req.label).toBeUndefined();
    }
  });

  it('parses --volume + --label + --kubeconfig', () => {
    const r = parseDrArgs(['rescue', '--volume', 'pvc-abc', '--label', 'pre-upgrade', '--kubeconfig', '/kc']);
    expect(r.ok).toBe(true);
    if (r.ok && r.sub === 'rescue') {
      expect(r.req.volume).toBe('pvc-abc');
      expect(r.req.label).toBe('pre-upgrade');
      expect(r.req.kubeconfig).toBe('/kc');
    }
  });

  it('ignores --json (consumed by the command layer)', () => {
    const r = parseDrArgs(['rescue', '--json']);
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown flag', () => {
    const r = parseDrArgs(['rescue', '--frob']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(2);
  });

  it('rejects a value-flag with no value', () => {
    const r = parseDrArgs(['rescue', '--volume']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/requires a value/);
  });
});

// ── drCommand: rescue ────────────────────────────────────────────────────────
describe('drCommand rescue', () => {
  it('snapshots system volumes and exits 0', async () => {
    const rescue = vi.fn(async (): Promise<DrRescueOutcome> => ({
      ok: true,
      snapshots: [
        { volumeName: 'pvc-1', namespace: 'platform-system', pvcName: 'system-db-1', snapshotName: 'manual-1-pvc-1' },
        { volumeName: 'pvc-2', namespace: 'mail', pvcName: 'stalwart-data', snapshotName: 'manual-1-pvc-2' },
      ],
    }));
    const { deps, out } = fakeDeps({}, { rescue });
    const code = await drCommand(['rescue'], deps);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('manual-1-pvc-1');
    expect(text).toContain('stalwart-data');
  });

  it('passes --volume + --label through to the seam', async () => {
    const rescue = vi.fn(async (): Promise<DrRescueOutcome> => ({ ok: true, snapshots: [] }));
    const { deps } = fakeDeps({}, { rescue });
    await drCommand(['rescue', '--volume', 'pvc-9', '--label', 'pre-restore'], deps);
    expect(rescue).toHaveBeenCalledWith(expect.objectContaining({ volume: 'pvc-9', label: 'pre-restore' }));
  });

  it('emits machine JSON with --json', async () => {
    const rescue = vi.fn(async (): Promise<DrRescueOutcome> => ({
      ok: true, snapshots: [{ volumeName: 'pvc-1', namespace: 'platform-system', pvcName: 'system-db-1', snapshotName: 'manual-1-pvc-1' }],
    }));
    const { deps, out } = fakeDeps({}, { rescue });
    const code = await drCommand(['rescue', '--json'], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.ok).toBe(true);
    expect(parsed.snapshots[0].snapshotName).toBe('manual-1-pvc-1');
  });

  it('reports per-volume failures as warnings and exits 1', async () => {
    const rescue = vi.fn(async (): Promise<DrRescueOutcome> => ({
      ok: true,
      snapshots: [{ volumeName: 'pvc-1', namespace: 'platform-system', pvcName: 'system-db-1', snapshotName: 'manual-1-pvc-1' }],
      failures: [{ volumeName: 'pvc-2', reason: 'timeout creating Snapshot CR' }],
    }));
    const { deps, err } = fakeDeps({}, { rescue });
    const code = await drCommand(['rescue'], deps);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/pvc-2/);
    expect(err.join('\n')).toMatch(/timeout/);
  });

  it('maps an enumeration failure to errorCode + exit 1', async () => {
    const rescue = vi.fn(async (): Promise<DrRescueOutcome> => ({ ok: false, errorCode: 'RESCUE_ERROR', detail: 'cluster unreachable' }));
    const { deps, err } = fakeDeps({}, { rescue });
    const code = await drCommand(['rescue'], deps);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/RESCUE_ERROR/);
  });

  it('does NOT leak detail in --json on failure (label only)', async () => {
    const rescue = vi.fn(async (): Promise<DrRescueOutcome> => ({ ok: false, errorCode: 'RESCUE_ERROR', detail: 'postgres://u:p@h/db unreachable' }));
    const { deps, out } = fakeDeps({}, { rescue });
    const code = await drCommand(['rescue', '--json'], deps);
    expect(code).toBe(1);
    const joined = out.join('\n');
    expect(joined).not.toContain('u:p@h');
    expect(JSON.parse(joined)).toEqual({ ok: false, errorCode: 'RESCUE_ERROR' });
  });

  it('reports "no system volumes" cleanly (exit 0)', async () => {
    const rescue = vi.fn(async (): Promise<DrRescueOutcome> => ({ ok: true, snapshots: [] }));
    const { deps, out } = fakeDeps({}, { rescue });
    const code = await drCommand(['rescue'], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/no system volumes|0 /i);
  });
});
