/**
 * The panels and the API keep serving for a moment after they are told to stop.
 *
 * Each runs one replica and rolls by surge: the new pod becomes ready, then the
 * old one gets SIGTERM — while Traefik still sends it requests for the moment it
 * takes to drop it from its endpoints. Without a preStop pause the old pod exited
 * at once and those requests got 502: measured on staging at an upgrade's swap,
 * the admin panel and then the API each failed one 2-second sample.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';

const repoRoot = resolve(import.meta.dirname, '../../..');

interface Container {
  readonly name: string;
  readonly lifecycle?: { readonly preStop?: { readonly sleep?: { readonly seconds?: number } } };
}
interface Deployment {
  readonly kind?: string;
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly template?: { readonly spec?: { readonly containers?: Container[]; readonly terminationGracePeriodSeconds?: number } } };
}

describe.each([
  ['k8s/base/admin-deployment.yaml', 'admin-panel'],
  ['k8s/base/tenant-deployment.yaml', 'tenant-panel'],
  ['k8s/base/backend-deployment.yaml', 'platform-api'],
])('%s', (file, name) => {
  const docs = yaml.loadAll(readFileSync(join(repoRoot, file), 'utf8')) as Deployment[];
  const dep = docs.find((d) => d?.kind === 'Deployment' && d.metadata?.name === name);

  it(`${name} pauses before it stops, within its grace period`, () => {
    expect(dep, `${name} Deployment`).toBeDefined();
    const pod = dep!.spec!.template!.spec!;
    const seconds = pod.containers![0]!.lifecycle?.preStop?.sleep?.seconds ?? 0;
    expect(seconds).toBeGreaterThanOrEqual(5);
    // The kubelet's default grace is 30 s; the pause must leave the app time to shut down inside it.
    expect(seconds).toBeLessThan((pod.terminationGracePeriodSeconds ?? 30) - 10);
  });
});
