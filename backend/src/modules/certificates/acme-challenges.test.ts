import { describe, it, expect, vi } from 'vitest';
import {
  createWedgeMemory,
  classifyChallenges,
  wedgedChallenges,
  summarizeChallenges,
  clearWedgedChallenges,
  CHALLENGE_WEDGE_AFTER_MS,
  type AcmeChallenge,
} from './acme-challenges.js';

const NOW = new Date('2026-09-07T20:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function ch(over: Partial<AcmeChallenge> & { name: string; created: string }): AcmeChallenge {
  return {
    metadata: { name: over.name, creationTimestamp: over.created },
    spec: { dnsName: 'business.na', type: 'DNS-01', ...(over.spec ?? {}) },
    status: over.status,
  };
}

describe('wedge detection', () => {
  it('flags a challenge that has held its slot past the threshold', () => {
    // The production shape: processing forever, never completing.
    const [i] = classifyChallenges(
      [ch({ name: 'a', created: ago(CHALLENGE_WEDGE_AFTER_MS + 1000), status: { processing: true, state: 'pending' } })],
      NOW,
    );
    expect(i.disposition).toBe('wedged');
  });

  it('does NOT flag an order that is merely slow', () => {
    // Measured on the staging issuer: a single name took ~75s and a wildcard
    // ~165s. Treating those as wedged would delete healthy orders in flight.
    for (const age of [75_000, 165_000, CHALLENGE_WEDGE_AFTER_MS - 1000]) {
      const [i] = classifyChallenges(
        [ch({ name: 'a', created: ago(age), status: { processing: true, state: 'pending' } })],
        NOW,
      );
      expect(i.disposition, `age ${age}`).toBe('progressing');
    }
  });

  it('reports a status-less challenge as BLOCKED, naming what holds the slot', () => {
    // This is the relationship nothing surfaced. The blocked challenge has
    // literally empty status, so on its own it looks like nothing is wrong.
    const insights = classifyChallenges(
      [
        ch({ name: 'holder', created: ago(3 * 60 * 60 * 1000), status: { processing: true, state: 'pending' } }),
        ch({ name: 'waiter', created: ago(3 * 60 * 60 * 1000), status: {} }),
      ],
      NOW,
    );
    const waiter = insights.find((i) => i.name === 'waiter')!;
    expect(waiter.disposition).toBe('blocked');
    expect(waiter.blockedBy).toBe('holder');
  });

  it('does not call a challenge blocked by a DIFFERENT dnsName', () => {
    // The scheduler serialises per (dnsName, type). Two different names run
    // concurrently and neither blocks the other.
    const insights = classifyChallenges(
      [
        ch({ name: 'other', created: ago(60_000), spec: { dnsName: 'elsewhere.test', type: 'DNS-01' }, status: { processing: true } }),
        ch({ name: 'mine', created: ago(60_000), status: {} }),
      ],
      NOW,
    );
    expect(insights.find((i) => i.name === 'mine')!.disposition).toBe('progressing');
  });

  it('never flags a valid challenge', () => {
    const [i] = classifyChallenges(
      [ch({ name: 'a', created: ago(5 * 60 * 60 * 1000), status: { state: 'valid' } })],
      NOW,
    );
    expect(i.disposition).toBe('valid');
    expect(wedgedChallenges([i])).toEqual([]);
  });
});

describe('operator summary', () => {
  it('explains a wedge and says it is being cleared', () => {
    const { blocked, summary } = summarizeChallenges(
      classifyChallenges(
        [ch({ name: 'a', created: ago(3 * 60 * 60 * 1000), status: { processing: true, reason: 'not yet propagated' } })],
        NOW,
      ),
    );
    expect(blocked).toBe(true);
    expect(summary).toContain('business.na');
    expect(summary).toContain('180 minutes');
    expect(summary).toContain('not yet propagated');
  });

  it('is silent when everything is progressing normally', () => {
    const { blocked, summary } = summarizeChallenges(
      classifyChallenges([ch({ name: 'a', created: ago(30_000), status: { processing: true } })], NOW),
    );
    expect(blocked).toBe(false);
    expect(summary).toBeUndefined();
  });
});

