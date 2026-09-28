import { describe, it, expect } from 'vitest';
import { describeDeployment, type DeploymentFactsRow } from './describe.js';

const row = (o: Partial<DeploymentFactsRow> = {}): DeploymentFactsRow => ({
  id: 'd1', name: 'app', cpu_request: '0.25', source: 'catalog',
  source_repo_id: 'official', custom_spec: null,
  entry_resources: { recommended: { cpu: '0.3' } }, ...o,
});

/**
 * ★ These tests exist because the dry run and the apply derived the tier
 * DIFFERENTLY — the preview from the catalog's recommendation, the runner
 * from the deployment's live cpu_request. The operator reviewed one plan and
 * would have got another. Both now call this function; these pin the rules it
 * has to keep.
 */
describe('describeDeployment', () => {
  it('takes a catalog tier from the RECOMMENDATION, not the current request', () => {
    // Current request says 2 cores (would derive `highest`); the catalog
    // recommends 0.3 (derives `high`). The recommendation must win.
    const f = describeDeployment(row({ cpu_request: '2', entry_resources: { recommended: { cpu: '0.3' } } }), 'official');
    expect(f.proposedTier).toBe('high');
    expect(f.currentMillis).toBe(2000);
  });

  /**
   * The exact case that diverged. The platform's own custom-deployment
   * default is 100m; deriving from that gives `normal` (5m) and would
   * "quietly starve an app nobody sized". A custom container has no
   * recommendation, so it gets `high`.
   */
  it('gives every custom deployment the safe default tier', () => {
    const f = describeDeployment(row({ source: 'custom', cpu_request: '100m', entry_resources: null }), 'official');
    expect(f.proposedTier).toBe('high');
    expect(f.proposedMillis).toBe(30);
  });

  it('flags a custom deployment that pins its own CPU, and marks it unpinnable', () => {
    const f = describeDeployment(row({
      source: 'custom',
      custom_spec: { services: { web: { resources: { cpuRequest: '500m' } } } },
    }), 'official');
    expect(f.blocker).toBe('custom_resources');
    expect(f.pinsOwnCpu).toBe(true);
  });

  // `resources.cpu` is the other spelling a spec can pin with — the runner
  // used to miss it by matching only the literal string "cpuRequest".
  it('recognises the other way a spec pins CPU', () => {
    const f = describeDeployment(row({
      source: 'custom', custom_spec: { services: { web: { resources: { cpu: '1' } } } },
    }), 'official');
    expect(f.pinsOwnCpu).toBe(true);
  });

  // A manifest we did not write, whose sizing we cannot vouch for.
  it('flags a third-party catalog entry', () => {
    const f = describeDeployment(row({ source_repo_id: 'community' }), 'official');
    expect(f.blocker).toBe('third_party_catalog');
  });

  it('does not flag the official catalog', () => {
    expect(describeDeployment(row(), 'official').blocker).toBeNull();
  });

  // One row, N services: the quota budgets per CONTAINER, so the count matters.
  it('counts the services of a compose stack', () => {
    const f = describeDeployment(row({
      source: 'custom', custom_spec: { services: { web: {}, db: {}, cache: {} } },
    }), 'official');
    expect(f.containerCount).toBe(3);
    expect(f.isComposeStack).toBe(true);
  });

  it('treats a single-service spec as one container, not a stack', () => {
    const f = describeDeployment(row({ source: 'custom', custom_spec: { services: { web: {} } } }), 'official');
    expect(f.containerCount).toBe(1);
    expect(f.isComposeStack).toBe(false);
  });

  it('treats a catalog deployment with no spec as one container', () => {
    const f = describeDeployment(row(), 'official');
    expect(f.containerCount).toBe(1);
    expect(f.isComposeStack).toBe(false);
  });

  // A catalog entry whose manifest says nothing about CPU still needs a tier.
  it('falls back to the safe tier when the manifest is silent', () => {
    expect(describeDeployment(row({ entry_resources: null }), 'official').proposedTier).toBe('high');
  });

  /**
   * ★ The plan's tier is a CAP, and until R3 it was a decoration.
   *
   * A workload's tier came from its catalog entry alone, so a Starter
   * tenant's WordPress and an Ultimate tenant's WordPress asked for the same
   * share and competed as equals under contention. The plan's `cpu_tier`
   * reached only containers that declared no CPU at all — which, after a
   * migration re-tiers every deployment, is none of them.
   */
  
  /**
   * ★ The catalog may now say what share it wants (ADR-062).
   *
   * Making `resources.cpu.tier` optional rather than required is what keeps
   * this from being a flag day: the catalog is a separate public repo, plus
   * an opt-in community one, consumed by whatever platform version an
   * operator happens to be running.
   */
  
  /**
   * ★ The tier is the TENANT's, for every workload it runs (ADR-062 R3).
   *
   * It used to come from the catalog manifest's `recommended.cpu`, which
   * was describing a reservation the platform no longer makes. Two wrong
   * outcomes fell out of that: a tenant's WordPress outranked its own
   * static site for no reason the operator chose, and a third-party
   * catalog repo could hand its entry priority over everything else that
   * tenant runs.
   */
  describe('the tier comes from the subscription', () => {
    it('gives every workload the tenant tier, whatever the manifest says', () => {
      const demanding = describeDeployment(
        row({ entry_resources: { recommended: { cpu: '2' } } }), 'official', 'normal',
      );
      const modest = describeDeployment(
        row({ entry_resources: { recommended: { cpu: '0.05' } } }), 'official', 'normal',
      );
      expect(demanding.proposedTier).toBe('normal');
      expect(modest.proposedTier).toBe('normal');
      expect(demanding.proposedMillis).toBe(modest.proposedMillis);
    });

    it('raises as well as lowers — it is the tenant tier, not a cap', () => {
      const f = describeDeployment(
        row({ entry_resources: { recommended: { cpu: '0.05' } } }), 'official', 'highest',
      );
      expect(f.proposedTier).toBe('highest');
    });

    it('treats a custom container the same as a catalog one', () => {
      const f = describeDeployment(row({ source: 'custom' }), 'official', 'normal');
      expect(f.proposedTier).toBe('normal');
    });

    it('ignores a manifest with no cpu at all', () => {
      // `cpu` is optional in minimum/recommended now, and nothing reads it
      // for scheduling.
      const f = describeDeployment(
        row({ entry_resources: { recommended: { memory: '256Mi' } } }), 'official', 'high',
      );
      expect(f.proposedTier).toBe('high');
    });

    it('falls back to high when no tenant tier is supplied', () => {
      // Matches resolve.ts's own DEFAULT_TIER, so the dry run and the
      // runner cannot disagree about an unresolvable tenant.
      expect(describeDeployment(row(), 'official').proposedTier).toBe('high');
    });
  });
});
