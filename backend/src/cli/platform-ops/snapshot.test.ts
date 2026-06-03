import { describe, it, expect, vi } from 'vitest';
import type { Deps, SnapshotCaptureOutcome, SnapshotListOutcome } from './deps.js';
import { parseSnapshotArgs, snapshotCommand } from './snapshot.js';

function fakeDeps(snapOver: Partial<Deps['snapshot']> = {}): { deps: Deps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: Deps = {
    env: {},
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    versionFromDb: vi.fn(async () => null),
    migrationsStatus: vi.fn(async () => ({ dbReachable: true, items: [] })),
    applyMigrations: vi.fn(async () => ({ ok: true, ran: true, dryRun: false, applied: 0, pending: 0, failed: false, outcomes: [] })),
    readFile: vi.fn(() => null),
    buildVersion: '2026.6.2',
    dr: {
      verifyBundle: vi.fn(async () => { throw new Error('not used'); }),
      runRestore: vi.fn(async () => ({ ok: true })),
      rescue: vi.fn(async () => ({ ok: true, snapshots: [] })),
    },
    snapshot: {
      capture: vi.fn(async (): Promise<SnapshotCaptureOutcome> => ({
        ok: true, backup: { backupName: 'on-demand-1', namespace: 'platform-system', clusterName: 'system-db', createdAt: '2026-06-02T00:00:00.000Z' },
      })),
      list: vi.fn(async (): Promise<SnapshotListOutcome> => ({ ok: true, backups: [] })),
      ...snapOver,
    },
  };
  return { deps, out, err };
}

// ── parseSnapshotArgs ────────────────────────────────────────────────────────
describe('parseSnapshotArgs', () => {
  it('rejects a missing subcommand', () => {
    const r = parseSnapshotArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe(2); expect(r.message).toMatch(/subcommand/i); }
  });

  it('rejects an unknown subcommand', () => {
    const r = parseSnapshotArgs(['frobnicate']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(2);
  });

  describe('capture', () => {
    it('defaults to the system DB (platform/system-db)', () => {
      const r = parseSnapshotArgs(['capture']);
      expect(r.ok).toBe(true);
      if (r.ok && r.sub === 'capture') {
        expect(r.req.namespace).toBe('platform');
        expect(r.req.clusterName).toBe('system-db');
        expect(r.req.description).toBeUndefined();
      }
    });

    it('accepts --cluster + --namespace + --description + --kubeconfig', () => {
      const r = parseSnapshotArgs([
        'capture', '--cluster', 'tenant-db', '--namespace', 'tenants',
        '--description', 'before import', '--kubeconfig', '/kc',
      ]);
      expect(r.ok).toBe(true);
      if (r.ok && r.sub === 'capture') {
        expect(r.req.clusterName).toBe('tenant-db');
        expect(r.req.namespace).toBe('tenants');
        expect(r.req.description).toBe('before import');
        expect(r.req.kubeconfig).toBe('/kc');
      }
    });

    it('rejects an unknown flag', () => {
      const r = parseSnapshotArgs(['capture', '--frob']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(2);
    });

    it('rejects an over-length --description (>256 chars)', () => {
      const r = parseSnapshotArgs(['capture', '--description', 'x'.repeat(257)]);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.code).toBe(2); expect(r.message).toMatch(/256/); }
    });

    it('accepts a 256-char --description (boundary)', () => {
      const r = parseSnapshotArgs(['capture', '--description', 'x'.repeat(256)]);
      expect(r.ok).toBe(true);
    });

    it('rejects a value-flag with no value', () => {
      const r = parseSnapshotArgs(['capture', '--cluster']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/requires a value/);
    });

    it('treats a following --flag as a missing value', () => {
      const r = parseSnapshotArgs(['capture', '--cluster', '--namespace']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/requires a value/);
    });
  });

  describe('list', () => {
    it('defaults to the system object store (platform/system-postgres-objectstore)', () => {
      const r = parseSnapshotArgs(['list']);
      expect(r.ok).toBe(true);
      if (r.ok && r.sub === 'list') {
        expect(r.req.namespace).toBe('platform');
        expect(r.req.objectStoreName).toBe('system-postgres-objectstore');
      }
    });

    it('accepts --namespace + --object-store + --kubeconfig', () => {
      const r = parseSnapshotArgs(['list', '--namespace', 'tenants', '--object-store', 'tenant-store', '--kubeconfig', '/kc']);
      expect(r.ok).toBe(true);
      if (r.ok && r.sub === 'list') {
        expect(r.req.namespace).toBe('tenants');
        expect(r.req.objectStoreName).toBe('tenant-store');
        expect(r.req.kubeconfig).toBe('/kc');
      }
    });

    it('ignores --json', () => {
      const r = parseSnapshotArgs(['list', '--json']);
      expect(r.ok).toBe(true);
    });

    it('rejects an unknown flag', () => {
      const r = parseSnapshotArgs(['list', '--frob']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(2);
    });
  });
});

