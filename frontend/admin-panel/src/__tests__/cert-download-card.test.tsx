import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CertDownloadCard from '../components/CertDownloadCard';
import { apiFetch } from '@/lib/api-client';
import { useCanManageCerts } from '@/hooks/use-can-manage-certs';

vi.mock('@/hooks/use-can-manage-certs', () => ({ useCanManageCerts: vi.fn(() => true) }));
vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly details?: Record<string, unknown>,
    ) { super(message); }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

const AVAILABLE = {
  data: { available: true, source: 'managed', reason: null, expiresAt: '2027-01-01T00:00:00Z' },
};
const ONE_TOKEN = {
  data: [{
    id: 'tok-9', domainId: 'd-1', name: 'customer-server',
    expiresAt: null, lastUsedAt: '2026-09-01T00:00:00Z',
    createdAt: '2026-08-01T00:00:00Z', expired: false,
  }],
};

function renderCard(canManage = true) {
  vi.mocked(useCanManageCerts).mockReturnValue(canManage);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CertDownloadCard tenantId="t-1" domainId="d-1" domainName="example.test" />
    </QueryClientProvider>,
  );
}

function route(tokens: unknown = { data: [] }) {
  mockApiFetch.mockImplementation((path: string) => {
    if (path.includes('download-availability')) return Promise.resolve(AVAILABLE);
    if (path.includes('cert-tokens')) return Promise.resolve(tokens);
    return Promise.resolve({ data: [] });
  });
}

describe('CertDownloadCard (admin)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(useCanManageCerts).mockReturnValue(true);
  });

  it('enables download for a role that may hold key material', async () => {
    route();
    renderCard();
    await waitFor(() => {
      expect((screen.getByTestId('admin-download-cert-button') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  // `support` reaches this page but is excluded from every key-bearing route
  // on the backend. An enabled button here would just 403 on click.
  it('disables download and hides revoke for support', async () => {
    route(ONE_TOKEN);
    renderCard(false);
    await waitFor(() => {
      expect((screen.getByTestId('admin-download-cert-button') as HTMLButtonElement).disabled).toBe(true);
    });
    expect(screen.getByTestId('admin-cert-readonly')).toBeTruthy();
    await screen.findByText('customer-server');
    // The token is still listed — support may look — but cannot revoke it.
    expect(screen.queryByTestId('admin-revoke-tok-9')).toBeNull();
  });

  // Creating a token mints a secret shown exactly once; it belongs to the
  // customer, so the admin panel must not offer it at all.
  it('never offers a create-token control', async () => {
    route(ONE_TOKEN);
    renderCard();
    await screen.findByText('customer-server');
    // Assert on CONTROLS, not prose — the card explains in text that tokens
    // are created in the customer's panel, which a loose text match hits.
    const buttons = screen.queryAllByRole('button').map((b) => b.textContent ?? '');
    expect(buttons.some((t) => /new token|create token/i.test(t))).toBe(false);
    expect(screen.queryByTestId('new-cert-token-button')).toBeNull();
  });

  it('lists customer tokens with last-used and offers revoke to admins', async () => {
    route(ONE_TOKEN);
    renderCard();
    expect(await screen.findByText('customer-server')).toBeTruthy();
    expect(screen.getByTestId('admin-revoke-tok-9')).toBeTruthy();
  });

  it('requires confirmation before revoking', async () => {
    route(ONE_TOKEN);
    renderCard();
    fireEvent.click(await screen.findByTestId('admin-revoke-tok-9'));
    expect(screen.getByTestId('admin-confirm-revoke-tok-9')).toBeTruthy();
  });

  it('surfaces a revoke failure instead of leaving the row stuck confirming', async () => {
    mockApiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path.includes('download-availability')) return Promise.resolve(AVAILABLE);
      if (path.includes('cert-tokens') && opts?.method === 'DELETE') return Promise.reject(new Error('already gone'));
      if (path.includes('cert-tokens')) return Promise.resolve(ONE_TOKEN);
      return Promise.resolve({ data: [] });
    });
    renderCard();
    fireEvent.click(await screen.findByTestId('admin-revoke-tok-9'));
    fireEvent.click(screen.getByTestId('admin-confirm-revoke-tok-9'));

    expect((await screen.findByTestId('admin-revoke-error')).textContent).toContain('already gone');
    await waitFor(() => expect(screen.queryByTestId('admin-confirm-revoke-tok-9')).toBeNull());
  });

  it('does NOT render a token-load failure as an empty list', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.includes('download-availability')) return Promise.resolve(AVAILABLE);
      if (path.includes('cert-tokens')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ data: [] });
    });
    renderCard();
    expect(await screen.findByTestId('admin-cert-tokens-error')).toBeTruthy();
    expect(screen.queryByText('No tokens issued.')).toBeNull();
  });

  it('warns that the file holds the customer private key and is audited', async () => {
    route();
    renderCard();
    expect(await screen.findByText(/private key. Every download is recorded/i)).toBeTruthy();
  });

  // The bundle holds the customer's private key: the server asks the operator
  // for a fresh step-up, and the card asks before repeating the download.
  it('asks the operator to confirm it is them before downloading, then downloads', async () => {
    let stepped = false;
    mockApiFetch.mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/api/v1/me/step-up/password' && opts?.method === 'POST') { stepped = true; return Promise.resolve({ data: { ok: true } }); }
      if (path.includes('download-availability')) return Promise.resolve(AVAILABLE);
      return Promise.resolve({ data: [] });
    });
    const fetchMock = vi.fn(async () => (stepped
      ? new Response('-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----', { status: 200 })
      : new Response(JSON.stringify({ error: { code: 'STEP_UP_REQUIRED', message: 'Confirm it is you', details: { methods: ['password', 'passkey'] } } }), { status: 403 })));
    vi.stubGlobal('fetch', fetchMock);
    const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    const revokeUrl = vi.fn();
    URL.createObjectURL = vi.fn(() => 'blob:stub');
    URL.revokeObjectURL = revokeUrl;

    renderCard();
    await waitFor(() => expect((screen.getByTestId('admin-download-cert-button') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('admin-download-cert-button'));
    expect(await screen.findByTestId('step-up-dialog')).toBeTruthy();
    expect(screen.getByTestId('step-up-passkey')).toBeTruthy();

    fireEvent.change(screen.getByTestId('step-up-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('step-up-password-submit'));
    await waitFor(() => expect(revokeUrl).toHaveBeenCalledWith('blob:stub'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('admin-download-error')).toBeNull();
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
    vi.unstubAllGlobals();
  });

  it('shows the refusal while impersonating instead of asking for a step-up', async () => {
    route();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'IMPERSONATION_FORBIDDEN', message: 'Key material is released only to the signed-in account owner, not while impersonating.' } }), { status: 403 })));
    renderCard();
    await waitFor(() => expect((screen.getByTestId('admin-download-cert-button') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('admin-download-cert-button'));
    expect((await screen.findByTestId('admin-download-error')).textContent).toMatch(/not while impersonating/);
    expect(screen.queryByTestId('step-up-dialog')).toBeNull();
    vi.unstubAllGlobals();
  });
});
