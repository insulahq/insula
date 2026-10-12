/**
 * Email → Operations no longer carries the mail archive.
 *
 * The archive (Stalwart's `stalwart -e` export) is switched off in the backend,
 * which registers none of its routes any more. The page used to give it a tab
 * of its own; a card left mounted would now call routes that answer 404 and
 * show an operator an error for a feature that is gone.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EmailOperationsPage from '../pages/email/EmailOperationsPage';
import TabRoute from '../routes/TabRoute';
import { TABBED_PAGES } from '../routes/tabbed-pages';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="email/operations/:tab?" element={<TabRoute page="/email/operations"><EmailOperationsPage /></TabRoute>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Email → Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No request is ever answered: every card stays in its loading state. This test is about
    // which requests are made and which tabs exist, not about what the cards show.
    mockApiFetch.mockImplementation(() => new Promise<never>(() => {}));
  });

  it('has two tabs: placement and storage', () => {
    expect(TABBED_PAGES['/email/operations']).toEqual(['placement', 'storage']);
    renderAt('/email/operations');
    expect(screen.getByTestId('ops-tab-placement')).toBeInTheDocument();
    expect(screen.getByTestId('ops-tab-storage')).toBeInTheDocument();
    expect(screen.queryByTestId('ops-tab-backups')).not.toBeInTheDocument();
  });

  it('an old link to the Backups tab lands on the page, not on an error', () => {
    renderAt('/email/operations/backups');
    expect(screen.getByTestId('ops-tab-placement')).toBeInTheDocument();
  });

  it.each(['/email/operations', '/email/operations/storage', '/email/operations/backups'])(
    '%s calls no mail archive route and shows no archive control',
    async (path) => {
      renderAt(path);
      await new Promise((r) => setTimeout(r, 50));
      const urls = mockApiFetch.mock.calls.map((c) => String(c[0]));
      expect(urls.filter((u) => u.includes('/mail/archive'))).toEqual([]);
      expect(screen.queryByText(/archive/i)).not.toBeInTheDocument();
    },
  );
});
