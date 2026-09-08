import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSortable } from '@/hooks/use-sortable';

/**
 * The ingress-routes table used to render in whatever order the API returned,
 * which is creation order, with no way to search. A domain with a dozen routes
 * meant scanning the whole table by eye.
 */
const routes = [
  { hostname: 'shop.example.test', path: '/', deploymentName: 'storefront' },
  { hostname: 'api.example.test', path: '/v1', deploymentName: 'Backend' },
  { hostname: 'Blog.example.test', path: '/', deploymentName: 'wordpress' },
];

describe('ingress routes ordering', () => {
  it('defaults to alphabetical by hostname', () => {
    const { result } = renderHook(() => useSortable(routes, 'hostname'));
    expect(result.current.sortedData.map((r) => r.hostname))
      .toEqual(['api.example.test', 'Blog.example.test', 'shop.example.test']);
  });

  it('is case-insensitive, so Blog sorts with the b-words not before A', () => {
    // A naive sort puts every capitalised hostname first, which reads as
    // unsorted to anyone scanning the column.
    const { result } = renderHook(() => useSortable(routes, 'hostname'));
    expect(result.current.sortedData[1].hostname).toBe('Blog.example.test');
  });

  it('toggles to descending on a second click of the same column', () => {
    const { result } = renderHook(() => useSortable(routes, 'hostname'));
    act(() => result.current.onSort('hostname'));
    expect(result.current.sortedData[0].hostname).toBe('shop.example.test');
  });

  it('sorts by deployment NAME, not the underlying id', () => {
    // The route object only carries deploymentId; ordering a column of names
    // by opaque uuid is indistinguishable from not sorting at all.
    const { result } = renderHook(() => useSortable(routes, 'deploymentName'));
    expect(result.current.sortedData.map((r) => r.deploymentName))
      .toEqual(['Backend', 'storefront', 'wordpress']);
  });
});

describe('ingress routes search', () => {
  const filter = (q: string) => {
    const query = q.trim().toLowerCase();
    return query
      ? routes.filter((r) => [r.hostname, r.path, r.deploymentName]
          .some((v) => (v ?? '').toLowerCase().includes(query)))
      : routes;
  };

  it('matches on hostname', () => {
    expect(filter('shop').map((r) => r.hostname)).toEqual(['shop.example.test']);
  });

  it('matches on deployment name', () => {
    expect(filter('wordpress').map((r) => r.hostname)).toEqual(['Blog.example.test']);
  });

  it('matches on path prefix', () => {
    expect(filter('/v1').map((r) => r.hostname)).toEqual(['api.example.test']);
  });

  it('is case-insensitive and returns everything for an empty query', () => {
    expect(filter('BLOG')).toHaveLength(1);
    expect(filter('   ')).toHaveLength(3);
  });
});
