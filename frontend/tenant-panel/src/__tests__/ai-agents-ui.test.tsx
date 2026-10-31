import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { McpConnection, McpConsentRequest, TenantMcpAgents } from '@insula/api-contracts';

const agents = vi.hoisted(() => ({
  list: { data: undefined as TenantMcpAgents | undefined, isLoading: false, error: null as unknown },
  revoke: vi.fn(),
}));
const consent = vi.hoisted(() => ({
  request: { data: undefined as McpConsentRequest | undefined, isLoading: false, error: null as unknown },
  mutate: vi.fn(),
}));

vi.mock('@/hooks/use-ai-agents', () => ({
  useTenantAgents: () => agents.list,
  useRevokeTenantAgent: () => ({ mutate: agents.revoke, isPending: false, error: null }),
  useConsentRequest: () => consent.request,
  useConsentDecision: () => ({ mutate: consent.mutate, isPending: false, error: null }),
}));

// jsdom has no matchMedia; the consent page applies the theme itself.
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
});

const { default: AiAgentsSection } = await import('../components/settings/AiAgentsSection');
const { default: AgentIndicator } = await import('../components/AgentIndicator');
const { default: OAuthConsent } = await import('../pages/OAuthConsent');

const ENDPOINT = 'https://tenant.example.test/api/v1/mcp';
const agent = (over: Partial<McpConnection> = {}): McpConnection => ({
  id: 'conn-1', audience: 'tenant', clientName: 'Claude Code', scopes: ['read'],
  createdAt: new Date(Date.now() - 600_000).toISOString(), expiresAt: new Date(Date.now() + 7 * 3_600_000).toISOString(),
  lastUsedAt: null, user: { id: 'u1', email: 'owner@example.test', fullName: 'Owner' }, tenant: { id: 't1', name: 'Acme' }, ...over,
});
const listing = (over: Partial<TenantMcpAgents> = {}): TenantMcpAgents => ({
  endpoint: ENDPOINT, enabled: true, canConnect: true, view: 'own', connections: [], ...over,
});

describe('User Settings → AI agents', () => {
  beforeEach(() => { agents.revoke.mockReset(); });

  it('gives the MCP address to put into an AI client', () => {
    agents.list.data = listing();
    render(<AiAgentsSection />);
    expect(screen.getByTestId('ai-agents-endpoint')).toHaveTextContent(ENDPOINT);
    expect(screen.getByTestId('ai-agents-empty')).toBeInTheDocument();
  });

  it('says so, and offers nothing, when the provider switched agents off', () => {
    agents.list.data = listing({ enabled: false, canConnect: false });
    render(<AiAgentsSection />);
    expect(screen.getByTestId('ai-agents-disabled')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agents-endpoint')).not.toBeInTheDocument();
  });

  it('tells an impersonating admin that only the account\'s own users can connect one', () => {
    agents.list.data = listing({ canConnect: false });
    render(<AiAgentsSection />);
    expect(screen.getByTestId('ai-agents-impersonating')).toBeInTheDocument();
  });

  it('shows a tenant admin every agent of the account, with who it acts as, and disconnects after a confirm', () => {
    agents.list.data = listing({ view: 'tenant', connections: [agent(), agent({ id: 'conn-2', user: { id: 'u2', email: 'staff@example.test', fullName: 'Staff' } })] });
    render(<AiAgentsSection />);
    expect(screen.getByText('Agents connected to this account')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-row-conn-2')).toHaveTextContent('staff@example.test');
    // By row, not by position: the list is newest first and both fixtures are
    // created within the same few milliseconds.
    fireEvent.click(within(screen.getByTestId('ai-agent-row-conn-2')).getByTestId('ai-agent-revoke'));
    expect(agents.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ai-agent-revoke-confirm'));
    expect(agents.revoke).toHaveBeenCalledWith('conn-2');
  });

  it('shows a tenant user only their own agents, without an "acts as" column', () => {
    agents.list.data = listing({ view: 'own', connections: [agent()] });
    render(<AiAgentsSection />);
    expect(screen.getByText('Your connected agents')).toBeInTheDocument();
    expect(screen.queryByText('Acts as')).not.toBeInTheDocument();
  });

  it('keeps the newest connection first, and sorts by agent name either way', () => {
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    agents.list.data = listing({ view: 'tenant', connections: [
      agent({ id: 'new', clientName: 'Cursor', createdAt: at(1) }),
      agent({ id: 'mid', clientName: 'VS Code', createdAt: at(30) }),
      agent({ id: 'old', clientName: 'Claude Code', createdAt: at(90) }),
    ] });
    render(<AiAgentsSection />);
    const order = () => Array.from(screen.getByTestId('ai-agents-section').querySelectorAll('tbody > tr'))
      .map((tr) => tr.getAttribute('data-testid')?.replace('ai-agent-row-', ''));
    expect(order()).toEqual(['new', 'mid', 'old']);

    fireEvent.click(screen.getByTestId('sort-clientName'));
    expect(order()).toEqual(['old', 'new', 'mid']);
    fireEvent.click(screen.getByTestId('sort-clientName'));
    expect(order()).toEqual(['mid', 'new', 'old']);
  });
});

describe('the header chip for a connected agent', () => {
  it('is absent while none is connected, and links to the list when one is', () => {
    agents.list.data = listing();
    const { unmount } = render(<MemoryRouter><AgentIndicator /></MemoryRouter>);
    expect(screen.queryByTestId('agent-indicator')).not.toBeInTheDocument();
    unmount();
    agents.list.data = listing({ connections: [agent()] });
    render(<MemoryRouter><AgentIndicator /></MemoryRouter>);
    expect(screen.getByTestId('agent-indicator')).toHaveAttribute('href', '/user-settings#ai-agents');
    expect(screen.getByTestId('agent-indicator')).toHaveAccessibleName('1 AI agent connected');
  });
});

describe('the tenant consent page', () => {
  beforeEach(() => { consent.mutate.mockReset(); });

  it('leads with where access is sent and approves only the ticked scopes', () => {
    consent.request.data = {
      id: 'req-1', clientName: 'Claude', audience: 'tenant', redirectHost: '127.0.0.1:33418', requestedScopes: ['read', 'write'],
      expiresAt: new Date(Date.now() + 600_000).toISOString(), clientRegisteredAt: new Date().toISOString(), clientApprovedBefore: false,
    };
    render(<MemoryRouter initialEntries={['/oauth/consent?request=req-1']}><OAuthConsent /></MemoryRouter>);
    expect(screen.getByTestId('oauth-consent-redirect')).toHaveTextContent('127.0.0.1:33418');
    expect(screen.getByTestId('oauth-consent-first-time')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('oauth-consent-scope-write'));
    fireEvent.click(screen.getByTestId('oauth-consent-approve'));
    expect(consent.mutate).toHaveBeenLastCalledWith({ approve: true, scopes: ['read'] }, expect.anything());
  });
});
