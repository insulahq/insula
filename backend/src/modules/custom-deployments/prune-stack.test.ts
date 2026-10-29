/**
 * An in-place stack edit removes what the new spec dropped — and nothing the
 * stack still needs, above all not its image-pull Secret.
 */
import { describe, expect, it, vi } from 'vitest';
import { pruneRemovedStackObjects } from './k8s-deployer.js';
import { parseCompose } from './compose-parser.js';

function fakeK8s(cms: string[], secrets: string[]) {
  const deleted: string[] = [];
  const selectors: string[] = [];
  const list = (names: string[]) => vi.fn(async (a: { labelSelector: string }) => { selectors.push(a.labelSelector); return { items: names.map((name) => ({ metadata: { name } })) }; });
  const del = (kind: string) => vi.fn(async (a: { name: string }) => { deleted.push(`${kind}/${a.name}`); });
  return {
    k8s: {
      apps: { listNamespacedDeployment: list([]), deleteNamespacedDeployment: del('deploy') },
      core: {
        listNamespacedService: list([]), deleteNamespacedService: del('svc'),
        listNamespacedConfigMap: list(cms), deleteNamespacedConfigMap: del('cm'),
        listNamespacedSecret: list(secrets), deleteNamespacedSecret: del('secret'),
      },
    } as never,
    deleted,
    selectors,
  };
}

describe('pruneRemovedStackObjects', () => {
  const spec = parseCompose({ composeYaml: 'services:\n  web:\n    image: nginx:1.27.5\n  worker:\n    image: busybox:1.36\n' }).spec!;

  it('selects only Deployments/Services of a service the spec no longer has', async () => {
    const f = fakeK8s([], []);
    await pruneRemovedStackObjects(f.k8s, 'ns', 'd1', spec);
    expect(f.selectors.slice(0, 2)).toEqual([
      'insula.host/deployment-id=d1,insula.host/stack-service,insula.host/stack-service notin (web,worker)',
      'insula.host/deployment-id=d1,insula.host/stack-service,insula.host/stack-service notin (web,worker)',
    ]);
  });

  it('★ removes dropped ConfigMaps/Secrets of the stack, never the image-pull Secret', async () => {
    const f = fakeK8s(['cd-d1-cfg-old', 'unrelated'], ['cd-d1-sec-old', 'image-pull-d1']);
    await pruneRemovedStackObjects(f.k8s, 'ns', 'd1', spec);
    expect(f.deleted.sort()).toEqual(['cm/cd-d1-cfg-old', 'secret/cd-d1-sec-old']);
  });
});
