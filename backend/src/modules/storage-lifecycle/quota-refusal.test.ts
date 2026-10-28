import { describe, expect, it } from 'vitest';
import { describeQuotaRefusal, parseQuotaRefusals, quotaRefusalVerdict, refusalForWorkload, type LiveQuota } from './quota-refusal.js';

// Verbatim shape of the production detail (tenant name redacted).
const PROD_DETAIL = 'FailedCreate: pods "sitewright-7fc475c7cd-c4w8b" is forbidden: exceeded quota: tenant-x-quota, '
  + 'requested: requests.cpu=30m, used: requests.cpu=525m, limited: requests.cpu=530m | FailedCreate: (combined from '
  + 'similar events): Error creating: pods "private-worker-server-67ccc76f79-sqql2" is forbidden: exceeded quota: '
  + 'tenant-x-quota, requested: requests.cpu=25m, used: requests.cpu=530m, limited: requests.cpu=530m';

const scoped: LiveQuota = { hard: { 'requests.cpu': '530m' }, used: { 'requests.cpu': '525m' }, priorityClasses: ['tenant-default'] };

describe('parseQuotaRefusals', () => {
  it('reads every refusal in a detail block', () => {
    const r = parseQuotaRefusals(PROD_DETAIL);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      pod: 'sitewright-7fc475c7cd-c4w8b',
      quota: 'tenant-x-quota',
      requested: { 'requests.cpu': '30m' },
      used: { 'requests.cpu': '525m' },
      limited: { 'requests.cpu': '530m' },
    });
  });

  it('reads multi-resource lists', () => {
    const [r] = parseQuotaRefusals('exceeded quota: q, requested: limits.memory=1Gi,requests.memory=1Gi, '
      + 'used: limits.memory=3584Mi,requests.memory=3Gi, limited: limits.memory=4Gi,requests.memory=4Gi');
    expect(r.requested).toEqual({ 'limits.memory': '1Gi', 'requests.memory': '1Gi' });
    expect(r.limited).toEqual({ 'limits.memory': '4Gi', 'requests.memory': '4Gi' });
  });

  it('finds nothing in unrelated text', () => {
    expect(parseQuotaRefusals('ImagePullBackOff: manifest unknown')).toEqual([]);
    expect(parseQuotaRefusals(null)).toEqual([]);
  });
});

describe('quotaRefusalVerdict', () => {
  const [sitewright] = parseQuotaRefusals(PROD_DETAIL);

  it('★ a full quota is full — the production case is not worth a restart', () => {
    const v = quotaRefusalVerdict([sitewright], new Map([['tenant-x-quota', scoped]]), []);
    expect(v).toEqual({
      kind: 'full',
      shortfall: [{ quota: 'tenant-x-quota', resource: 'requests.cpu', used: '525m', hard: '530m', needed: '30m' }],
    });
  });

  it('a pod still terminating makes the room — that refusal clears', () => {
    // A Recreate rollout: the old 30m pod still counts while it shuts down.
    const live: LiveQuota = { ...scoped, used: { 'requests.cpu': '530m' } };
    const v = quotaRefusalVerdict([sitewright], new Map([['tenant-x-quota', live]]),
      [{ priorityClassName: 'tenant-default', holds: { 'requests.cpu': '30m' } }]);
    expect(v).toEqual({ kind: 'fits' });
  });

  it('a terminating pod outside the quota scope frees nothing', () => {
    const live: LiveQuota = { ...scoped, used: { 'requests.cpu': '530m' } };
    const v = quotaRefusalVerdict([sitewright], new Map([['tenant-x-quota', live]]),
      [{ priorityClassName: 'platform-tenant-overhead', holds: { 'requests.cpu': '30m' } }]);
    expect(v.kind).toBe('full');
  });

  it('several refused workloads need room together', () => {
    const roomy: LiveQuota = { ...scoped, hard: { 'requests.cpu': '570m' } };
    const both = parseQuotaRefusals(PROD_DETAIL); // 30m + 25m on top of 525m = 580m > 570m
    expect(quotaRefusalVerdict(both, new Map([['tenant-x-quota', roomy]]), []).kind).toBe('full');
    expect(quotaRefusalVerdict([both[0]], new Map([['tenant-x-quota', roomy]]), []).kind).toBe('fits');
  });

  it('two workloads refused on different resources are each judged on their own', () => {
    // The message names only the resource that ran out: A on CPU, B on memory.
    const [a] = parseQuotaRefusals('pods "a-1-x" is forbidden: exceeded quota: q, requested: requests.cpu=30m, used: requests.cpu=530m, limited: requests.cpu=530m');
    const [b] = parseQuotaRefusals('pods "b-1-y" is forbidden: exceeded quota: q, requested: limits.memory=1Gi, used: limits.memory=4Gi, limited: limits.memory=4Gi');
    const live: LiveQuota = { hard: { 'requests.cpu': '530m', 'limits.memory': '4Gi' }, used: { 'requests.cpu': '530m', 'limits.memory': '4Gi' }, priorityClasses: null };
    const leaving = [{ priorityClassName: null, holds: { 'requests.cpu': '30m', 'limits.memory': '1Gi' } }];
    expect(quotaRefusalVerdict([a, b], new Map([['q', live]]), leaving)).toEqual({ kind: 'fits' });
    expect(quotaRefusalVerdict([a, b], new Map([['q', live]]), []).kind).toBe('full');
  });

  it('a resource the quota no longer limits cannot refuse', () => {
    const noCpu: LiveQuota = { hard: { 'limits.memory': '4Gi' }, used: {}, priorityClasses: null };
    expect(quotaRefusalVerdict([sitewright], new Map([['tenant-x-quota', noCpu]]), []).kind).toBe('fits');
  });

  it('cannot judge without the quota or a refusal', () => {
    expect(quotaRefusalVerdict([sitewright], new Map(), []).kind).toBe('unknown');
    expect(quotaRefusalVerdict([], new Map([['tenant-x-quota', scoped]]), []).kind).toBe('unknown');
  });
});

describe('refusalForWorkload', () => {
  it('picks the workload\'s own refusal out of the namespace\'s evidence', () => {
    expect(refusalForWorkload(PROD_DETAIL, 'private-worker-server')?.requested).toEqual({ 'requests.cpu': '25m' });
    expect(refusalForWorkload(PROD_DETAIL, 'sitewright')?.requested).toEqual({ 'requests.cpu': '30m' });
    expect(refusalForWorkload(PROD_DETAIL, 'blog')).toBeNull();
  });
});

describe('describeQuotaRefusal', () => {
  it('names the resource and the figures', () => {
    expect(describeQuotaRefusal(PROD_DETAIL)).toBe('requests.cpu: 525m of 530m in use, 30m more needed');
    expect(describeQuotaRefusal('CrashLoopBackOff')).toBeNull();
  });
});
