/**
 * An in-place stack edit removes every object the new spec does not render —
 * and nothing the stack still needs, above all not its image-pull Secret.
 */
import { describe, expect, it, vi } from 'vitest';
import { pruneRemovedStackObjects } from './k8s-deployer.js';
import { parseCompose } from './compose-parser.js';

function fakeK8s(objects: { deploy?: string[]; svc?: string[]; cm?: string[]; secret?: string[] }) {
  const deleted: string[] = [];
  const list = (names: string[] = []) => vi.fn(async () => ({ items: names.map((name) => ({ metadata: { name } })) }));
  const del = (kind: string) => vi.fn(async (a: { name: string }) => { deleted.push(`${kind}/${a.name}`); });
  return {
    k8s: {
      apps: { listNamespacedDeployment: list(objects.deploy), deleteNamespacedDeployment: del('deploy') },
      core: {
        listNamespacedService: list(objects.svc), deleteNamespacedService: del('svc'),
        listNamespacedConfigMap: list(objects.cm), deleteNamespacedConfigMap: del('cm'),
        listNamespacedSecret: list(objects.secret), deleteNamespacedSecret: del('secret'),
      },
    } as never,
    deleted,
  };
}

const spec = (yaml: string) => parseCompose({ composeYaml: yaml }).spec!;
const WEB_ONLY = spec('services:\n  web:\n    image: nginx:1.27.5\n    ports:\n      - "80"\n');
const WEB_AND_SIDE = spec('services:\n  web:\n    image: nginx:1.27.5\n    ports:\n      - "80"\n  side:\n    image: busybox:1.36\n');

describe('pruneRemovedStackObjects', () => {
  it('★ two services → one: the survivor is renamed, so the old <stack>-web goes too (seen on DEV)', async () => {
    const f = fakeK8s({ deploy: ['cd-two', 'cd-two-web', 'cd-two-side'], svc: ['cd-two-p80', 'cd-two-web-p80'] });
    await pruneRemovedStackObjects(f.k8s, 'ns', 'd1', 'cd-two', WEB_ONLY);
    expect(f.deleted.sort()).toEqual(['deploy/cd-two-side', 'deploy/cd-two-web', 'svc/cd-two-web-p80']);
  });

  it('one service → two: the old single-service names go', async () => {
    const f = fakeK8s({ deploy: ['cd-two', 'cd-two-web', 'cd-two-side'], svc: ['cd-two-p80', 'cd-two-web-p80'] });
    await pruneRemovedStackObjects(f.k8s, 'ns', 'd1', 'cd-two', WEB_AND_SIDE);
    expect(f.deleted.sort()).toEqual(['deploy/cd-two', 'svc/cd-two-p80']);
  });

  it('★ removes dropped ConfigMaps/Secrets of the stack, never the image-pull Secret', async () => {
    const f = fakeK8s({ deploy: ['cd-two'], svc: ['cd-two-p80'], cm: ['cd-d1-cfg-old', 'unrelated'], secret: ['cd-d1-sec-old', 'image-pull-d1'] });
    await pruneRemovedStackObjects(f.k8s, 'ns', 'd1', 'cd-two', WEB_ONLY);
    expect(f.deleted.sort()).toEqual(['cm/cd-d1-cfg-old', 'secret/cd-d1-sec-old']);
  });
});
