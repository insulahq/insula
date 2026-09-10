import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A source-level assertion, deliberately — same reasoning as
 * multihost-create-wiring.test.ts.
 *
 * `storagePath` is the `subPath` of the tenant-storage volumeMount, so
 * re-pointing a deployment is a POD TEMPLATE change. Persisting the column
 * without re-rendering the template is the exact failure this repo has already
 * shipped twice: `configuration` and `replica_count` were both saved to the row
 * and never applied, so the tenant edited a value, restarted the pod, and got
 * the old behaviour back byte-identical. That reads as "the setting does not
 * work" rather than "the setting was never applied".
 *
 * TypeScript cannot catch it (adding a key to `updateValues` is legal and
 * omitting it from `podTemplateChanged` is legal), and `updateDeployment` needs
 * a live database and K8s client, so there is no cheap behavioural seam. This
 * checks the wiring instead. If `updateDeployment` is restructured so these
 * strings no longer apply, delete this file — but replace it with something
 * covering the same gap.
 */
const servicePath = join(dirname(fileURLToPath(import.meta.url)), 'service.ts');
const source = readFileSync(servicePath, 'utf-8');

describe('updateDeployment applies a storage-path re-point', () => {
  it('persists the new path to the row', () => {
    expect(source).toContain('updateValues.storagePath = input.storage_path');
  });

  it('treats the change as a pod-template change', () => {
    // The two halves that must both exist: the comparison, and its inclusion
    // in the flag that actually triggers redeployWithCurrentConfig.
    expect(source).toContain('const storagePathChanged = input.storage_path !== undefined');
    expect(source).toMatch(/const podTemplateChanged =[^;]*storagePathChanged/s);
  });

  it('still redeploys off podTemplateChanged', () => {
    // If this guard is ever renamed, the assertion above silently stops
    // meaning anything — so pin the consumer too.
    expect(source).toContain('if (k8s && podTemplateChanged)');
    expect(source).toContain('redeployWithCurrentConfig(db, fresh');
  });

  it('does not copy or delete anything — a re-point is not a move', () => {
    // The decision was explicit: the old folder keeps its contents and stays
    // on disk. Any file-moving call appearing in this path would be a
    // behaviour change that needs its own review, not a silent addition.
    const updateFn = source.slice(
      source.indexOf('export async function updateDeployment'),
      source.indexOf('export async function deleteDeployment'),
    );
    expect(updateFn.length).toBeGreaterThan(0);
    for (const forbidden of ['/mv', '/copy', 'rmdir', 'rm -rf', 'moveFolder', 'copyFolder']) {
      expect(updateFn).not.toContain(forbidden);
    }
  });
});

describe('listStorageFolders browses the whole PVC', () => {
  it('takes a path rather than a catalog entry type/code', () => {
    expect(source).toMatch(/export async function listStorageFolders\([^)]*path: string/s);
    // The old signature pinned every listing under `<type>/<code>`, which is
    // what made "any folder" impossible.
    expect(source).not.toContain('const basePath = `${entryType}/${entryCode}`');
  });

  it('can list the PVC root', () => {
    // '' must reach the file-manager as '.', not as an empty query value —
    // an empty path lists the sidecar's own working directory instead.
    expect(source).toContain("path: basePath === '' ? '.' : basePath");
  });

  it('reports a folder claimed by another deployment instead of hiding it', () => {
    // Sharing is allowed with a warning; filtering these out would silently
    // remove the option the UI is supposed to offer.
    expect(source).toContain('usedByDeployment: pathToDeployment.get(fullPath) ?? null');
  });
});
