import { describe, it, expect, vi } from 'vitest';
import { listTenantIssues, summarise, type TenantIssue } from './service.js';

function db(mailboxRows: unknown[], tenantRows: unknown[], failFirst = false) {
  let call = 0;
  return {
    execute: vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        if (failFirst) throw new Error('mailbox source exploded');
        return { rows: mailboxRows };
      }
      return { rows: tenantRows };
    }),
  } as never;
}

const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
const later = new Date(Date.now() + 30 * 86_400_000).toISOString();

describe('listTenantIssues', () => {
  it('reports a full mailbox as critical, naming the mailbox', async () => {
    const issues = await listTenantIssues(db(
      [{ tenant_id: 't1', full_address: 'user@example.test', threshold: 100, used_mb: 1500, quota_mb: 1500, first_seen_at: '2026-09-14T10:00:00Z' }],
      [],
    ));
    const t1 = issues.get('t1')!;
    expect(t1).toHaveLength(1);
    expect(t1[0].severity).toBe('critical');
    expect(t1[0].objectLabel).toBe('user@example.test');
    expect(t1[0].detail).toContain('rejected');
    expect(t1[0].actionPath).toBe('/email');
  });

  it('reports an 80% mailbox as a warning, not a critical', async () => {
    const issues = await listTenantIssues(db(
      [{ tenant_id: 't1', full_address: 'a@example.test', threshold: 80, used_mb: 800, quota_mb: 1000, first_seen_at: null }],
      [],
    ));
    expect(issues.get('t1')![0].severity).toBe('warning');
  });

  it('flags an imminent expiry as critical and a distant one as a warning', async () => {
    const issues = await listTenantIssues(db([], [
      { id: 't1', name: 'Soon Ltd', subscription_expires_at: soon, bandwidth_capped: false },
      { id: 't2', name: 'Later Ltd', subscription_expires_at: later, bandwidth_capped: false },
    ]));
    expect(issues.get('t1')![0].severity).toBe('critical');
    expect(issues.get('t2')![0].severity).toBe('warning');
  });

  it('reports a bandwidth cap alongside an expiry for the same tenant', async () => {
    const issues = await listTenantIssues(db([], [
      { id: 't1', name: 'Busy Ltd', subscription_expires_at: soon, bandwidth_capped: true },
    ]));
    expect(issues.get('t1')!.map((i) => i.kind).sort())
      .toEqual(['bandwidth_capped', 'subscription_expiring']);
  });

  it('returns an empty map when the fleet is healthy', async () => {
    expect((await listTenantIssues(db([], []))).size).toBe(0);
  });

  // One broken source must degrade the badge, never blank the tenants table.
  it('keeps the surviving sources when one source throws', async () => {
    const issues = await listTenantIssues(db([], [
      { id: 't1', name: 'Busy Ltd', subscription_expires_at: null, bandwidth_capped: true },
    ], true));
    expect(issues.get('t1')).toHaveLength(1);
  });
});

describe('summarise', () => {
  const warn = (k: string): TenantIssue => ({
    tenantId: 't', kind: k, severity: 'warning', objectLabel: 'x', detail: 'd', actionPath: '/', since: null,
  });
  const crit = (k: string): TenantIssue => ({ ...warn(k), severity: 'critical' });

  it('says nothing for a healthy tenant', () => {
    expect(summarise([])).toEqual({ count: 0, severity: null });
    expect(summarise(undefined)).toEqual({ count: 0, severity: null });
  });

  it('counts every issue', () => {
    expect(summarise([warn('a'), warn('b')]).count).toBe(2);
  });

  it('lets ONE critical drive the badge — averaging buries the thing worth seeing', () => {
    expect(summarise([warn('a'), warn('b'), crit('c')]).severity).toBe('critical');
  });
});
