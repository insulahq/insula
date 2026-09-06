/**
 * The Banned-IPs filters are built into a query OBJECT by the component and
 * turned into a query STRING by the hook. Those two lists drifted: the hook
 * forwarded only q / scope / manualOnly, so `staticOnly` and `autoOnly` were
 * silently dropped and the backend — which supports both — never saw them.
 *
 * The visible symptom on production was a Static Blocklist that read as empty
 * while the ban was sitting in the LAPI, because the unfiltered response put
 * 16,220 community decisions in front of 2 platform ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CrowdsecListDecisionsQuery } from '@insula/api-contracts';

const apiFetch = vi.fn().mockResolvedValue({ data: { decisions: [], totalActive: 0, totalMatching: 0, limit: 0, offset: 0 } });
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryFn: () => unknown }) => { opts.queryFn(); return { data: undefined }; },
  useMutation: () => ({ mutate: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

async function urlFor(query: CrowdsecListDecisionsQuery): Promise<string> {
  apiFetch.mockClear();
  const { useCrowdsecDecisions } = await import('./use-crowdsec.js');
  useCrowdsecDecisions(query);
  return String(apiFetch.mock.calls[0][0]);
}

beforeEach(() => { vi.resetModules(); });

describe('useCrowdsecDecisions query string', () => {
  it('forwards staticOnly — the filter that silently did nothing', async () => {
    expect(await urlFor({ staticOnly: true })).toContain('staticOnly=true');
  });

  it('forwards autoOnly', async () => {
    expect(await urlFor({ autoOnly: true })).toContain('autoOnly=true');
  });

  it('forwards source, limit and offset for the community viewer', async () => {
    const url = await urlFor({ source: 'community', limit: 50, offset: 100 });
    expect(url).toContain('source=community');
    expect(url).toContain('limit=50');
    expect(url).toContain('offset=100');
  });

  it('still forwards the original three', async () => {
    const url = await urlFor({ q: '1.2.3.4', scope: 'Ip', manualOnly: true });
    expect(url).toContain('q=1.2.3.4');
    expect(url).toContain('scope=Ip');
    expect(url).toContain('manualOnly=true');
  });

  it('omits falsey filters rather than sending them as "false"', async () => {
    // `manualOnly=false` would be coerced to TRUE by z.coerce.boolean() on the
    // backend, turning an unticked checkbox into an active filter.
    const url = await urlFor({ manualOnly: false, staticOnly: false, q: '' });
    expect(url).not.toContain('manualOnly');
    expect(url).not.toContain('staticOnly');
    expect(url).not.toContain('q=');
  });
});
