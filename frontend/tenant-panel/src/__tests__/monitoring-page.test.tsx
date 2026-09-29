/**
 * Monitoring replaced Resource Usage as a page, and a rename is exactly the
 * kind of change that leaves a dead link behind: the sidebar points at a path
 * the router no longer declares, and nothing fails until somebody clicks it.
 *
 * So these check the wiring, not the styling — the tabs render, the legacy
 * path still lands somewhere real, and every sidebar target matches a route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// `?raw` rather than node:fs — this suite runs in a browser environment,
// where node types are not available and `readFileSync` does not exist.
import sidebarSrc from '../components/layout/Sidebar.tsx?raw';
import appSrc from '../App.tsx?raw';
import registrySrc from '../search/registry.ts?raw';

vi.mock('@/components/traffic/TenantTrafficTab', () => ({
  default: () => <div data-testid="traffic-tab-stub">traffic</div>,
}));
vi.mock('@/pages/ResourceUsage', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="resource-tab-stub">{embedded ? 'embedded' : 'standalone'}</div>
  ),
}));

const Monitoring = (await import('@/pages/Monitoring')).default;

function renderAt(path: string, element: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="*" element={element} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('tenant Monitoring page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lands on Traffic and shows both tabs', () => {
    renderAt('/monitoring', <Monitoring />);
    expect(screen.getByTestId('monitoring-heading')).toHaveTextContent('Monitoring');
    expect(screen.getByTestId('monitoring-tab-traffic')).toBeInTheDocument();
    expect(screen.getByTestId('monitoring-tab-resource-usage')).toBeInTheDocument();
    expect(screen.getByTestId('traffic-tab-stub')).toBeInTheDocument();
  });

  it('switches to Resource Usage and embeds it without a second heading', async () => {
    const user = userEvent.setup();
    renderAt('/monitoring', <Monitoring />);
    await user.click(screen.getByTestId('monitoring-tab-resource-usage'));
    expect(screen.getByTestId('resource-tab-stub')).toHaveTextContent('embedded');
  });

  it('honours an explicit ?tab=', () => {
    renderAt('/monitoring?tab=resource-usage', <Monitoring />);
    expect(screen.getByTestId('resource-tab-stub')).toBeInTheDocument();
  });

  it('declares the legacy path as a REDIRECT, not a second mount', () => {
    // Mounting the page at two URLs would give Monitoring two canonical
    // addresses and list it twice in search.
    expect(appSrc).toMatch(/path="resource-usage"[\s\S]{0,160}<Navigate to="\/monitoring\?tab=resource-usage" replace/);
  });

  it('ignores a nonsense ?tab= rather than rendering nothing', () => {
    renderAt('/monitoring?tab=wat', <Monitoring />);
    expect(screen.getByTestId('traffic-tab-stub')).toBeInTheDocument();
  });
});

describe('navigation targets resolve', () => {
  it('every sidebar link matches a declared route', () => {
    // A rename that misses one surface produces a link to nowhere, and the
    // only symptom is a blank page for whoever clicks it.
    const sidebar = sidebarSrc;
    const app = appSrc;
    const declared = new Set(
      [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map(([, p]) => p.replace(/^\//, '')),
    );
    const targets = [...sidebar.matchAll(/to:\s*'\/([^']*)'/g)].map(([, p]) => p.split('?')[0]);
    expect(targets.length).toBeGreaterThan(3);
    for (const t of targets) {
      if (t === '') continue; // index route
      expect(declared, `sidebar links /${t}`).toContain(t);
    }
  });

  it('the sidebar points at Monitoring, not the retired path', () => {
    expect(sidebarSrc).toContain("to: '/monitoring'");
    expect(sidebarSrc).not.toContain("to: '/resource-usage'");
  });

  it('keeps the legacy route declared so bookmarks still resolve', () => {
    expect(appSrc).toContain('path="resource-usage"');
  });

  it('every search registry target resolves to a declared route', () => {
    const declared = new Set(
      [...appSrc.matchAll(/<Route\s+path="([^"]+)"/g)].map(([, p]) => p.replace(/^\//, '')),
    );
    for (const [, to] of registrySrc.matchAll(/to:\s*'\/([^']*)'/g)) {
      const path = to.split('?')[0];
      if (path === '') continue;
      expect(declared, `registry links /${path}`).toContain(path);
    }
  });
});
