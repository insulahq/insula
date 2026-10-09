import { describe, it, expect } from 'vitest';
import { buildNodePlan, planNameFor, NODE_UPDATE_PLAN, NODE_FINISH_PLAN } from './node-plan.js';

const IMAGE = 'ghcr.io/insulahq/insula/node-terminal:aa51607@sha256:' + 'a'.repeat(64);
const RUN = '0b6f7c1e-1234-4abc-9def-001122334455';

type Plan = {
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    concurrency: number; version: string; serviceAccountName: string;
    nodeSelector: { matchExpressions: Array<{ key: string; operator: string; values: string[] }> };
    upgrade: { image: string; command: string[]; args: string[] };
  };
};
const plan = (r: ReturnType<typeof buildNodePlan>): Plan => {
  if (!r.ok) throw new Error(r.reason);
  return r.plan as unknown as Plan;
};

// The exact argument shapes the admission policy (platform-api-plan-scope) allows.
const UPDATE_ARG_RE = /^exec nsenter -t 1 -m -u -i -n -p -- \/bin\/sh -c '\/usr\/local\/bin\/insula self-upgrade --version [0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]{1,40})? && \/usr\/bin\/env systemctl start platform-ops-host-config\.service'$/;
const FINISH_ARG_RE = /^exec nsenter -t 1 -m -u -i -n -p -- \/bin\/sh -c '\/usr\/bin\/env systemctl start platform-ops-host-config\.service'$/;

describe('buildNodePlan', () => {
  it('update: fetch the release CLI, then converge — the shape the admission policy allows', () => {
    const p = plan(buildNodePlan('update', '2026.10.7-rc.4', IMAGE, [], RUN));
    expect(p.metadata.name).toBe(NODE_UPDATE_PLAN);
    expect(p.metadata.namespace).toBe('system-upgrade');
    expect(p.spec.upgrade.command).toEqual(['/bin/sh', '-c']);
    expect(p.spec.upgrade.args).toHaveLength(1);
    expect(p.spec.upgrade.args[0]).toMatch(UPDATE_ARG_RE);
    expect(p.spec.upgrade.args[0]).toContain('--version 2026.10.7-rc.4 &&');
    expect(p.spec.upgrade.image).toBe(IMAGE);
    expect(p.spec.concurrency).toBe(1);
    expect(p.spec.serviceAccountName).toBe('system-upgrade');
    expect(Object.keys(p.spec).sort()).toEqual(['concurrency', 'nodeSelector', 'serviceAccountName', 'tolerations', 'upgrade', 'version']);
    expect(Object.keys(p.spec.upgrade).sort()).toEqual(['args', 'command', 'image']);
  });

  it('finish: converge only', () => {
    const p = plan(buildNodePlan('finish', '2026.10.7', IMAGE, [], RUN));
    expect(p.metadata.name).toBe(NODE_FINISH_PLAN);
    expect(p.spec.upgrade.args[0]).toMatch(FINISH_ARG_RE);
    expect(p.spec.upgrade.args[0]).not.toContain('self-upgrade');
  });

  it('version is unique per run, so a retried run for the same release runs again', () => {
    const a = plan(buildNodePlan('update', '2026.10.7', IMAGE, [], RUN)).spec.version;
    const b = plan(buildNodePlan('update', '2026.10.7', IMAGE, [], 'ffffffff-1234-4abc-9def-001122334455')).spec.version;
    expect(a).toBe('2026.10.7-run.0b6f7c1e1234');
    expect(a).not.toBe(b);
    // A label value: ≤ 63 chars, label charset.
    expect(a.length).toBeLessThanOrEqual(63);
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('excluded nodes are left out by hostname; none excluded → OS selector only', () => {
    const p = plan(buildNodePlan('update', '2026.10.7', IMAGE, ['sv3', 'worker-1'], RUN));
    expect(p.spec.nodeSelector.matchExpressions).toContainEqual({ key: 'kubernetes.io/hostname', operator: 'NotIn', values: ['sv3', 'worker-1'] });
    const q = plan(buildNodePlan('update', '2026.10.7', IMAGE, [], RUN));
    expect(q.spec.nodeSelector.matchExpressions).toEqual([{ key: 'kubernetes.io/os', operator: 'In', values: ['linux'] }]);
  });

  it.each([
    ['shell metacharacters', "2026.10.7; rm -rf /"],
    ['a quote', "2026.10.7'"],
    ['not a version', 'latest'],
    ['a leading v', 'v2026.10.7'],
    ['a space', '2026.10.7 x'],
  ])('refuses a version with %s', (_label, version) => {
    const r = buildNodePlan('update', version, IMAGE, [], RUN);
    expect(r.ok).toBe(false);
  });

  it('refuses an invalid image, node name or run id', () => {
    expect(buildNodePlan('update', '2026.10.7', 'ghcr.io/x/y:$(id)', [], RUN).ok).toBe(false);
    expect(buildNodePlan('update', '2026.10.7', IMAGE, ['Bad_Node'], RUN).ok).toBe(false);
    expect(buildNodePlan('update', '2026.10.7', IMAGE, ["sv1'"], RUN).ok).toBe(false);
    expect(buildNodePlan('update', '2026.10.7', IMAGE, [], 'x; id').ok).toBe(false);
  });

  it('planNameFor maps both kinds', () => {
    expect(planNameFor('update')).toBe(NODE_UPDATE_PLAN);
    expect(planNameFor('finish')).toBe(NODE_FINISH_PLAN);
  });
});