describe('clearWedgedChallenges', () => {
  function k8sWith(items: AcmeChallenge[]) {
    const del = vi.fn().mockResolvedValue({});
    return {
      k8s: { custom: { listNamespacedCustomObject: vi.fn().mockResolvedValue({ items }), deleteNamespacedCustomObject: del } },
      del,
    };
  }

  it('deletes ONLY the wedged challenge', async () => {
    const { k8s, del } = k8sWith([
      ch({ name: 'wedged', created: ago(3 * 60 * 60 * 1000), status: { processing: true } }),
      ch({ name: 'fresh', created: ago(30_000), spec: { dnsName: 'other.test', type: 'DNS-01' }, status: { processing: true } }),
    ]);
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW });
    expect(res.deleted).toEqual(['wedged']);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('deletes nothing when the order is simply in progress', async () => {
    const { k8s, del } = k8sWith([ch({ name: 'a', created: ago(60_000), status: { processing: true } })]);
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW });
    expect(res.deleted).toEqual([]);
    expect(del).not.toHaveBeenCalled();
  });

  it('reports a delete failure instead of swallowing it', async () => {
    const { k8s } = k8sWith([ch({ name: 'wedged', created: ago(3 * 60 * 60 * 1000), status: { processing: true } })]);
    k8s.custom.deleteNamespacedCustomObject = vi.fn().mockRejectedValue(new Error('forbidden'));
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW });
    expect(res.deleted).toEqual([]);
    expect(res.errors[0]).toContain('forbidden');
  });

  it('degrades quietly when the cluster has no cert-manager CRDs', async () => {
    const res = await clearWedgedChallenges({} as never, 'ns', { now: NOW });
    expect(res).toEqual({ deleted: [], errors: [] });
  });
});

describe('break-glass is deliberately narrow', () => {
  it('clears nothing when the order is healthy, so it cannot restart a working validation', async () => {
    // The button is visible whenever validation looks blocked; pressing it on a
    // healthy order must be a no-op rather than a restart.
    const del = vi.fn().mockResolvedValue({});
    const k8s = {
      custom: {
        listNamespacedCustomObject: vi.fn().mockResolvedValue({
          items: [ch({ name: 'healthy', created: ago(45_000), status: { processing: true } })],
        }),
        deleteNamespacedCustomObject: del,
      },
    };
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW });
    expect(res.deleted).toEqual([]);
    expect(del).not.toHaveBeenCalled();
  });

  it('scopes to the requested domain and leaves other tenants alone', async () => {
    const del = vi.fn().mockResolvedValue({});
    const k8s = {
      custom: {
        listNamespacedCustomObject: vi.fn().mockResolvedValue({
          items: [
            ch({ name: 'mine', created: ago(3 * 60 * 60 * 1000), status: { processing: true } }),
            ch({ name: 'theirs', created: ago(3 * 60 * 60 * 1000), spec: { dnsName: 'other.test', type: 'DNS-01' }, status: { processing: true } }),
          ],
        }),
        deleteNamespacedCustomObject: del,
      },
    };
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW, dnsNames: ['business.na'] });
    expect(res.deleted).toEqual(['mine']);
  });

  it('matches the wildcard challenge, which carries the BASE name', async () => {
    // The real shapes, verified against production: the Certificate lists
    // ["business.na", "*.business.na"], but cert-manager strips the prefix and
    // creates BOTH challenges with spec.dnsName="business.na", distinguishing
    // them with spec.wildcard. Callers scope with domain.domainName — the plain
    // name — so this is the pairing that actually occurs.
    //
    // An earlier version of this test inverted it (wildcard-prefixed caller,
    // plain challenge) and so proved nothing about the production call.
    const del = vi.fn().mockResolvedValue({});
    const k8s = {
      custom: {
        listNamespacedCustomObject: vi.fn().mockResolvedValue({
          items: [
            ch({ name: 'wild', created: ago(3 * 60 * 60 * 1000), spec: { dnsName: 'business.na', type: 'DNS-01', wildcard: true }, status: { processing: true } }),
            ch({ name: 'base', created: ago(3 * 60 * 60 * 1000), spec: { dnsName: 'business.na', type: 'DNS-01', wildcard: false }, status: { processing: true } }),
          ],
        }),
        deleteNamespacedCustomObject: del,
      },
    };
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW, dnsNames: ['business.na'] });
    expect(res.deleted).toEqual(['wild', 'base']);
  });
});

