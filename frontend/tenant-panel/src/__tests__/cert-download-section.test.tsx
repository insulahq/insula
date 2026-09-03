import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CertDownloadSection from '../components/CertDownloadSection';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const mockApiFetch = vi.mocked(apiFetch);

const AVAILABLE = {
  data: { available: true, source: 'managed', reason: null, expiresAt: '2027-01-01T00:00:00Z' },
};

function renderSection(canManage = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CertDownloadSection tenantId="t-1" domainId="d-1" domainName="example.test" canManage={canManage} />
    </QueryClientProvider>,
  );
}

function route(handlers: { availability?: unknown; tokens?: unknown; create?: unknown }) {
  mockApiFetch.mockImplementation((path: string) => {
    if (path.includes('download-availability')) return Promise.resolve(handlers.availability ?? AVAILABLE);
    if (path.includes('cert-tokens')) {
      return Promise.resolve(handlers.create && path.endsWith('cert-tokens')
        ? handlers.create
        : handlers.tokens ?? { data: [] });
    }
    return Promise.resolve({ data: [] });
  });
}

describe('CertDownloadSection', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('enables the download button when a certificate exists', async () => {
    route({});
    renderSection();
    await waitFor(() => {
      expect((screen.getByTestId('download-cert-button') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('disables download and explains why when no certificate has been issued', async () => {
    route({ availability: { data: { available: false, source: null, reason: 'No certificate has been issued for this domain yet.', expiresAt: null } } });
    renderSection();
    expect(await screen.findByTestId('download-unavailable')).toBeTruthy();
    expect((screen.getByTestId('download-cert-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks download for a role that cannot manage', async () => {
    route({});
    renderSection(false);
    await waitFor(() => {
      expect((screen.getByTestId('download-cert-button') as HTMLButtonElement).disabled).toBe(true);
    });
    expect(screen.queryByTestId('new-cert-token-button')).toBeNull();
  });

  it('warns that the file contains the private key', async () => {
    route({});
    renderSection();
    expect(await screen.findByText(/contains the private key/i)).toBeTruthy();
  });

  // The secret is unrecoverable after this render — if the UI does not make
  // that obvious, customers will close the panel and lose it.
  it('shows a newly created token once, with a copy control and a keep-it warning', async () => {
    const created = {
      data: {
        id: 'tok-1', domainId: 'd-1', name: 'deploy', expiresAt: null,
        lastUsedAt: null, createdAt: '2026-09-03T00:00:00Z', expired: false,
        token: 'insula_cert_SECRETVALUE',
      },
    };
    mockApiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path.includes('download-availability')) return Promise.resolve(AVAILABLE);
      if (path.includes('cert-tokens') && opts?.method === 'POST') return Promise.resolve(created);
      if (path.includes('cert-tokens')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    renderSection();
    fireEvent.click(await screen.findByTestId('new-cert-token-button'));
    fireEvent.change(screen.getByTestId('cert-token-name-input'), { target: { value: 'deploy' } });
    fireEvent.click(screen.getByTestId('submit-cert-token'));

    const minted = await screen.findByTestId('minted-token');
    expect(screen.getByTestId('minted-token-value').textContent).toBe('insula_cert_SECRETVALUE');
    expect(screen.getByTestId('copy-token-button')).toBeTruthy();
    expect(minted.textContent).toMatch(/only time it is shown/i);
  });

  it('lists existing tokens with last-used and offers revoke', async () => {
    route({
      tokens: {
        data: [{
          id: 'tok-9', domainId: 'd-1', name: 'staging-server',
          expiresAt: '2027-01-01T00:00:00Z', lastUsedAt: '2026-09-01T00:00:00Z',
          createdAt: '2026-08-01T00:00:00Z', expired: false,
        }],
      },
    });
    renderSection();
    expect(await screen.findByTestId('cert-token-tok-9')).toBeTruthy();
    expect(screen.getByTestId('cert-token-tok-9').textContent).toContain('staging-server');
    expect(screen.getByTestId('revoke-tok-9')).toBeTruthy();
  });

  it('requires confirmation before revoking', async () => {
    route({
      tokens: { data: [{ id: 'tok-9', domainId: 'd-1', name: 'x', expiresAt: null, lastUsedAt: null, createdAt: '2026-08-01T00:00:00Z', expired: false }] },
    });
    renderSection();
    fireEvent.click(await screen.findByTestId('revoke-tok-9'));
    expect(screen.getByTestId('confirm-revoke-tok-9')).toBeTruthy();
  });

  // An error rendering as "No tokens yet" reads as "nothing to revoke" on a
  // screen about live credentials.
  it('does NOT render a load failure as an empty token list', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.includes('download-availability')) return Promise.resolve(AVAILABLE);
      if (path.includes('cert-tokens')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ data: [] });
    });
    renderSection();
    expect(await screen.findByTestId('cert-tokens-error')).toBeTruthy();
    expect(screen.queryByTestId('no-cert-tokens')).toBeNull();
  });

  it('shows the curl example against the token endpoint', async () => {
    route({});
    renderSection();
    expect(await screen.findByText(/how to use a token/i)).toBeTruthy();
    expect(screen.getByText(/\/api\/v1\/certs\/example\.test\/download/)).toBeTruthy();
  });
});
