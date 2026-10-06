import { describe, it, expect } from 'vitest';
import { parseTrafficUrlState, trafficTabUrl, withSelectedOption } from '@/components/traffic/traffic-url';

describe('parseTrafficUrlState', () => {
  it('reads a tenant, its namespace and a 7-day range', () => {
    expect(parseTrafficUrlState('?scope=tenant&subject=tenant-acme-1a2b3c4d&range=7d')).toEqual({
      scope: 'tenant', subject: 'tenant-acme-1a2b3c4d', pod: null, metric: 'traffic', range: '7d',
    });
  });

  it('defaults to the cluster over 24 hours', () => {
    expect(parseTrafficUrlState('')).toEqual({
      scope: 'cluster', subject: null, pod: null, metric: 'traffic', range: '24h',
    });
  });

  it('ignores values it does not recognise rather than erroring', () => {
    expect(parseTrafficUrlState('?scope=backup-class&range=2w&metric=bogus')).toMatchObject({
      scope: 'cluster', range: '24h', metric: 'traffic',
    });
  });

  it('drops a subject on the cluster view and an over-long or blank one anywhere', () => {
    expect(parseTrafficUrlState('?scope=cluster&subject=x').subject).toBeNull();
    expect(parseTrafficUrlState(`?scope=node&subject=${'a'.repeat(254)}`).subject).toBeNull();
    expect(parseTrafficUrlState('?scope=node&subject=%20%20').subject).toBeNull();
  });

  it('keeps a pod only on the pod view, which answers traffic only', () => {
    expect(parseTrafficUrlState('?scope=pod&subject=ns&pod=web-1&metric=latency')).toMatchObject({
      scope: 'pod', subject: 'ns', pod: 'web-1', metric: 'traffic',
    });
    expect(parseTrafficUrlState('?scope=route&pod=web-1&metric=latency')).toMatchObject({ pod: null, metric: 'latency' });
  });
});

describe('trafficTabUrl', () => {
  it('builds the link the tenant page uses, and it parses back', () => {
    const url = trafficTabUrl({ scope: 'tenant', subject: 'tenant-acme-1a2b3c4d', range: '7d' });
    expect(url).toBe('/monitoring?scope=tenant&subject=tenant-acme-1a2b3c4d&range=7d');
    expect(parseTrafficUrlState(url.slice(url.indexOf('?')))).toMatchObject({
      scope: 'tenant', subject: 'tenant-acme-1a2b3c4d', range: '7d',
    });
  });

  it('leaves defaults out', () => {
    expect(trafficTabUrl({ scope: 'cluster', range: '24h', metric: 'traffic' })).toBe('/monitoring');
  });
});

describe('withSelectedOption', () => {
  const ranked = [{ key: 'tenant-a', label: 'Tenant A', meta: '1 GB' }];

  it('leaves the list alone when nothing is chosen or the choice is listed', () => {
    expect(withSelectedOption(ranked, null)).toBe(ranked);
    expect(withSelectedOption(ranked, 'tenant-a')).toBe(ranked);
  });

  it('lists a chosen subject the traffic ranking left out, under its key', () => {
    expect(withSelectedOption(ranked, 'tenant-new-1a2b3c4d')).toEqual([
      { key: 'tenant-new-1a2b3c4d', label: 'tenant-new-1a2b3c4d', meta: 'no traffic in range' },
      ...ranked,
    ]);
  });
});
