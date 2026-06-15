import { describe, it, expect, vi } from 'vitest';
import type { Deps } from './deps.js';
import { backupTargetCommand } from './backup-ops.js';

type BackupTargetResult = { ok: boolean; json?: unknown; detail?: string };

function fakeDeps(
  o: { result?: BackupTargetResult; stdin?: string } = {},
): { deps: Deps; out: string[]; err: string[]; backupTarget: ReturnType<typeof vi.fn> } {
  const out: string[] = [];
  const err: string[] = [];
  const backupTarget = vi.fn(async () => o.result ?? { ok: true, json: { ok: true } });
  const deps = {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    backupTarget,
    readStdin: async () => o.stdin ?? '',
  } as unknown as Deps;
  return { deps, out, err, backupTarget };
}

describe('backupTargetCommand', () => {
  it('list renders configs + bindings + unbound classes', async () => {
    const { deps, out } = fakeDeps({
      result: {
        ok: true,
        json: {
          configs: [{ id: 't1', name: 'minio', storageType: 's3', s3Bucket: 'b', s3Prefix: 'p', active: true }],
          assignments: [{ backupClass: 'system', targetId: 't1' }],
        },
      },
    });
    expect(await backupTargetCommand(['list'], deps)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/t1.*minio.*s3.*b\/p.*classes: system.*ACTIVE/);
    expect(text).toMatch(/Unbound classes: tenant, mail/);
  });

  it('bind passes through to the entrypoint + renders the binding', async () => {
    const { deps, out, backupTarget } = fakeDeps({
      result: { ok: true, json: { ok: true, backupClass: 'system', targetId: 't1', note: 'converge' } },
    });
    expect(await backupTargetCommand(['bind', 'system', 't1'], deps)).toBe(0);
    expect(backupTarget).toHaveBeenCalledWith(['bind', 'system', 't1'], undefined);
    expect(out.join('\n')).toMatch(/Bound class 'system' → target t1/);
  });

  it('unbind requires a class, then renders', async () => {
    const u = fakeDeps();
    expect(await backupTargetCommand(['unbind'], u.deps)).toBe(2);
    expect(u.err.join('\n')).toMatch(/usage.*unbind/);
    const { deps, out } = fakeDeps({ result: { ok: true, json: { ok: true, backupClass: 'mail', unbound: true } } });
    expect(await backupTargetCommand(['unbind', 'mail'], deps)).toBe(0);
    expect(out.join('\n')).toMatch(/Unbound class 'mail'/);
  });

  it('add reads stdin and forwards it', async () => {
    const { deps, backupTarget } = fakeDeps({ stdin: '{"storage_type":"s3"}', result: { ok: true, json: { ok: true, id: 't9', name: 'x' } } });
    expect(await backupTargetCommand(['add'], deps)).toBe(0);
    expect(backupTarget).toHaveBeenCalledWith(['add'], '{"storage_type":"s3"}');
  });

  it('add with empty stdin → usage error (exit 2)', async () => {
    const { deps, err } = fakeDeps({ stdin: '   ' });
    expect(await backupTargetCommand(['add'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/pipe a JSON config on stdin/);
  });

  it('test renders connectivity + exits 1 on a failed probe', async () => {
    const ok = fakeDeps({ result: { ok: true, json: { ok: true, result: { ok: true, latencyMs: 42 } } } });
    expect(await backupTargetCommand(['test', 't1'], ok.deps)).toBe(0);
    expect(ok.out.join('\n')).toMatch(/Connection OK \(42ms\)/);
    const bad = fakeDeps({ result: { ok: true, json: { ok: false, result: { ok: false, error: { code: 'AUTH', message: 'denied' } } } } });
    expect(await backupTargetCommand(['test', 't1'], bad.deps)).toBe(1);
    expect(bad.out.join('\n')).toMatch(/Connection FAILED: AUTH denied/);
  });

  it('an in-pod failure surfaces as exit 1 with the detail', async () => {
    const { deps, err } = fakeDeps({ result: { ok: false, detail: 'DATABASE_URL is not set in this pod' } });
    expect(await backupTargetCommand(['list'], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/DATABASE_URL is not set/);
  });

  it('--json passes the raw entrypoint JSON through', async () => {
    const { deps, out } = fakeDeps({ result: { ok: true, json: { ok: true, configs: [], assignments: [] } } });
    expect(await backupTargetCommand(['list', '--json'], deps)).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ ok: true, configs: [], assignments: [] });
  });

  it('unknown subcommand → exit 2', async () => {
    const { deps, err } = fakeDeps();
    expect(await backupTargetCommand(['frob'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/expected list\|add\|test\|delete\|bind\|unbind/);
  });
});
