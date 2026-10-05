/**
 * listDecisions asks the LAPI for platform origins only.
 *
 * The Banned IPs list (polled every 15s per open tab) and the dashboard's
 * ban count both read `source=platform`. Production held ~16k community
 * decisions against a handful of platform ones, and every one of those reads
 * pulled the whole set only to discard it client-side. The LAPI's `origins`
 * filter is an exact match on the decision origin — verified on DEV: with
 * crowdsec, cscli and cscli-import decisions present, `origins=cscli,crowdsec`
 * returned exactly the first two — so it selects the same set
 * isPlatformOrigin keeps.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as k8sModule from '../container-console/service.js';
import { listDecisions, PLATFORM_ORIGINS, isPlatformOrigin } from './crowdsec.js';

const lapiRow = (id: number, origin: string, value: string) => ({
  id, origin, type: 'ban', scope: 'Ip', value, scenario: 'crowdsecurity/http-probing', duration: '1h',
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const fakeKc = {
    makeApiClient: () => ({
      readNamespacedSecret: async () => ({ data: { 'bouncer-key': Buffer.from('test-key').toString('base64') } }),
    }),
  };
  vi.spyOn(k8sModule, 'createKubeConfig').mockReturnValue(fakeKc as never);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const respond = (rows: unknown[]) => fetchMock.mockResolvedValue(
  new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } }),
);

const requestedPath = (): string => new URL(String(fetchMock.mock.calls[0][0])).pathname
  + new URL(String(fetchMock.mock.calls[0][0])).search;

describe('listDecisions — origin filter pushed to the LAPI', () => {
  it('asks for platform origins only when listing platform bans', async () => {
    respond([lapiRow(1, 'crowdsec', '203.0.113.1')]);
    await listDecisions(undefined, { source: 'platform' });
    expect(requestedPath()).toBe('/v1/decisions?origins=cscli,crowdsec');
  });

  it('does the same for the default source, which is platform', async () => {
    respond([]);
    await listDecisions(undefined, {});
    expect(requestedPath()).toBe('/v1/decisions?origins=cscli,crowdsec');
  });

  it('fetches everything for the community view — its set is "every other origin"', async () => {
    respond([]);
    await listDecisions(undefined, { source: 'community', limit: 50 });
    expect(requestedPath()).toBe('/v1/decisions');
  });

  it('fetches everything for source=all', async () => {
    respond([]);
    await listDecisions(undefined, { source: 'all', limit: 1 });
    expect(requestedPath()).toBe('/v1/decisions');
  });

  it('still keeps only platform rows if a LAPI ignores the filter', async () => {
    // An older LAPI without `origins` support would return everything; the
    // client-side filter is the backstop, so the list cannot grow wrong.
    respond([
      lapiRow(1, 'crowdsec', '203.0.113.1'),
      lapiRow(2, 'cscli', '203.0.113.2'),
      lapiRow(3, 'CAPI', '198.51.100.3'),
      lapiRow(4, 'cscli-import', '198.51.100.4'),
      lapiRow(5, 'lists:example', '198.51.100.5'),
    ]);
    const r = await listDecisions(undefined, { source: 'platform' });
    expect(r.decisions.map((d) => d.value)).toEqual(['203.0.113.1', '203.0.113.2']);
  });

  it('queries exactly the origins isPlatformOrigin accepts — one definition', () => {
    for (const o of PLATFORM_ORIGINS) expect(isPlatformOrigin(o)).toBe(true);
    for (const o of ['CAPI', 'cscli-import', 'lists:example', 'console', '']) {
      expect(isPlatformOrigin(o)).toBe(false);
    }
  });
});
