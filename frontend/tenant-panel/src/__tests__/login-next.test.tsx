/**
 * "Login as tenant" from an admin link lands on the page the link was about
 * (`next`), and only ever on a page of this panel.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Login from '../pages/Login';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const USER = encodeURIComponent(JSON.stringify({ id: 'u1', email: 'owner@example.test', role: 'tenant_admin', panel: 'tenant', tenantId: 't1' }));

function renderAt(url: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<p>Home page</p>} />
          <Route path="/email/:tab?" element={<p>Email page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue({ data: { localAuthEnabled: true, providers: [] } });
});

describe('impersonation login', () => {
  it('lands on the page named by next', async () => {
    renderAt(`/login?token=t&user=${USER}&next=${encodeURIComponent('/email/mailboxes?mailbox=m1')}`);
    expect(await screen.findByText('Email page')).toBeInTheDocument();
  });

  it('lands on the home page without next', async () => {
    renderAt(`/login?token=t&user=${USER}`);
    expect(await screen.findByText('Home page')).toBeInTheDocument();
  });

  it('never follows a next that leaves this panel', async () => {
    renderAt(`/login?token=t&user=${USER}&next=${encodeURIComponent('//evil.example/steal')}`);
    expect(await screen.findByText('Home page')).toBeInTheDocument();
  });
});
