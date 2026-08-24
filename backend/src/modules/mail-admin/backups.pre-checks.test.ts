/**
 * Unit tests for listMailBackups' pre-check branches (2026-08-24).
 *
 * The list itself spawns a one-shot restic Pod (covered by the DinD
 * E2E harness); these tests pin the three honest early-out messages
 * that replaced the generic "repo not reachable" during transitional
 * windows:
 *   1. no mail target bound            → "No mail BackupTarget configured"
 *   2. restic Secret not yet created   → "still being provisioned"
 *   3. shim Endpoints not ready        → "gateway is restarting"
 */

import { describe, expect, it, vi } from 'vitest';
import { listMailBackups } from './backups.js';
import type { Database } from '../../db/index.js';

function fakeDb(targetName: string | null): Database {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'innerJoin', 'orderBy', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) =>
    Promise.resolve(targetName ? [{ id: 'cfg-1', name: targetName }] : []).then(resolve);
  return { select: vi.fn(() => chain) } as unknown as Database;
}

function silentBatch() {
  return {} as never;
}

describe('listMailBackups pre-checks', () => {
  it('no mail target bound → early-out with guidance, no k8s calls', async () => {
    const core = {
      readNamespacedSecret: vi.fn(),
      readNamespacedEndpoints: vi.fn(),
    };
    const r = await listMailBackups({
      db: fakeDb(null),
      core: core as never,
      batch: silentBatch(),
    });
    expect(r.repoReachable).toBe(false);
    expect(r.reason).toContain('No mail BackupTarget configured');
    expect(core.readNamespacedSecret).not.toHaveBeenCalled();
  });

  it('restic Secret 404 → provisioning-window message (not "unreachable")', async () => {
    const core = {
      readNamespacedSecret: vi.fn().mockRejectedValue({ statusCode: 404 }),
      readNamespacedEndpoints: vi.fn(),
    };
    const r = await listMailBackups({
      db: fakeDb('minio-dev'),
      core: core as never,
      batch: silentBatch(),
    });
    expect(r.repoReachable).toBe(false);
    expect(r.reason).toContain('still being provisioned');
    expect(r.targetName).toBe('minio-dev');
    expect(core.readNamespacedEndpoints).not.toHaveBeenCalled();
  });

  it('shim Endpoints with no ready addresses → gateway-restarting message', async () => {
    const core = {
      readNamespacedSecret: vi.fn().mockResolvedValue({ data: {} }),
      readNamespacedEndpoints: vi.fn().mockResolvedValue({ subsets: [] }),
    };
    const r = await listMailBackups({
      db: fakeDb('minio-dev'),
      core: core as never,
      batch: silentBatch(),
    });
    expect(r.repoReachable).toBe(false);
    expect(r.reason).toContain('gateway is restarting');
    expect(r.targetName).toBe('minio-dev');
  });
});
