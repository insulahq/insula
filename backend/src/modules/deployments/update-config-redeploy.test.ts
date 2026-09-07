import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A configuration edit must reach the CLUSTER, not just the row.
 *
 * Reported against an Apache/PHP deployment: PHP_DISPLAY_ERRORS and
 * APACHE_DOCUMENT_ROOT were saved, the pod restarted, and neither took effect.
 *
 * The cause was a one-word gate — the redeploy ran `if (k8s && mountsChanged)`,
 * so only an extra_mounts edit re-rendered the pod template. `configuration`
 * was written to the row and nothing ever re-read it, and no drift reconciler
 * covers env. The tenant panel then made it look worse than a no-op: after
 * saving it POSTs /restart, which DELETES the pods, so the ReplicaSet recreated
 * them from the template that was never updated. The pod visibly bounced and
 * came back byte-identical.
 */

const deployCatalogEntry = vi.fn().mockResolvedValue(undefined);

vi.mock('./k8s-deployer.js', () => ({
  deployCatalogEntry,
  restartDeployment: vi.fn(),
  deleteDeployment: vi.fn(),
  scaleDeployment: vi.fn(),
  k8sResourceName: (a: string) => a,
}));
vi.mock('./custom-dispatch.js', () => ({
  isCustomDeployment: () => false,
  dispatchCustomStop: vi.fn(),
  dispatchCustomStart: vi.fn(),
  dispatchCustomRedeploy: vi.fn(),
  dispatchCustomResources: vi.fn(),
  dispatchCustomScale: vi.fn(),
}));

const { canonicalJson } = await import('./service.js');

describe('canonicalJson — "unchanged" must mean unchanged', () => {
  it('treats key order as irrelevant', () => {
    // The panel rebuilds configuration with a spread on every save. Plain
    // JSON.stringify is key-order sensitive, so without this every save would
    // look like a change and roll the tenant's pod for nothing.
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('still sees a real value change', () => {
    expect(canonicalJson({ PHP_DISPLAY_ERRORS: 'Off' }))
      .not.toBe(canonicalJson({ PHP_DISPLAY_ERRORS: 'On' }));
  });

  it('sees an added key', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 1, b: 2 }));
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('handles nested objects and null', () => {
    expect(canonicalJson({ x: { b: 1, a: null } })).toBe(canonicalJson({ x: { a: null, b: 1 } }));
  });
});

describe('the redeploy gate covers every pod-template field', () => {
  beforeEach(() => { deployCatalogEntry.mockClear(); });

  /**
   * Reads the gate straight out of the shipped source.
   *
   * updateDeployment needs a live db + k8s + catalog graph to call end-to-end;
   * what actually regressed was a single boolean, and asserting on the source
   * of that boolean is what would have caught it. A test that only exercised
   * extra_mounts passed happily against the broken build.
   */
  it('redeploys on configuration, replicas AND mounts — not mounts alone', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = url.fileURLToPath(new URL('./service.ts', import.meta.url));
    const src = await fs.readFile(path, 'utf8');

    const gate = src.match(/if \(k8s && (\w+)\) \{\s*\n\s*const fresh = await getDeploymentById/);
    expect(gate, 'the redeploy gate should still exist in updateDeployment').toBeTruthy();
    const gateVar = gate![1];

    // The gate must not be the mounts-only flag again.
    expect(gateVar).not.toBe('mountsChanged');

    const decl = src.match(new RegExp(`const ${gateVar} = ([^;]+);`));
    expect(decl, `${gateVar} should be declared`).toBeTruthy();
    for (const required of ['mountsChanged', 'configurationChanged', 'replicaCountChanged']) {
      expect(decl![1], `${gateVar} must include ${required}`).toContain(required);
    }
  });

  it('compares configuration canonically rather than by raw stringify', () => {
    // Guards the no-op-save-rolls-the-pod regression.
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});
