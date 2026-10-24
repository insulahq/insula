import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { McpConnection, McpConsentRequest, McpPlatformConnections, McpTokenList } from '@insula/api-contracts';

const consent = vi.hoisted(() => ({
  request: { data: undefined as McpConsentRequest | undefined, isLoading: false, error: null as unknown },
  mutate: vi.fn(),
}));
const tokens = vi.hoisted(() => ({
  list: { data: undefined as McpTokenList | undefined, isLoading: false, error: null as unknown },
  create: vi.fn(),
  revokeConnection: vi.fn(),
}));
const platform = vi.hoisted(() => ({
  list: { data: undefined as McpPlatformConnections | undefined, isLoading: false, error: null as unknown },
  update: vi.fn(),
}));

vi.mock('@/hooks/use-api-tokens', () => ({
  useConsentRequest: () => consent.request,
  useConsentDecision: () => ({ mutate: consent.mutate, isPending: false, error: null }),
  useApiTokens: () => tokens.list,
  useCreateApiToken: () => ({ mutate: tokens.create, isPending: false, error: null }),
  useRevokeApiToken: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useRevokeConnection: () => ({ mutate: tokens.revokeConnection, isPending: false, error: null }),
  usePlatformAgents: () => platform.list,
  useUpdateAgentSettings: () => ({ mutate: platform.update, isPending: false, error: null }),
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
const { default: AgentIndicator } = await import('../components/agents/AgentIndicator');
const { default: AiAgentsPage } = await import('../pages/security/AiAgentsPage');
const { formatEndsIn } = await import('../components/agents/AgentConnectionsTable');

const request = (over: Partial<McpConsentRequest> = {}): McpConsentRequest => ({
  id: 'req-1', clientName: 'Claude', audience: 'admin', redirectHost: 'claude.example.test', requestedScopes: ['read', 'write'],
  expiresAt: '2026-10-06T10:00:00Z', clientRegisteredAt: '2026-10-06T09:00:00Z', clientApprovedBefore: false, ...over,
});

const connection = (over: Partial<McpConnection> = {}): McpConnection => ({
  id: 'conn-1', audience: 'admin', clientName: 'Claude Code', scopes: ['read', 'write'],
  createdAt: new Date(Date.now() - 600_000).toISOString(), expiresAt: new Date(Date.now() + 7 * 3_600_000).toISOString(),
  lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
  user: { id: 'u1', email: 'ops@example.test', fullName: 'Ops' }, tenant: null, ...over,
});
const ENDPOINT = 'https://admin.example.test/api/v1/mcp';

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
    tokens.list.data = { tokens: [], connections: [], endpoint: ENDPOINT, canUse: false };
    render(<ApiTokensSection />);
    expect(screen.getByTestId('mcp-endpoint')).toHaveTextContent('https://admin.example.test/api/v1/mcp');
    expect(screen.getByTestId('api-tokens-not-allowed')).toBeInTheDocument();
    expect(screen.queryByTestId('api-token-new')).not.toBeInTheDocument();
  });

  it('lists connected agents with when they end, and disconnects one after a confirm', () => {
    tokens.list.data = { tokens: [], connections: [connection()], endpoint: ENDPOINT, canUse: true };
    tokens.revokeConnection.mockReset();
    render(<ApiTokensSection />);
    const row = screen.getByTestId('agent-connection-row-conn-1');
    expect(row).toHaveTextContent('Claude Code');
    expect(row).toHaveTextContent(/in 6 h 5\d min|in 7 h/);
    fireEvent.click(screen.getByTestId('agent-connection-revoke'));
    expect(tokens.revokeConnection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('agent-connection-revoke-confirm'));
    expect(tokens.revokeConnection).toHaveBeenCalledWith('conn-1');
  });

  it('creates a token with the chosen scopes and expiry, and shows the secret once', () => {
    tokens.list.data = { tokens: [], connections: [], endpoint: ENDPOINT, canUse: true };
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

describe('the header chip for a connected agent', () => {
  const renderChip = () => render(<MemoryRouter><AgentIndicator /></MemoryRouter>);

  it('is absent while no agent is connected', () => {
    tokens.list.data = { tokens: [], connections: [], endpoint: ENDPOINT, canUse: true };
    renderChip();
    expect(screen.queryByTestId('agent-indicator')).not.toBeInTheDocument();
  });

  it('shows how many agents act as you and links to where they can be disconnected', () => {
    tokens.list.data = { tokens: [], connections: [connection(), connection({ id: 'conn-2' })], endpoint: ENDPOINT, canUse: true };
    renderChip();
    const chip = screen.getByTestId('agent-indicator');
    expect(chip).toHaveAttribute('href', '/user-settings#ai-agents');
    expect(chip).toHaveAccessibleName('2 AI agents connected');
  });
});

describe('Security → AI agents', () => {
  beforeEach(() => { platform.update.mockReset(); });

  it('lists every agent with who it acts as and for which tenant', () => {
    platform.list.data = {
      tenantAgentsEnabled: true,
      connections: [connection(), connection({ id: 'conn-t', audience: 'tenant', tenant: { id: 't1', name: 'Acme Ltd' } })],
    };
    render(<AiAgentsPage />);
    expect(screen.getByTestId('agent-connection-row-conn-1')).toHaveTextContent('ops@example.test');
    expect(screen.getByTestId('agent-connection-row-conn-t')).toHaveTextContent('Acme Ltd');
    expect(screen.getByTestId('agent-connection-row-conn-t')).toHaveTextContent('Tenant panel');
  });

  it('switching tenant agents off asks first while tenant agents are connected', () => {
    platform.list.data = { tenantAgentsEnabled: true, connections: [connection({ id: 'conn-t', audience: 'tenant', tenant: { id: 't1', name: 'Acme' } })] };
    render(<AiAgentsPage />);
    fireEvent.click(screen.getByTestId('tenant-agents-toggle'));
    expect(platform.update).not.toHaveBeenCalled();
    expect(screen.getByTestId('tenant-agents-off-confirm')).toHaveTextContent('1 tenant agent is connected');
    fireEvent.click(screen.getByTestId('tenant-agents-off-confirm-button'));
    expect(platform.update).toHaveBeenCalledWith({ tenantAgentsEnabled: false }, expect.anything());
  });

  it('switches back on without a question', () => {
    platform.list.data = { tenantAgentsEnabled: false, connections: [] };
    render(<AiAgentsPage />);
    expect(screen.getByTestId('tenant-agents-toggle')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByTestId('tenant-agents-toggle'));
    expect(platform.update).toHaveBeenCalledWith({ tenantAgentsEnabled: true }, expect.anything());
  });
});

describe('when a connection ends', () => {
  it('reads as hours and minutes from now', () => {
    const now = Date.parse('2026-10-23T10:00:00Z');
    expect(formatEndsIn('2026-10-23T17:20:00Z', now)).toBe('in 7 h 20 min');
    expect(formatEndsIn('2026-10-23T12:00:00Z', now)).toBe('in 2 h');
    expect(formatEndsIn('2026-10-23T10:45:00Z', now)).toBe('in 45 min');
    expect(formatEndsIn('2026-10-23T09:00:00Z', now)).toBe('ending now');
  });
});
