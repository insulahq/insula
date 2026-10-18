import { describe, it, expect } from 'vitest';
import { alertGroupKey, claimedEpisodesKey, groupAlerts, healSummary, workloadsByTenant, type AlertRow } from './workload-alerts.js';
import { pinnedNodeDown, isHealable, labelForReason } from './workload-health.js';

const row = (o: Partial<AlertRow> & { tenantId: string; workload: string }): AlertRow => ({
  tenantName: `T-${o.tenantId}`, namespace: `tenant-${o.tenantId}`, reason: 'quota_rejected', detail: null,
  downMinutes: 8, firstSeenAt: '2026-10-18T10:11:00.000Z', attempts: 1, lastHealError: null, pin: null, ...o,
});

describe('pinnedNodeDown / node_down — production', () => {
  it('a tenant pinned to a NotReady node is node_down, whatever the quota events say', () => {
    expect(pinnedNodeDown('s1', new Map([['s1', false], ['s3', true]]))).toBe('s1');
    expect(pinnedNodeDown('s3', new Map([['s1', false], ['s3', true]]))).toBeNull();
  });

  it('unpinned, an unknown node or no node list at all is not evidence', () => {
    expect(pinnedNodeDown(null, new Map([['s1', false]]))).toBeNull();
    expect(pinnedNodeDown('gone', new Map([['s1', false]]))).toBeNull();
    expect(pinnedNodeDown('s1', new Map())).toBeNull();
  });

  it('is not healed: a scale cycle cannot bring a node back (it left the tenant FAILED)', () => {
    expect(isHealable('node_down')).toBe(false);
    expect(labelForReason('node_down')).toBe('the node it is pinned to is down');
  });
});

describe('groupAlerts — one notification per tenant, one per node for a node outage', () => {
  it('a tenant with three workloads down is ONE alert listing them (it was three pushes and three emails)', () => {
    const g = groupAlerts([
      row({ tenantId: 'a', workload: 'moodle' }), row({ tenantId: 'a', workload: 'my-mariadb' }), row({ tenantId: 'a', workload: 'website' }),
    ], labelForReason);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ key: 'tenant:a', subject: 'T-a', namespace: 'tenant-a', workloads: ['moodle', 'my-mariadb', 'website'] });
  });

  it('tenants down because their node is down are ONE alert for that node, listing tenant: workloads', () => {
    const g = groupAlerts([
      row({ tenantId: 'a', workload: 'moodle', reason: 'node_down', pin: 's1' }),
      row({ tenantId: 'b', workload: 'web', reason: 'node_down', pin: 's1', firstSeenAt: '2026-10-18T10:10:00.000Z', downMinutes: 9 }),
      row({ tenantId: 'a', workload: 'website', reason: 'node_down', pin: 's1' }),
      row({ tenantId: 'c', workload: 'api', reason: 'crash', pin: 's1' }),
    ], labelForReason);
    expect(g.map((x) => x.key)).toEqual(['node:s1', 'tenant:c']);
    expect(g[0]).toMatchObject({
      subject: 'Tenants pinned to s1',
      workloads: ['T-a: moodle, website', 'T-b: web'],
      downSince: '2026-10-18T10:10:00.000Z',
      downMinutes: 9,
      tenantIds: ['a', 'b'],
    });
  });

  it('names each workload\'s cause only when a tenant\'s workloads are down for different reasons', () => {
    const g = groupAlerts([row({ tenantId: 'a', workload: 'web', reason: 'crash' }), row({ tenantId: 'a', workload: 'db', reason: 'image' })], labelForReason);
    expect(g[0].workloads).toEqual([`web (${labelForReason('crash')})`, `db (${labelForReason('image')})`]);
    // A recovery notice passes no label: just the names.
    expect(groupAlerts([row({ tenantId: 'a', workload: 'web', reason: 'crash' }), row({ tenantId: 'a', workload: 'db', reason: 'image' })])[0].workloads)
      .toEqual(['web', 'db']);
  });

  it('a node_down row without a pin falls back to its tenant', () => {
    expect(alertGroupKey({ reason: 'node_down', pin: null, tenantId: 'a' })).toBe('tenant:a');
  });

  it('the dedupe key names the episodes alerted: a workload alerting later in the same outage is not swallowed', () => {
    const w1 = { row: row({ tenantId: 'a', workload: 'moodle' }), notifyCount: 0 };
    const w2 = { row: row({ tenantId: 'a', workload: 'website' }), notifyCount: 0 };
    // Both share the group's earliest start; the old key (group × start × round) collided.
    expect(claimedEpisodesKey([w2])).not.toBe(claimedEpisodesKey([w1]));
    // The same episodes at the same round — a retried dispatch — still deduplicate, in any order.
    expect(claimedEpisodesKey([w1, w2])).toBe(claimedEpisodesKey([w2, w1]));
    // The next ladder round is a new alert.
    expect(claimedEpisodesKey([{ ...w1, notifyCount: 1 }])).not.toBe(claimedEpisodesKey([w1]));
  });

  it('says whether auto-heal ran', () => {
    expect(healSummary(1)).toBe('Auto-heal tried 1x and could not bring it back.');
    expect(healSummary(0)).toMatch(/not attempted/);
  });

  it('the tenant copy is one per tenant, even inside a node group', () => {
    expect(workloadsByTenant([
      row({ tenantId: 'a', workload: 'moodle', reason: 'node_down', pin: 's1' }),
      row({ tenantId: 'b', workload: 'web', reason: 'node_down', pin: 's1' }),
      row({ tenantId: 'a', workload: 'website', reason: 'node_down', pin: 's1' }),
    ])).toEqual([
      { tenantId: 'a', workloads: ['moodle', 'website'], downSince: '2026-10-18T10:11:00.000Z', reason: 'node_down' },
      { tenantId: 'b', workloads: ['web'], downSince: '2026-10-18T10:11:00.000Z', reason: 'node_down' },
    ]);
  });
});
