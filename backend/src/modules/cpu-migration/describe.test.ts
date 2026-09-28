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
});
