import { describe, it, expect, vi } from 'vitest';
import type { Deps } from './deps.js';
import { mailCommand } from './mail.js';

function fakeDeps(
  result: { ok: boolean; json?: unknown; detail?: string } = { ok: true, json: { ok: true, rotatedAt: '2026-06-15T00:00:00Z', principalDomain: 'mail.example.test' } },
): { deps: Deps; out: string[]; err: string[]; mailRotateMaster: ReturnType<typeof vi.fn> } {
  const out: string[] = [];
  const err: string[] = [];
  const mailRotateMaster = vi.fn(async () => result);
  const deps = { env: {}, out: (s: string) => out.push(s), err: (s: string) => err.push(s), mailRotateMaster } as unknown as Deps;
  return { deps, out, err, mailRotateMaster };
}

describe('mailCommand', () => {
  it('rotate-master-password calls the in-pod seam + renders', async () => {
    const { deps, out, mailRotateMaster } = fakeDeps();
    expect(await mailCommand(['rotate-master-password'], deps)).toBe(0);
    expect(mailRotateMaster).toHaveBeenCalled();
    const text = out.join('\n');
    expect(text).toMatch(/Rotated the webmail master password for master@mail\.example\.test/);
    expect(text).toMatch(/rotated at: 2026-06-15/);
  });

  it('--json passes the raw result through', async () => {
    const { deps, out } = fakeDeps({ ok: true, json: { ok: true, rotatedAt: 'T', principalDomain: 'mail.x.test' } });
    expect(await mailCommand(['rotate-master-password', '--json'], deps)).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ ok: true, rotatedAt: 'T', principalDomain: 'mail.x.test' });
  });

  it('an in-pod failure → exit 1 with the detail', async () => {
    const { deps, err } = fakeDeps({ ok: false, detail: 'platform apex is not configured' });
    expect(await mailCommand(['rotate-master-password'], deps)).toBe(1);
    expect(err.join('\n')).toMatch(/platform apex is not configured/);
  });

  it('unknown subcommand → exit 2', async () => {
    const { deps, err } = fakeDeps();
    expect(await mailCommand(['frob'], deps)).toBe(2);
    expect(err.join('\n')).toMatch(/expected 'rotate-master-password'/);
  });
});
