/**
 * Enabling mail writes MX/SPF/DMARC/DKIM records server-side. The panel showed
 * the pre-mail DNS Records list until the operator reloaded the page, because
 * `useEnableEmailDomain` invalidated `email-domains` and `mailbox-usage` but
 * never `dns-records`.
 *
 * These tests assert the CACHE BEHAVIOUR — that an observed dns-records query
 * actually refetches — rather than grepping for an invalidateQueries call. A
 * test that only checked the call could pass with the wrong query key, which
 * is precisely how the bug looked: an invalidation was there, just not for
 * this key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import React from 'react';
import { apiFetch } from '@/lib/api-client';
import { useEnableEmailDomain, useDisableEmailDomain } from './use-email';

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn() }));
const mockApiFetch = vi.mocked(apiFetch);

const TENANT = 'tenant-1';
const DOMAIN = 'domain-1';

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

describe('mail mutations refresh the DNS Records list', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({ data: [] } as never);
  });

  it('enabling mail refetches an observed dns-records query', async () => {
    const client = makeClient();
    const recordsFn = vi.fn().mockResolvedValue({ data: [] });

    // Observe dns-records the way the DomainDetail page does — an unobserved
    // query is not refetched by invalidation, so this has to be live.
    const { result } = renderHook(
      () => ({
        records: useQuery({ queryKey: ['dns-records', TENANT, DOMAIN], queryFn: recordsFn }),
        enable: useEnableEmailDomain(TENANT),
      }),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.records.isSuccess).toBe(true));
    expect(recordsFn).toHaveBeenCalledTimes(1);

    await result.current.enable.mutateAsync({ domainId: DOMAIN, input: {} });

    await waitFor(() => expect(recordsFn).toHaveBeenCalledTimes(2));
  });

  it('disabling mail refetches it too — the records are removed server-side', async () => {
    const client = makeClient();
    const recordsFn = vi.fn().mockResolvedValue({ data: [] });

    const { result } = renderHook(
      () => ({
        records: useQuery({ queryKey: ['dns-records', TENANT, DOMAIN], queryFn: recordsFn }),
        disable: useDisableEmailDomain(TENANT),
      }),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.records.isSuccess).toBe(true));
    expect(recordsFn).toHaveBeenCalledTimes(1);

    await result.current.disable.mutateAsync(DOMAIN);

    await waitFor(() => expect(recordsFn).toHaveBeenCalledTimes(2));
  });

  it('invalidates by prefix, so any domain\'s record list refreshes', async () => {
    // The key is ['dns-records', tenantId, domainId]. Enabling mail on one
    // domain must not leave a different domain's cached list stale either —
    // the operator may have both open across tabs of the same page.
    const client = makeClient();
    const otherFn = vi.fn().mockResolvedValue({ data: [] });

    const { result } = renderHook(
      () => ({
        other: useQuery({ queryKey: ['dns-records', TENANT, 'domain-2'], queryFn: otherFn }),
        enable: useEnableEmailDomain(TENANT),
      }),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.other.isSuccess).toBe(true));
    await result.current.enable.mutateAsync({ domainId: DOMAIN, input: {} });

    await waitFor(() => expect(otherFn).toHaveBeenCalledTimes(2));
  });
});