// ── snapshotCommand: capture ─────────────────────────────────────────────────
describe('snapshotCommand capture', () => {
  it('creates a backup and exits 0', async () => {
    const { deps, out } = fakeDeps();
    const code = await snapshotCommand(['capture'], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('on-demand-1');
    expect(out.join('\n')).toContain('system-db');
  });

  it('emits machine JSON with --json', async () => {
    const { deps, out } = fakeDeps();
    const code = await snapshotCommand(['capture', '--json'], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.ok).toBe(true);
    expect(parsed.backup.backupName).toBe('on-demand-1');
  });

  it('passes description through to the seam', async () => {
    const capture = vi.fn(async (): Promise<SnapshotCaptureOutcome> => ({ ok: true, backup: { backupName: 'b', namespace: 'platform-system', clusterName: 'system-db', createdAt: 't' } }));
    const { deps } = fakeDeps({ capture });
    await snapshotCommand(['capture', '--description', 'pre-upgrade acme'], deps);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ description: 'pre-upgrade acme' }));
  });

  it('maps a capture failure to errorCode + exit 1', async () => {
    const capture = vi.fn(async (): Promise<SnapshotCaptureOutcome> => ({ ok: false, errorCode: 'PRECONDITION_FAILED', detail: 'no enabled barman-cloud plugin' }));
    const { deps, err } = fakeDeps({ capture });
    const code = await snapshotCommand(['capture'], deps);
    expect(code).toBe(1);
    const text = err.join('\n');
    expect(text).toMatch(/PRECONDITION_FAILED/);
    expect(text).toContain('barman-cloud');
  });

  it('does NOT leak detail in --json on failure (label only)', async () => {
    const capture = vi.fn(async (): Promise<SnapshotCaptureOutcome> => ({ ok: false, errorCode: 'BACKUP_ERROR', detail: 'postgres://u:p@h/db boom' }));
    const { deps, out } = fakeDeps({ capture });
    const code = await snapshotCommand(['capture', '--json'], deps);
    expect(code).toBe(1);
    const joined = out.join('\n');
    expect(joined).not.toContain('u:p@h');
    expect(JSON.parse(joined)).toEqual({ ok: false, errorCode: 'BACKUP_ERROR' });
  });

  it('returns a usage error (exit 2) without calling capture', async () => {
    const capture = vi.fn(async (): Promise<SnapshotCaptureOutcome> => ({ ok: true }));
    const { deps } = fakeDeps({ capture });
    const code = await snapshotCommand(['capture', '--cluster'], deps); // missing value
    expect(code).toBe(2);
    expect(capture).not.toHaveBeenCalled();
  });
});

