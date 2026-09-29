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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

  it('sends the legacy /resource-usage path to the tab it used to be', () => {
    renderAt('/resource-usage', <Monitoring defaultTab="resource-usage" />);
    expect(screen.getByTestId('resource-tab-stub')).toBeInTheDocument();
  });

  it('ignores a nonsense ?tab= rather than rendering nothing', () => {
    renderAt('/monitoring?tab=wat', <Monitoring />);
    expect(screen.getByTestId('traffic-tab-stub')).toBeInTheDocument();
  });
});

describe('navigation targets resolve', () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('every sidebar link matches a declared route', () => {
    // A rename that misses one surface produces a link to nowhere, and the
    // only symptom is a blank page for whoever clicks it.
    const sidebar = read('../components/layout/Sidebar.tsx');
    const app = read('../App.tsx');
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
    const sidebar = read('../components/layout/Sidebar.tsx');
    expect(sidebar).toContain("to: '/monitoring'");
    expect(sidebar).not.toContain("to: '/resource-usage'");
  });

  it('keeps the legacy route declared so bookmarks still resolve', () => {
    expect(read('../App.tsx')).toContain('path="resource-usage"');
  });
});
