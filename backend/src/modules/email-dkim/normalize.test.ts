/**
 * Unit tests for the pure normalization planner. The JMAP round-trip
 * (get → create → destroy) is exercised by the live E2E (enable
 * domain → assert exactly one dkim-1 RSA signature).
 */
import { describe, it, expect } from 'vitest';
import { planDkimNormalization } from './normalize.js';
import type { StalwartDkimSignatureRow } from '../stalwart-jmap/client.js';

const row = (
  id: string,
  domainId: string,
  selector: string,
  type = 'Dkim1RsaSha256',
): StalwartDkimSignatureRow => ({ id, '@type': type, domainId, selector });

describe('email-dkim/normalize: planDkimNormalization', () => {
  it('fresh domain with the Stalwart auto pair: create dkim-1, destroy both auto rows', () => {
    const rows = [
      row('auto-rsa', 'd1', 'v1-rsa-20260607'),
      row('auto-ed', 'd1', 'v1-ed25519-20260607', 'Dkim1Ed25519Sha256'),
    ];
    const plan = planDkimNormalization(rows, 'd1', null);
    expect(plan.createSelector).toBe('dkim-1');
    expect(plan.destroyIds).toEqual(['auto-rsa', 'auto-ed']);
    expect(plan.activeSelector).toBe('dkim-1');
  });

  it('no signatures at all: still creates dkim-1', () => {
    const plan = planDkimNormalization([], 'd1', null);
    expect(plan.createSelector).toBe('dkim-1');
    expect(plan.destroyIds).toEqual([]);
    expect(plan.activeSelector).toBe('dkim-1');
  });

  it('re-enable with dkim-1 already present: no create, sweep the new auto pair', () => {
    const rows = [
      row('keep', 'd1', 'dkim-1'),
      row('auto-rsa', 'd1', 'v1-rsa-20260608'),
      row('auto-ed', 'd1', 'v1-ed25519-20260608', 'Dkim1Ed25519Sha256'),
    ];
    const plan = planDkimNormalization(rows, 'd1', null);
    expect(plan.createSelector).toBeNull();
    expect(plan.destroyIds).toEqual(['auto-rsa', 'auto-ed']);
    expect(plan.activeSelector).toBe('dkim-1');
  });

  it('single dkim-2 signature present: keeps dkim-2 active without minting a key', () => {
    const rows = [row('keep', 'd1', 'dkim-2')];
    const plan = planDkimNormalization(rows, 'd1', null);
    expect(plan.createSelector).toBeNull();
    expect(plan.activeSelector).toBe('dkim-2');
    expect(plan.destroyIds).toEqual([]);
  });

  it('both A/B present: prefers the persisted active selector', () => {
    const rows = [row('a', 'd1', 'dkim-1'), row('b', 'd1', 'dkim-2')];
    expect(planDkimNormalization(rows, 'd1', 'dkim-2').activeSelector).toBe('dkim-2');
    expect(planDkimNormalization(rows, 'd1', 'dkim-1').activeSelector).toBe('dkim-1');
    // Unknown persisted value → deterministic dkim-1.
    expect(planDkimNormalization(rows, 'd1', null).activeSelector).toBe('dkim-1');
  });

  it('an Ed25519 signature squatting on an A/B selector name is destroyed, not kept', () => {
    const rows = [row('ed', 'd1', 'dkim-1', 'Dkim1Ed25519Sha256')];
    const plan = planDkimNormalization(rows, 'd1', null);
    expect(plan.createSelector).toBe('dkim-1');
    expect(plan.destroyIds).toEqual(['ed']);
  });

  it('ignores rows of other domains', () => {
    const rows = [row('other', 'd2', 'v1-rsa-x'), row('mine', 'd1', 'dkim-1')];
    const plan = planDkimNormalization(rows, 'd1', null);
    expect(plan.createSelector).toBeNull();
    expect(plan.destroyIds).toEqual([]);
  });
});
