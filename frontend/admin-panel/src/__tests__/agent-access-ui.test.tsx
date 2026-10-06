import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { McpConsentRequest, McpTokenList } from '@insula/api-contracts';

const consent = vi.hoisted(() => ({
  request: { data: undefined as McpConsentRequest | undefined, isLoading: false, error: null as unknown },
  mutate: vi.fn(),
}));
const tokens = vi.hoisted(() => ({
  list: { data: undefined as McpTokenList | undefined, isLoading: false, error: null as unknown },
  create: vi.fn(),
}));

vi.mock('@/hooks/use-api-tokens', () => ({
  useConsentRequest: () => consent.request,
  useConsentDecision: () => ({ mutate: consent.mutate, isPending: false, error: null }),
  useApiTokens: () => tokens.list,
  useCreateApiToken: () => ({ mutate: tokens.create, isPending: false, error: null }),
  useRevokeApiToken: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

// jsdom has no matchMedia; the consent page applies the theme itself.
const prefersDark = vi.hoisted(() => ({ value: false }));
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    matches: prefersDark.value && query.includes('dark'), media: query,
    addEventListener: () => {}, removeEventListener: () => {},
  }),
});

const { default: OAuthConsent } = await import('../pages/OAuthConsent');
const { default: ApiTokensSection } = await import('../components/settings/ApiTokensSection');

const request = (over: Partial<McpConsentRequest> = {}): McpConsentRequest => ({
  id: 'req-1', clientName: 'Claude', redirectHost: 'claude.example.test', requestedScopes: ['read', 'write'],
  expiresAt: '2026-10-06T10:00:00Z', clientRegisteredAt: '2026-10-06T09:00:00Z', clientApprovedBefore: false, ...over,
});

const renderConsent = () => render(
  <MemoryRouter initialEntries={['/oauth/consent?request=req-1']}><OAuthConsent /></MemoryRouter>,
);

describe('the OAuth consent page', () => {
  beforeEach(() => { consent.mutate.mockReset(); });

  it('leads with where the approval is sent, and warns about a client nobody approved before', () => {
    consent.request.data = request();
    renderConsent();
    expect(screen.getByTestId('oauth-consent-redirect')).toHaveTextContent('claude.example.test');
    expect(screen.getByTestId('oauth-consent-registered')).toBeInTheDocument();
    expect(screen.getByTestId('oauth-consent-first-time')).toBeInTheDocument();
  });

  it('follows the stored or system theme — it opens outside the themed layout', () => {
    consent.request.data = request();
    prefersDark.value = true;
    localStorage.removeItem('theme');
    renderConsent();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    prefersDark.value = false;
    document.documentElement.classList.remove('dark');
  });

  it('drops the warning for a client that was approved before', () => {
    consent.request.data = request({ clientApprovedBefore: true });
    renderConsent();
    expect(screen.queryByTestId('oauth-consent-first-time')).not.toBeInTheDocument();
  });

  it('approves only the scopes left ticked, and denies with none', () => {
    consent.request.data = request();
    renderConsent();
    fireEvent.click(screen.getByTestId('oauth-consent-scope-write'));
    fireEvent.click(screen.getByTestId('oauth-consent-approve'));
    expect(consent.mutate).toHaveBeenLastCalledWith({ approve: true, scopes: ['read'] }, expect.anything());
    fireEvent.click(screen.getByTestId('oauth-consent-deny'));
    expect(consent.mutate).toHaveBeenLastCalledWith({ approve: false, scopes: [] }, expect.anything());
  });
});

describe('API tokens & AI agents', () => {
  beforeEach(() => { tokens.create.mockReset(); });

  it('shows the MCP address but no token controls to a role that may not use them', () => {
    tokens.list.data = { tokens: [], endpoint: 'https://admin.example.test/api/v1/mcp', canUse: false };
    render(<ApiTokensSection />);
    expect(screen.getByTestId('mcp-endpoint')).toHaveTextContent('https://admin.example.test/api/v1/mcp');
    expect(screen.getByTestId('api-tokens-not-allowed')).toBeInTheDocument();
    expect(screen.queryByTestId('api-token-new')).not.toBeInTheDocument();
  });

  it('creates a token with the chosen scopes and expiry, and shows the secret once', () => {
    tokens.list.data = { tokens: [], endpoint: 'https://admin.example.test/api/v1/mcp', canUse: true };
    tokens.create.mockImplementation((_input, opts: { onSuccess: (t: unknown) => void }) => opts.onSuccess({
      token: 'insula_pat_secret', id: 't1', kind: 'pat', name: 'ci', scopes: ['read', 'delete'], prefix: 'insula_pat_sec',
      createdAt: '2026-10-06T09:00:00Z', expiresAt: null, lastUsedAt: null, clientName: null,
    }));
    render(<ApiTokensSection />);
    fireEvent.click(screen.getByTestId('api-token-new'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' ci ' } });
    fireEvent.click(screen.getByTestId('api-token-scope-delete'));
    fireEvent.change(screen.getByLabelText('Expires'), { target: { value: 'never' } });
    fireEvent.click(screen.getByTestId('api-token-create-submit'));
    expect(tokens.create).toHaveBeenCalledWith({ name: 'ci', scopes: ['read', 'delete'], expiresInDays: null }, expect.anything());
    expect(screen.getByTestId('api-token-secret')).toHaveTextContent('insula_pat_secret');
    fireEvent.click(screen.getByText('I have stored it'));
    expect(screen.queryByTestId('api-token-secret')).not.toBeInTheDocument();
  });
});
