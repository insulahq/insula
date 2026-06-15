import { describe, it, expect, vi } from 'vitest';
import type { Deps } from './deps.js';
import { backupTargetCommand, backupKeyStatus } from './backup-ops.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** fakeDeps for the in-binary key-status command (uses deps.exec + deps.env). */
function keyStatusDeps(fields: Record<string, string> | null): { deps: Deps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const exec = vi.fn(async (_cmd: string, args: string[]) => {
    if (fields === null) return { code: 1, stdout: '', stderr: 'unreachable' };
    const m = args.join(' ').match(/jsonpath=\{\.data\.([a-z_]+)\}/);
    const field = m?.[1] ?? '';
    return { code: 0, stdout: field in fields ? b64(fields[field]) : '', stderr: '' };
  });
  const deps = { env: {}, out: (s: string) => out.push(s), err: (s: string) => err.push(s), exec } as unknown as Deps;
  return { deps, out, err };
}

describe('backupKeyStatus', () => {
  it('prints fingerprint + generated/rotated', async () => {
    const { deps, out } = keyStatusDeps({ fingerprint: 'abc123def4567890', generated_at: '2026-06-01', rotated_at: '2026-06-14' });
    expect(await backupKeyStatus([], deps)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/fingerprint: abc123def4567890/);
    expect(text).toMatch(/generated: 2026-06-01/);
    expect(text).toMatch(/rotated:\s+2026-06-14/);
  });

  it('--json emits the structured status', async () => {
    const { deps, out } = keyStatusDeps({ fingerprint: 'fp', generated_at: 'g' });
    expect(await backupKeyStatus(['--json'], deps)).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ ok: true, fingerprint: 'fp', generatedAt: 'g', rotatedAt: null });
  });

  it('cluster unreachable → exit 1', async () => {
    const { deps, err } = keyStatusDeps(null);
    expect(await backupKeyStatus([], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/could not reach the cluster/);
  });

  it('secret absent (empty fingerprint) → exit 1', async () => {
    const { deps, err } = keyStatusDeps({}); // no fingerprint field
    expect(await backupKeyStatus([], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/backup-target-key not found/);
  });
});

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
