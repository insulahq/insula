import { describe, it, expect } from 'vitest';
import type { UpgradeRun } from '@insula/api-contracts';
import type { UpgradeProgressData } from '@/hooks/use-platform-upgrade';
import { runPercent, servicesPercentOf } from '@/components/platform/UpgradeRunSection';

/**
 * How far the upgrade page's bar is, while the services roll. Seen on a
 * three-server cluster: the bar's first frame of that step read 67% — the end
 * of the step — and the next one 33%.
 */

const run = (over: Partial<UpgradeRun> = {}): UpgradeRun => ({
  id: 'r1', fromVersion: '2026.10.8-rc.1', toVersion: '2026.10.8-rc.2', mode: 'manual', status: 'running',
  step: 'update-services', excludedNodes: [], kubernetesVersion: null,
  nodes: [{ node: 's1', state: 'ready', cliVersion: '2026.10.8-rc.2', detail: '' }],
  message: null, startedAt: '2026-10-12T20:36:19Z', stepStartedAt: '2026-10-12T20:39:18Z', finishedAt: null,
  ...over,
} as UpgradeRun);

const services = (tags: string[], over: Partial<UpgradeProgressData> = {}): UpgradeProgressData => ({
  targetTag: null, total: tags.length, atTarget: tags.length, ready: tags.length, percent: 100, readable: true,
  deployments: tags.map((imageTag, i) => ({ name: `svc-${i}`, imageTag, versionManaged: true, atTarget: true, desired: 3, ready: 3, updated: 3 })),
  ...over,
} as UpgradeProgressData);

describe('how far the services\' roll of a run has come', () => {
  it('before the re-pin names a target, services still on the old release are at the start — not at the end', () => {
    const before = services(['2026.10.8-rc.1', '2026.10.8-rc.1', '2026.10.8-rc.1']);
    expect(before.percent).toBe(100);                    // what the live progress says, with no target to judge by
    expect(servicesPercentOf(run(), before)).toBe(0);
    expect(runPercent(run(), servicesPercentOf(run(), before))).toBe(33);
  });

  it('while a target is named, the live roll is what counts', () => {
    const rolling = services(['2026.10.8-rc.2', '2026.10.8-rc.1', '2026.10.8-rc.1'], { targetTag: '2026.10.8-rc.2', atTarget: 1, percent: 33 });
    expect(servicesPercentOf(run(), rolling)).toBe(33);
    expect(runPercent(run(), servicesPercentOf(run(), rolling))).toBe(44);
  });

  it('once the roll is over and no target is named any more, services on the new release are at the end', () => {
    const after = services(['2026.10.8-rc.2', '2026.10.8-rc.2', '2026.10.8-rc.2']);
    expect(servicesPercentOf(run(), after)).toBe(100);
    expect(runPercent(run(), servicesPercentOf(run(), after))).toBe(67);
  });

  it('one service still on the old release is not "all rolled"', () => {
    expect(servicesPercentOf(run(), services(['2026.10.8-rc.2', '2026.10.8-rc.2', '2026.10.8-rc.1']))).toBe(0);
  });

  it('reads a version with and without its leading v alike', () => {
    expect(servicesPercentOf(run({ toVersion: 'v2026.10.8-rc.2' }), services(['2026.10.8-rc.2']))).toBe(100);
    expect(servicesPercentOf(run(), services(['v2026.10.8-rc.2']))).toBe(100);
  });

  it('leaves out services the release does not version', () => {
    const mixed = services(['2026.10.8-rc.2', '20261008182327-c3ab1db']);
    mixed.deployments[1] = { ...mixed.deployments[1], versionManaged: false };
    expect(servicesPercentOf(run(), mixed)).toBe(100);
  });

  it.each<[string, UpgradeProgressData | null | undefined]>([
    ['there is no live progress', null],
    ['it has not loaded', undefined],
    ['the cluster could not be read', services(['2026.10.8-rc.2'], { readable: false })],
    ['no service is versioned by the release', services([])],
  ])('knows nothing when %s — the bar then stays at the start of the step', (_why, prog) => {
    expect(servicesPercentOf(run(), prog)).toBeNull();
    expect(runPercent(run(), servicesPercentOf(run(), prog))).toBe(33);
  });
});
