import { describe, expect, it } from 'vitest';
import { applicationLimitError, computeTenantApplicationLimit, refuseDeleted } from './application-limit.js';
import { revivedApplicationCount } from '../backup-restore/executors/application-limit-guard.js';

describe('computeTenantApplicationLimit', () => {
  it('takes the plan unless the tenant has an override', () => {
    expect(computeTenantApplicationLimit({ planLimit: 5, override: null })).toEqual({ limit: 5, source: 'plan' });
    expect(computeTenantApplicationLimit({ planLimit: 5, override: 12 })).toEqual({ limit: 12, source: 'tenant_override' });
  });

  it('★ reads an override of 0 as zero, not as "inherit"', () => {
    expect(computeTenantApplicationLimit({ planLimit: 20, override: 0 })).toEqual({ limit: 0, source: 'tenant_override' });
  });
});

describe('applicationLimitError', () => {
  it('names the limit, the count and that stopped applications count', () => {
    const e = applicationLimitError({ limit: 2, current: 2, source: 'plan' }, 'deploy');
    expect(e.code).toBe('APPLICATION_LIMIT_REACHED');
    expect(e.status).toBe(409);
    expect(e.message).toBe(
      "Deploying another application would exceed your subscription's limit of 2 applications: 2 are deployed, stopped ones included.",
    );
    expect(e.details).toMatchObject({ limit: 2, current: 2, adding: 1 });
  });

  it('words a restore as a restore, and several at once as several', () => {
    expect(applicationLimitError({ limit: 1, current: 1, source: 'plan' }, 'restore').message)
      .toMatch(/^Restoring this application would exceed your subscription's limit of 1 application: 1 is deployed/);
    expect(applicationLimitError({ limit: 5, current: 4, source: 'plan' }, 'restore', 3).message)
      .toMatch(/^Restoring 3 applications would exceed/);
  });

  it('says applications are not part of the subscription at a limit of 0', () => {
    expect(applicationLimitError({ limit: 0, current: 0, source: 'tenant_override' }, 'deploy').message)
      .toBe('Your subscription does not include applications.');
  });
});

describe('refuseDeleted', () => {
  it('refuses to revive a deleted application outside restore', () => {
    expect(() => refuseDeleted({ id: 'd1', name: 'blog', status: 'deleted' }, 'start'))
      .toThrow("'blog' is deleted. Restore it from Recently Deleted on the Applications page before you start it.");
    expect(() => refuseDeleted({ id: 'd1', name: 'blog', status: 'stopped' }, 'start')).not.toThrow();
  });
});

describe('revivedApplicationCount', () => {
  it('counts bundle rows that are not deleted and not live', () => {
    const rows = [
      { id: 'a', status: 'running' },   // live already → not new
      { id: 'b', status: 'stopped' },   // gone (or deleted) now → comes back
      { id: 'c', status: 'deleted' },   // deleted in the bundle too → not an application
      { id: 'd', status: 'pending' },   // comes back
      { status: 'running' },            // no id → ignored
    ];
    expect(revivedApplicationCount(rows, new Set(['a']))).toBe(2);
  });
});