// ── snapshotCommand: list ────────────────────────────────────────────────────
describe('snapshotCommand list', () => {
  it('lists backups and exits 0', async () => {
    const list = vi.fn(async (): Promise<SnapshotListOutcome> => ({
      ok: true,
      objectStoreName: 'system-db-store',
      namespace: 'platform-system',
      backups: [
        { backupId: '20260601T120000', status: 'COMPLETED', startedAt: '2026-06-01T12:00:00Z', endedAt: '2026-06-01T12:01:00Z', dataSizeBytes: 1048576, description: 'nightly', kind: 'scheduled' },
        { backupId: '20260602T030000', status: 'COMPLETED', startedAt: '2026-06-02T03:00:00Z', endedAt: null, dataSizeBytes: null, description: null, kind: 'on-demand' },
      ],
    }));
    const { deps, out } = fakeDeps({ list });
    const code = await snapshotCommand(['list'], deps);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('20260601T120000');
    expect(text).toContain('20260602T030000');
    expect(text).toContain('COMPLETED');
  });

  it('strips control / ANSI-escape bytes from a cluster-sourced description before terminal echo', async () => {
    const list = vi.fn(async (): Promise<SnapshotListOutcome> => ({
      ok: true,
      backups: [{ backupId: '20260601T120000', status: 'COMPLETED', startedAt: null, endedAt: null, dataSizeBytes: 10, description: 'evil\x1b[2Jwipe', kind: 'on-demand' }],
    }));
    const { deps, out } = fakeDeps({ list });
    await snapshotCommand(['list'], deps);
    const text = out.join('\n');
    expect(text).not.toContain('\x1b');
    expect(text).toContain('evil?[2Jwipe'); // escape byte replaced with '?'
  });

  it('keeps the RAW description in --json (machines, not terminals)', async () => {
    const list = vi.fn(async (): Promise<SnapshotListOutcome> => ({
      ok: true,
      backups: [{ backupId: 'b1', status: 'COMPLETED', startedAt: null, endedAt: null, dataSizeBytes: 10, description: 'a\tb', kind: null }],
    }));
    const { deps, out } = fakeDeps({ list });
    await snapshotCommand(['list', '--json'], deps);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.backups[0].description).toBe('a\tb');
  });

  it('reports an empty catalogue cleanly (exit 0)', async () => {
    const list = vi.fn(async (): Promise<SnapshotListOutcome> => ({ ok: true, backups: [] }));
    const { deps, out } = fakeDeps({ list });
    const code = await snapshotCommand(['list'], deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/no backups|0 /i);
  });

  it('emits machine JSON with --json', async () => {
    const list = vi.fn(async (): Promise<SnapshotListOutcome> => ({
      ok: true, backups: [{ backupId: 'b1', status: 'COMPLETED', startedAt: null, endedAt: null, dataSizeBytes: 10 }],
    }));
    const { deps, out } = fakeDeps({ list });
    const code = await snapshotCommand(['list', '--json'], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.ok).toBe(true);
    expect(parsed.backups[0].backupId).toBe('b1');
  });

  it('maps an unavailable catalogue to errorCode + exit 1', async () => {
    const list = vi.fn(async (): Promise<SnapshotListOutcome> => ({ ok: false, errorCode: 'CATALOGUE_UNAVAILABLE', detail: 'ObjectStore platform-system/system-db-store not found' }));
    const { deps, err } = fakeDeps({ list });
    const code = await snapshotCommand(['list'], deps);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/CATALOGUE_UNAVAILABLE/);
    expect(err.join('\n')).toContain('not found');
  });

  it('does NOT leak detail in --json on failure (label only)', async () => {
    const list = vi.fn(async (): Promise<SnapshotListOutcome> => ({ ok: false, errorCode: 'CATALOGUE_UNAVAILABLE', detail: 'shim creds postgres://u:p@h failed' }));
    const { deps, out } = fakeDeps({ list });
    const code = await snapshotCommand(['list', '--json'], deps);
    expect(code).toBe(1);
    const joined = out.join('\n');
    expect(joined).not.toContain('u:p@h');
    expect(JSON.parse(joined)).toEqual({ ok: false, errorCode: 'CATALOGUE_UNAVAILABLE' });
  });
});
