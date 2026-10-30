import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { IngressAuthConfigResponse, OidcProviderResponse } from '@insula/api-contracts';
import { ApiError } from '../lib/api-client';

const h = vi.hoisted(() => ({
  config: { data: null as IngressAuthConfigResponse | null | undefined, isLoading: false, error: null as unknown },
  providers: { data: [] as OidcProviderResponse[] },
  upsert: vi.fn(),
  upsertError: null as unknown,
  remove: vi.fn(),
  test: vi.fn(),
}));

vi.mock('@/hooks/use-ingress-auth', () => ({
  useIngressAuth: () => h.config,
  useOidcProviders: () => h.providers,
  useUpsertIngressAuth: () => ({ mutateAsync: h.upsert, isPending: false, error: h.upsertError }),
  useDeleteIngressAuth: () => ({ mutateAsync: h.remove, isPending: false, error: null }),
  useTestIngressAuth: () => ({ mutate: h.test, isPending: false, data: undefined, error: null }),
}));

const { default: OidcSection } = await import('../components/OidcSection');

const provider = (over: Partial<OidcProviderResponse> = {}): OidcProviderResponse => ({
  id: 'p-1', name: 'Google', issuerUrl: 'https://accounts.google.com', oauthClientId: 'client-1', secretSet: true,
  usePkce: true, defaultScopes: 'openid profile email', consumerCount: 1,
  callbackUrls: ['https://www.example.test/oauth2/callback'], createdAt: '', updatedAt: '', ...over,
});
const config = (over: Partial<IngressAuthConfigResponse> = {}): IngressAuthConfigResponse => ({
  enabled: true, providerId: 'p-1', providerName: 'Google', issuerUrl: 'https://accounts.google.com', clientId: 'client-1',
  clientSecretSet: true, usePkce: true, scopes: 'openid profile email', postLoginRedirectUrl: null,
  allowedEmails: 'alice@example.test', allowedEmailDomains: null, allowedGroups: null, claimRules: null,
  passAuthorizationHeader: false, passAccessToken: false, passIdToken: false, passUserHeaders: true, setXauthrequest: true,
  cookieDomain: null, cookieRefreshSeconds: 0, cookieExpireSeconds: 86400,
  callbackUrl: 'https://www.example.test/oauth2/callback', lastError: null, lastReconciledAt: null, ...over,
});

function open(hostname = 'example.test', wwwRedirect: string | null = 'add-www') {
  const view = render(<MemoryRouter><OidcSection tenantId="t-1" routeId="r-1" hostname={hostname} wwwRedirect={wwwRedirect} /></MemoryRouter>);
  fireEvent.click(screen.getByText('Sign-in (OIDC)'));
  return view;
}

