import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DETACHED_ROUTE_TARGET, clearOrphanedSiteFolder } from './detach.js';

/**
 * Regression: a multi-host deployment with a folder-bound route could not be
 * deleted at all. `deleteDeployment` unlinked routes with
 * `{ deploymentId: null }` and left `site_folder` set, which the DB CHECK
 * `ingress_routes_site_folder_needs_deployment` rejects — aborting the delete
 * AFTER the row was flagged `deleted` and the workload torn down. Observed on
 * DEV as a 400 plus a zombie deployment.
 */
describe('detaching a route clears its site folder', () => {
  it('the delete-path constant clears every folder column', () => {
    // appRoot joined the pair in migration 0105 and is bound by the same
    // CHECK — a detach that clears only two of the three still violates it.
    expect(DETACHED_ROUTE_TARGET).toEqual({ deploymentId: null, siteFolder: null, appRoot: null });
  });

  it('clears the folder when a patch detaches the route', () => {
    expect(clearOrphanedSiteFolder({ deploymentId: null })).toEqual({
      deploymentId: null,
      siteFolder: null,
      appRoot: null,
    });
  });

  it('clears the folder when a patch moves the route to a private worker', () => {
    expect(clearOrphanedSiteFolder({ privateWorkerId: 'pw-1', deploymentId: null })).toEqual({
      privateWorkerId: 'pw-1',
      deploymentId: null,
      siteFolder: null,
      appRoot: null,
    });
  });

  it('leaves an explicit folder in the same patch alone', () => {
    const values = { deploymentId: null, siteFolder: 'site-a' };
    expect(clearOrphanedSiteFolder(values)).toEqual(values);
  });

  it('does not touch a patch that keeps the deployment', () => {
    expect(clearOrphanedSiteFolder({ deploymentId: 'dep-1' })).toEqual({ deploymentId: 'dep-1' });
    expect(clearOrphanedSiteFolder({ tlsMode: 'acme' })).toEqual({ tlsMode: 'acme' });
  });

  it('returns a new object rather than mutating the caller', () => {
    const values = { deploymentId: null };
    expect(clearOrphanedSiteFolder(values)).not.toBe(values);
    expect(values).toEqual({ deploymentId: null });
  });
});

/**
 * The two call sites, asserted at source level: the helper is only useful if
 * the detach paths actually route through it, and neither has a cheap seam
 * (both need a database).
 */
const here = dirname(fileURLToPath(import.meta.url));

describe('both detach paths use the shared invariant', () => {
  it('updateRoute writes the sanitised values', () => {
    const src = readFileSync(join(here, 'service.ts'), 'utf-8');
    expect(src).toContain('clearOrphanedSiteFolder(updateValues)');
    expect(src).toContain('.set(finalValues)');
    // The shape that shipped. Its absence is the assertion.
    expect(src).not.toContain('.set(updateValues)');
  });

  it('deleteDeployment unlinks with both columns, inside a transaction', () => {
    const src = readFileSync(join(here, '..', 'deployments', 'service.ts'), 'utf-8');
    expect(src).toContain('.set(DETACHED_ROUTE_TARGET)');
    expect(src).not.toContain('.set({ deploymentId: null })');
    expect(src).toContain('await db.transaction(async (tx) => {');
  });
});
