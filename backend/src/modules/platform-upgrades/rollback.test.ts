import { describe, it, expect, vi } from 'vitest';
import { captureUpgradeRescue, runRollback, type RollbackDeps, type RollbackManifest, type RescueSnapshot } from './rollback.js';

const snap = (n: string): RescueSnapshot => ({ volumeName: n, namespace: 'platform', pvcName: `${n}-pvc`, snapshotName: `${n}-snap` });

function fakeDeps(over: Partial<RollbackDeps> = {}): { deps: RollbackDeps; reverts: string[]; marked: string[] } {
  const reverts: string[] = [];
  const marked: string[] = [];
  const deps: RollbackDeps = {
    resolveGitRepository: async () => 'hosting-platform-production',
    readRef: async () => ({ tag: 'v2026.6.2' }),
    captureRescue: async () => ({ snapshots: [snap('pvc-system-db')], failures: 0 }),
    recordManifest: async (m) => ({ id: 'm1', status: 'captured', createdAt: 't', ...m }),
    getLatestManifest: async () => null,
    markRolledBack: async (id) => { marked.push(id); },
    repinRef: async (name, ref) => ({ ok: true, name, previousRef: { tag: 'v2026.7.0' }, tag: ref.tag ?? ref.branch ?? '' }),
    revertVolume: async (s) => { reverts.push(`${s.volumeName}:${s.snapshotName}`); },
    ...over,
  };
  return { deps, reverts, marked };
}

const manifest = (over: Partial<RollbackManifest> = {}): RollbackManifest => ({
  id: 'm1', fromVersion: '2026.6.2', toVersion: '2026.7.0', gitRepository: 'hosting-platform-production',
  previousRef: { tag: 'v2026.6.2' }, rescueSnapshots: [snap('pvc-system-db')], status: 'captured', createdAt: 't', ...over,
});

describe('captureUpgradeRescue (mandatory safety net before apply)', () => {
  it('records a manifest with the current ref + rescue snapshots', async () => {
    const { deps } = fakeDeps();
    const r = await captureUpgradeRescue(deps, { fromVersion: '2026.6.2', toVersion: '2026.7.0' });
    expect(r.ok).toBe(true);
    expect(r.manifest?.previousRef).toEqual({ tag: 'v2026.6.2' });
    expect(r.manifest?.rescueSnapshots).toHaveLength(1);
  });
  it('REFUSES when it snapshots 0 volumes (no safety net → no upgrade)', async () => {
    const { deps } = fakeDeps({ captureRescue: async () => ({ snapshots: [], failures: 2 }) });
    const r = await captureUpgradeRescue(deps, { fromVersion: null, toVersion: '2026.7.0' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/0 volumes/);
  });
  it('refuses when there is no GitRepository / empty ref', async () => {
    expect((await captureUpgradeRescue(fakeDeps({ resolveGitRepository: async () => null }).deps, { fromVersion: null, toVersion: '1.0.0' })).ok).toBe(false);
    expect((await captureUpgradeRescue(fakeDeps({ readRef: async () => ({}) }).deps, { fromVersion: null, toVersion: '1.0.0' })).ok).toBe(false);
  });
});

describe('runRollback', () => {
  it('no manifest → nothing to roll back', async () => {
    const r = await runRollback(fakeDeps().deps, { apply: true, restoreData: false });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/nothing to roll back/);
  });

  it('dry-run previews the re-pin, restores nothing', async () => {
    const { deps, reverts, marked } = fakeDeps({ getLatestManifest: async () => manifest() });
    const r = await runRollback(deps, { apply: false, restoreData: true });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/DRY-RUN/);
    expect(reverts).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it('apply (revision only) re-pins back + marks rolled-back, NO data revert', async () => {
    const { deps, reverts, marked } = fakeDeps({ getLatestManifest: async () => manifest() });
    const r = await runRollback(deps, { apply: true, restoreData: false });
    expect(r.ok).toBe(true);
    expect(r.dataRestored).toBe(false);
    expect(reverts).toHaveLength(0);
    expect(marked).toEqual(['m1']);
    expect(r.summary).toMatch(/revision only — data NOT restored/);
  });

  it('apply + restoreData reverts every rescue snapshot (destructive)', async () => {
    const { deps, reverts } = fakeDeps({
      getLatestManifest: async () => manifest({ rescueSnapshots: [snap('a'), snap('b')] }),
    });
    const r = await runRollback(deps, { apply: true, restoreData: true });
    expect(r.dataRestored).toBe(true);
    expect(reverts).toEqual(['a:a-snap', 'b:b-snap']);
  });

  it('a failed re-pin aborts WITHOUT reverting data or marking', async () => {
    const { deps, reverts, marked } = fakeDeps({
      getLatestManifest: async () => manifest(),
      repinRef: async () => ({ ok: false, name: 'x', previousRef: null, tag: '', reason: 'not found' }),
    });
    const r = await runRollback(deps, { apply: true, restoreData: true });
    expect(r.ok).toBe(false);
    expect(reverts).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it('refuses to roll back an already-rolled-back upgrade', async () => {
    const { deps } = fakeDeps({ getLatestManifest: async () => manifest({ status: 'rolled-back' }) });
    const r = await runRollback(deps, { apply: true, restoreData: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already rolled back/);
  });
});
