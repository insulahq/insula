import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  collectFluxUnreadyOnce,
  startFluxStatusCollector,
  FLUX_RESOURCE_KINDS,
  type FluxCustomLister,
} from './flux-status-collector.js';
import { fluxUnreadyResources } from '../../shared/metrics.js';

const log = { warn: vi.fn(), info: vi.fn() };

type FluxItem = {
  metadata?: { name?: string };
  spec?: { suspend?: boolean };
  status?: { conditions?: Array<{ type: string; status: string }> };
};

function ready(status: 'True' | 'False' | 'Unknown'): FluxItem {
  return { status: { conditions: [{ type: 'Ready', status }] } };
}

function listerFor(byPlural: Record<string, FluxItem[] | Error>): FluxCustomLister {
  return {
    listClusterCustomObject: vi.fn(async (args: { plural: string }) => {
      const entry = byPlural[args.plural];
      if (entry instanceof Error) throw entry;
      return { items: entry ?? [] };
    }),
  };
}

async function gaugeValue(kind: string): Promise<number | undefined> {
  const data = await fluxUnreadyResources.get();
  return data.values.find((v) => v.labels.kind === kind)?.value;
}

beforeEach(() => {
  fluxUnreadyResources.reset();
  vi.clearAllMocks();
});

describe('FLUX_RESOURCE_KINDS', () => {
  it('covers the two Flux kinds the platform deploys', () => {
    expect(FLUX_RESOURCE_KINDS.map((k) => k.kind).sort()).toEqual(['GitRepository', 'Kustomization']);
  });
});

describe('collectFluxUnreadyOnce', () => {
  it('counts Ready=False resources per kind and sets the gauge', async () => {
    const custom = listerFor({
      kustomizations: [ready('False'), ready('True'), ready('False')],
      gitrepositories: [ready('True')],
    });

    const counts = await collectFluxUnreadyOnce(custom, log);

    expect(counts).toEqual({ Kustomization: 2, GitRepository: 0 });
    expect(await gaugeValue('Kustomization')).toBe(2);
    expect(await gaugeValue('GitRepository')).toBe(0);
  });

  it('does not count suspended resources even when Ready=False', async () => {
    const suspended: FluxItem = {
      spec: { suspend: true },
      status: { conditions: [{ type: 'Ready', status: 'False' }] },
    };
    const custom = listerFor({
      kustomizations: [suspended, ready('False')],
      gitrepositories: [],
    });

    const counts = await collectFluxUnreadyOnce(custom, log);

    expect(counts.Kustomization).toBe(1);
  });

  it('does not count Unknown or condition-less resources (progressing/new)', async () => {
    const noConditions: FluxItem = { metadata: { name: 'fresh' } };
    const custom = listerFor({
      kustomizations: [ready('Unknown'), noConditions],
      gitrepositories: [ready('Unknown')],
    });

    const counts = await collectFluxUnreadyOnce(custom, log);

    expect(counts).toEqual({ Kustomization: 0, GitRepository: 0 });
  });

  it('sets -1 for a kind whose list fails and keeps counting the others', async () => {
    const custom = listerFor({
      kustomizations: new Error('boom'),
      gitrepositories: [ready('False')],
    });

    const counts = await collectFluxUnreadyOnce(custom, log);

    expect(counts).toEqual({ Kustomization: -1, GitRepository: 1 });
    expect(await gaugeValue('Kustomization')).toBe(-1);
    expect(await gaugeValue('GitRepository')).toBe(1);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('startFluxStatusCollector', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collects immediately, then on every interval; stop clears the timer', async () => {
    vi.useFakeTimers();
    const custom = listerFor({ kustomizations: [], gitrepositories: [] });
    const lister = custom.listClusterCustomObject as ReturnType<typeof vi.fn>;

    const stop = startFluxStatusCollector(() => custom, log, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(lister).toHaveBeenCalledTimes(FLUX_RESOURCE_KINDS.length);

    await vi.advanceTimersByTimeAsync(1000);
    expect(lister).toHaveBeenCalledTimes(FLUX_RESOURCE_KINDS.length * 2);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(lister).toHaveBeenCalledTimes(FLUX_RESOURCE_KINDS.length * 2);
  });

  it('is a no-op when the kube client cannot be built (unit/CI without kubeconfig)', () => {
    const stop = startFluxStatusCollector(
      () => {
        throw new Error('no kubeconfig');
      },
      log,
      1000,
    );
    expect(log.warn).toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});