describe('hysteresis protects against a reconciler that was not watching', () => {
  function k8sWith(items: AcmeChallenge[]) {
    const del = vi.fn().mockResolvedValue({});
    return {
      k8s: { custom: { listNamespacedCustomObject: vi.fn().mockResolvedValue({ items }), deleteNamespacedCustomObject: del } },
      del,
    };
  }
  const wedgedItem = () => ch({ name: 'w', created: ago(3 * 60 * 60 * 1000), status: { processing: true } });

  it('does NOT delete on the FIRST sighting', async () => {
    // THE REGRESSION THIS GUARDS. `wedged` is derived from wall-clock age, so a
    // reconciler that could not run for a while (crash loop, OOM, DB outage,
    // node drain) returns to a cluster full of challenges that aged past the
    // threshold unobserved. Acting on that first pass would delete in-flight
    // challenges across EVERY tenant namespace at once.
    const { k8s, del } = k8sWith([wedgedItem()]);
    const memory = createWedgeMemory();
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW, memory });
    expect(res.deleted).toEqual([]);
    expect(del).not.toHaveBeenCalled();
  });

  it('deletes on the SECOND consecutive sighting', async () => {
    const { k8s, del } = k8sWith([wedgedItem()]);
    const memory = createWedgeMemory();
    await clearWedgedChallenges(k8s as never, 'ns', { now: NOW, memory });
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW, memory });
    expect(res.deleted).toEqual(['w']);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('forgets a challenge that recovered, so an old strike cannot fire later', async () => {
    const memory = createWedgeMemory();
    const first = k8sWith([wedgedItem()]);
    await clearWedgedChallenges(first.k8s as never, 'ns', { now: NOW, memory });
    // Recovered: nothing wedged this sweep.
    const healthy = k8sWith([ch({ name: 'w', created: ago(30_000), status: { processing: true } })]);
    await clearWedgedChallenges(healthy.k8s as never, 'ns', { now: NOW, memory });
    // Wedges again later — must take two fresh sightings, not one.
    const again = k8sWith([wedgedItem()]);
    const res = await clearWedgedChallenges(again.k8s as never, 'ns', { now: NOW, memory });
    expect(res.deleted).toEqual([]);
  });

  it('the operator break-glass path acts IMMEDIATELY (no memory passed)', async () => {
    // A human who has looked at a stuck certificate should not wait a tick for
    // the machine to agree.
    const { k8s, del } = k8sWith([wedgedItem()]);
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW });
    expect(res.deleted).toEqual(['w']);
    expect(del).toHaveBeenCalledTimes(1);
  });
});

describe('scoping covers the hostnames a domain certificate actually validates', () => {
  function k8sWith(items: AcmeChallenge[]) {
    const del = vi.fn().mockResolvedValue({});
    return { k8s: { custom: { listNamespacedCustomObject: vi.fn().mockResolvedValue({ items }), deleteNamespacedCustomObject: del } }, del };
  }

  it('clears a wedge on a SUBDOMAIN when scoped by the domain', async () => {
    // Found on DEV: cert-manager names a challenge after the host being
    // validated, so a route's challenge is blog.example.com while the caller
    // passes example.com. Exact matching made the button a no-op for every
    // hostname that was not the apex.
    const { k8s } = k8sWith([
      ch({ name: 'sub', created: ago(3 * 60 * 60 * 1000), spec: { dnsName: 'blog.example.com', type: 'DNS-01' }, status: { processing: true } }),
    ]);
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW, dnsNames: ['example.com'] });
    expect(res.deleted).toEqual(['sub']);
  });

  it('does NOT match a different domain that merely ends with the same letters', async () => {
    // notexample.com must not be caught by a scope of example.com.
    const { k8s, del } = k8sWith([
      ch({ name: 'other', created: ago(3 * 60 * 60 * 1000), spec: { dnsName: 'notexample.com', type: 'DNS-01' }, status: { processing: true } }),
    ]);
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW, dnsNames: ['example.com'] });
    expect(res.deleted).toEqual([]);
    expect(del).not.toHaveBeenCalled();
  });

  it('tolerates a trailing dot on either side', async () => {
    const { k8s } = k8sWith([
      ch({ name: 'fqdn', created: ago(3 * 60 * 60 * 1000), spec: { dnsName: 'example.com.', type: 'DNS-01' }, status: { processing: true } }),
    ]);
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW, dnsNames: ['example.com'] });
    expect(res.deleted).toEqual(['fqdn']);
  });
});

describe('a failed lookup is never reported as "nothing stuck"', () => {
  it('surfaces the API error instead of returning an empty list', async () => {
    // THE REGRESSION. platform-api had no RBAC on acme.cert-manager.io, every
    // list 403'd, and the original `catch { return [] }` made that identical to
    // a healthy namespace: self-heal never ran and the break-glass button said
    // "No stuck validation found" beside a challenge wedged for 42 minutes.
    const k8s = {
      custom: {
        listNamespacedCustomObject: vi.fn().mockRejectedValue(new Error('HTTP-Code: 403 challenges.acme.cert-manager.io is forbidden')),
        deleteNamespacedCustomObject: vi.fn(),
      },
    };
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW });
    expect(res.deleted).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('403');
  });

  it('still treats a cluster with no cert-manager CRDs as benign', async () => {
    const k8s = {
      custom: {
        listNamespacedCustomObject: vi.fn().mockRejectedValue(
          new Error('the server could not find the requested resource (get customresourcedefinition)'),
        ),
        deleteNamespacedCustomObject: vi.fn(),
      },
    };
    const res = await clearWedgedChallenges(k8s as never, 'ns', { now: NOW });
    expect(res).toEqual({ deleted: [], errors: [] });
  });
});
