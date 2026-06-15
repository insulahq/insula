import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only existsSync; keep the rest of node:fs real (index.ts imports several).
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn() };
});

import { existsSync } from 'node:fs';
import { resolveHostConfigKubeconfig } from './index.js';

const K3S = '/etc/rancher/k3s/k3s.yaml';
const SCOPED = '/etc/platform/host-config/kubeconfig';
const existsMock = existsSync as unknown as ReturnType<typeof vi.fn>;

function present(...paths: string[]): void {
  const set = new Set(paths);
  existsMock.mockImplementation((p: string) => set.has(p));
}

describe('resolveHostConfigKubeconfig', () => {
  beforeEach(() => existsMock.mockReset());

  it('honours an explicit $KUBECONFIG over everything (no fs check)', () => {
    present(K3S, SCOPED); // both on disk, but explicit wins
    expect(resolveHostConfigKubeconfig({ KUBECONFIG: '/custom/kc' })).toBe('/custom/kc');
    expect(existsMock).not.toHaveBeenCalled();
  });

  it('trims a whitespace-only $KUBECONFIG to empty and falls through', () => {
    present(K3S);
    expect(resolveHostConfigKubeconfig({ KUBECONFIG: '   ' })).toBe(K3S);
  });

  it('control-plane: prefers the k3s admin kubeconfig', () => {
    present(K3S, SCOPED);
    expect(resolveHostConfigKubeconfig({})).toBe(K3S);
  });

  it('worker: falls back to the scoped kubeconfig when k3s.yaml is absent', () => {
    present(SCOPED); // no k3s.yaml on a worker
    expect(resolveHostConfigKubeconfig({})).toBe(SCOPED);
  });

  it('neither present → undefined (caller uses in-cluster/default; off-cluster = no-op)', () => {
    present(); // nothing on disk
    expect(resolveHostConfigKubeconfig({})).toBeUndefined();
  });
});