describe('route sign-in form', () => {
  beforeEach(() => {
    h.config = { data: null, isLoading: false, error: null };
    h.providers = { data: [] };
    h.upsert.mockReset().mockResolvedValue(config());
    h.upsertError = null;
    h.remove.mockReset();
  });

  it('★ shows the redirect URI to register, on the host the route serves', () => {
    open();
    expect(screen.getByTestId('oidc-callback-url')).toHaveTextContent('https://www.example.test/oauth2/callback');
    expect(screen.getByText(/Authorized redirect URIs/)).toBeInTheDocument();
  });

  it('★ with an existing provider, shows its settings read-only — no auth method or response type to "override"', () => {
    h.providers = { data: [provider()] };
    h.config = { data: config(), isLoading: false, error: null };
    open();
    expect(screen.getByTestId('provider-summary')).toHaveTextContent('client-1');
    expect(screen.queryByText(/Auth Method/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Response Type/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('oidc-scopes')).not.toBeInTheDocument();
  });

  it('★ sends inline credentials under the names the API reads', async () => {
    open('app.example.test', 'none');
    fireEvent.change(screen.getByTestId('oidc-issuer'), { target: { value: 'https://accounts.google.com' } });
    fireEvent.change(screen.getByTestId('oidc-client-id'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByTestId('oidc-client-secret'), { target: { value: 'sec' } });
    await act(async () => { fireEvent.click(screen.getByTestId('oidc-save')); });
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ issuerUrl: 'https://accounts.google.com', clientId: 'cid', clientSecret: 'sec', enabled: true }));
    expect(h.upsert.mock.calls[0][0]).not.toHaveProperty('authMethod');
  });

  it('warns that an empty allow list lets anyone the provider signs in through', () => {
    open();
    expect(screen.getByTestId('oidc-open-warning')).toHaveTextContent(/anyone/);
    fireEvent.change(screen.getByTestId('oidc-allowed-emails'), { target: { value: 'alice@example.test' } });
    expect(screen.queryByTestId('oidc-open-warning')).not.toBeInTheDocument();
  });

  it('an "in" rule keeps the commas while typing, and saves a list', async () => {
    h.providers = { data: [provider()] };
    open();
    fireEvent.click(screen.getByTestId('claim-rule-add'));
    fireEvent.change(screen.getByTestId('claim-rule-claim-0'), { target: { value: 'hd' } });
    fireEvent.change(screen.getByTestId('claim-rule-op-0'), { target: { value: 'in' } });
    fireEvent.change(screen.getByTestId('claim-rule-value-0'), { target: { value: 'a.test, ' } });
    expect(screen.getByTestId('claim-rule-value-0')).toHaveValue('a.test, ');
    fireEvent.change(screen.getByTestId('claim-rule-value-0'), { target: { value: 'a.test, b.test' } });
    await act(async () => { fireEvent.click(screen.getByTestId('oidc-save')); });
    expect(h.upsert.mock.calls[0][0].claimRules).toEqual([{ claim: 'hd', operator: 'in', value: ['a.test', 'b.test'] }]);
  });

  it('★ a sign-in that did not start is shown with its reason, not swallowed', () => {
    h.providers = { data: [provider()] };
    h.upsertError = new ApiError(409, 'OIDC_GATE_NOT_READY', 'x', {
      operatorError: { code: 'OIDC_GATE_NOT_READY', title: 'Sign-in is not working yet', detail: 'Your settings are saved. The issuer URL does not match.', remediation: ['Fix it'], retryable: true },
    });
    open();
    expect(screen.getByTestId('oidc-save-error')).toHaveTextContent('The issuer URL does not match');
  });

  it('a saved but failing gate says so in the badge and the form', () => {
    h.providers = { data: [provider()] };
    h.config = { data: config({ lastError: 'The sign-in service did not start: the provider could not be reached from the cluster.' }), isLoading: false, error: null };
    open();
    expect(screen.getByTestId('oidc-status')).toHaveTextContent('Not working');
    expect(screen.getByTestId('oidc-last-error')).toHaveTextContent('could not be reached');
  });

  it('a refused read (a tenant user) shows the refusal, not an empty "Off" form', () => {
    h.config = { data: undefined, isLoading: false, error: new ApiError(403, 'INSUFFICIENT_PERMISSIONS', 'Requires tenant_admin') };
    open();
    expect(screen.getByTestId('oidc-load-error')).toBeInTheDocument();
    expect(screen.queryByTestId('oidc-save')).not.toBeInTheDocument();
  });

  it('a wildcard route cannot be protected, and says why', () => {
    open('*.example.test', 'none');
    expect(screen.getByTestId('oidc-wildcard')).toHaveTextContent(/one redirect URI per host/);
  });

  it('after Remove sign-in the badge follows the server, not the form', async () => {
    h.providers = { data: [provider()] };
    h.config = { data: config(), isLoading: false, error: null };
    const view = open();
    expect(screen.getByTestId('oidc-status')).toHaveTextContent('On');
    h.config = { data: null, isLoading: false, error: null };
    view.rerender(<MemoryRouter><OidcSection tenantId="t-1" routeId="r-1" hostname="example.test" wwwRedirect="add-www" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('oidc-status')).toHaveTextContent('Off'));
  });
});
