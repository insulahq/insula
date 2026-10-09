import { describe, it, expect } from 'vitest';
import { buildHostMigrationStatusDoc } from './index.js';
import type { HostMigrationResult } from './types.js';

const result: HostMigrationResult = {
  mode: 'enforce',
  source: 'embedded',
  ok: true,
  appliedCount: 1,
  reason: null,
  items: [{ key: '2026.10.7/0001-firewall-conf-own-directory.sh', state: 'applied' }],
} as unknown as HostMigrationResult;

describe('buildHostMigrationStatusDoc', () => {
  it('carries the CLI version — the release whose host-migrations this node knows', () => {
    // Without it a node on an older CLI reports "nothing pending", exactly like an
    // up-to-date node, and the upgrade's host gate read it as converged.
    const doc = buildHostMigrationStatusDoc(result, '2026.10.7-rc.2', new Date('2026-10-09T10:00:00Z'));
    expect(doc.cliVersion).toBe('2026.10.7-rc.2');
    expect(doc.schema).toBe(1);
    expect(doc.collectedAt).toBe('2026-10-09T10:00:00.000Z');
  });

  it('writes null, not a guess, when the version is unknown', () => {
    expect(buildHostMigrationStatusDoc(result, null).cliVersion).toBeNull();
  });

  it('keeps the existing fields the relay and backend read', () => {
    const doc = buildHostMigrationStatusDoc(result, '2026.10.7');
    expect(doc).toMatchObject({ mode: 'enforce', source: 'embedded', ok: true, appliedCount: 1, reason: null });
    expect((doc.items as Array<{ key: string; state: string }>)[0]).toMatchObject({
      key: '2026.10.7/0001-firewall-conf-own-directory.sh', state: 'applied', error: null, baseline: null,
    });
  });
});

describe('trustAnchorUsable (ADR-064 §6)', () => {
  it('true only for a readable, parseable public key', async () => {
    const { trustAnchorUsable } = await import('./index.js');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { generateKeyPairSync } = await import('node:crypto');
    const dir = mkdtempSync(join(tmpdir(), 'anchor-'));
    try {
      const good = join(dir, 'good.pub');
      writeFileSync(good, generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }));
      const bad = join(dir, 'bad.pub');
      writeFileSync(bad, 'not a key');
      expect(trustAnchorUsable(good)).toBe(true);
      expect(trustAnchorUsable(bad)).toBe(false);
      expect(trustAnchorUsable(join(dir, 'missing.pub'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the status document carries it; absent stays null', async () => {
    const { buildHostMigrationStatusDoc } = await import('./index.js');
    const result = { ok: true, mode: 'enforce', source: 'embedded', appliedCount: 0, items: [] } as never;
    expect(buildHostMigrationStatusDoc(result, '2026.10.7', new Date(), true).trustAnchor).toBe(true);
    expect(buildHostMigrationStatusDoc(result, '2026.10.7').trustAnchor).toBeNull();
  });
});
