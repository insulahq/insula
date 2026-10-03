/**
 * Tabs live in the URL path (/monitoring/slos), so every surface can link to
 * one. These pin the URL contract: the path form, the legacy ?tab= form that
 * old links and stored notifications still carry, and the fallback for a tab
 * that does not exist — which must land on the page, never on "Page Not Found".
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import TabRoute from '@/routes/TabRoute';
import { resolveTab, useTabParam } from '@/hooks/use-tab-param';

const TABS = ['traffic', 'slos', 'health'] as const;

describe('resolveTab', () => {
  it('reads the tab from the path', () => {
    expect(resolveTab(TABS, '/monitoring/slos', '', 'slos')).toEqual({
      active: 'slos', base: '/monitoring', search: '', canonical: null,
    });
  });

  it('the bare page is the default tab', () => {
    expect(resolveTab(TABS, '/monitoring', '', undefined).active).toBe('traffic');
  });

  it('rewrites a legacy ?tab= to the path form, keeping the other parameters', () => {
    expect(resolveTab(TABS, '/monitoring', '?tab=slos&range=24h', undefined).canonical)
      .toEqual({ pathname: '/monitoring/slos', search: '?range=24h' });
    // The default tab's canonical form is the bare page.
    expect(resolveTab(TABS, '/monitoring', '?tab=traffic', undefined).canonical)
      .toEqual({ pathname: '/monitoring', search: '' });
  });

  it('falls back to the default view for a tab that does not exist, and says so in the URL', () => {
    // The dashboard SLO tile linked here — `slo`, not `slos`.
    expect(resolveTab(TABS, '/monitoring/slo', '', 'slo')).toEqual({
      active: 'traffic', base: '/monitoring', search: '', canonical: { pathname: '/monitoring', search: '' },
    });
    expect(resolveTab(TABS, '/monitoring', '?tab=nope', undefined).canonical)
      .toEqual({ pathname: '/monitoring', search: '' });
  });

  it('works under a parameterised page', () => {
    expect(resolveTab(['domains', 'backups'], '/tenants/abc/backups/', '', 'backups'))
      .toMatchObject({ active: 'backups', base: '/tenants/abc', canonical: null });
  });
});

function Page() {
  const [tab, setTab] = useTabParam('/monitoring');
  const loc = useLocation();
  return (
    <div>
      <span data-testid="tab">{tab}</span>
      <span data-testid="url">{loc.pathname + loc.search}</span>
      <button type="button" onClick={() => setTab('resource-usage')}>slos</button>
      <button type="button" onClick={() => setTab('traffic')}>traffic</button>
    </div>
  );
}

/** Mounted exactly as App.tsx mounts a tabbed page. */
function at(url: string, page = <Page />) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes><Route path="/monitoring/:tab?" element={<TabRoute page="/monitoring">{page}</TabRoute>} /></Routes>
    </MemoryRouter>,
  );
}

/** A tab that consumes a one-shot query param on mount and strips it (NetworkTrust `?prefill=`). */
function PrefillConsumer({ seen }: { readonly seen: (v: string | null) => void }) {
  const [params, setParams] = useSearchParams();
  const [prefill] = useState(() => params.get('prefill'));
  useEffect(() => {
    seen(prefill);
    if (prefill) {
      const next = new URLSearchParams(params);
      next.delete('prefill');
      setParams(next, { replace: true });
    }
  }, []);
  return null;
}

describe('useTabParam on a real route', () => {
  it('opens the tab named in the path', () => {
    at('/monitoring/resource-usage');
    expect(screen.getByTestId('tab')).toHaveTextContent('resource-usage');
    expect(screen.getByTestId('url')).toHaveTextContent('/monitoring/resource-usage');
  });

  it('honours an old ?tab= link and moves it into the path', async () => {
    at('/monitoring?tab=resource-usage&range=7d');
    expect(screen.getByTestId('tab')).toHaveTextContent('resource-usage');
    expect(await screen.findByText('/monitoring/resource-usage?range=7d')).toBeInTheDocument();
  });

  it('lands on the page — not "Page Not Found" — for a tab that does not exist', async () => {
    at('/monitoring/slo');
    expect(screen.getByTestId('tab')).toHaveTextContent('traffic');
    expect(await screen.findByText('/monitoring')).toBeInTheDocument();
  });

  it('canonicalises BEFORE the page mounts, so a tab consuming its own query param is not raced', async () => {
    // The legacy deep link the SSH-lockdown modal used to emit. Rewriting the
    // URL from inside the page raced this consumer: `prefill` stayed in the URL.
    const seen: Array<string | null> = [];
    at('/monitoring?tab=resource-usage&prefill=1.2.3.4', <><Page /><PrefillConsumer seen={(v) => seen.push(v)} /></>);
    expect(await screen.findByText('/monitoring/resource-usage')).toBeInTheDocument();
    expect(screen.getByTestId('tab')).toHaveTextContent('resource-usage');
    expect(seen).toEqual(['1.2.3.4']);
  });

  it('switching tabs writes the path; the default tab is the bare page', async () => {
    const user = userEvent.setup();
    at('/monitoring');
    await user.click(screen.getByText('slos'));
    expect(screen.getByTestId('url')).toHaveTextContent('/monitoring/resource-usage');
    await user.click(screen.getByText('traffic'));
    expect(screen.getByTestId('url')).toHaveTextContent(/^\/monitoring$/);
  });
});
