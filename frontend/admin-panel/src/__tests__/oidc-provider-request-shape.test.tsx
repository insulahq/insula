/**
 * The admin panel could not add an OIDC provider at all.
 *
 * `use-oidc-settings.ts` declared its own `CreateProviderInput` with
 * `tenant_id` / `tenant_secret`, while the API requires `client_id` /
 * `client_secret`. Both sides were internally consistent, so `tsc` was
 * satisfied, the panel compiled and shipped, and:
 *
 *   POST  → 400 "display_name, issuer_url, client_id, client_secret, and
 *                panel_scope are required"
 *   PATCH → 200, with the client id and secret NOT written — the update skips
 *                fields that arrive as `undefined`.
 *
 * The reason no existing test caught it is that they all asserted the *form*
 * (fields render, a mutation fires) rather than the *request body*. A test
 * that never inspects what goes on the wire cannot see a field-name mismatch.
 *
 * So: submit the real form, capture the real body, and validate it against the
 * same schema the backend parses with. Nothing here restates the field names —
 * the contract is the oracle, so it stays true when the contract changes.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOidcProviderSchema, updateOidcProviderSchema } from '@insula/api-contracts';
import OidcPage from '../pages/security/OidcPage';
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

/** Bodies POSTed/PATCHed to the providers endpoint, parsed back from JSON. */
const sentBodies: Array<{ method: string; body: unknown }> = [];

const PROVIDER = {
  id: 'p1',
  displayName: 'Corporate SSO',
  issuerUrl: 'https://idp.example.test',
  tenantId: 'existing-client-id',
  panelScope: 'admin',
  enabled: true,
  backchannelLogoutEnabled: false,
  autoProvision: false,
  defaultRole: 'read_only',
  additionalClaims: [],
  displayOrder: 0,
};

beforeEach(() => {
  sentBodies.length = 0;
  mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/oidc/providers') && method !== 'GET') {
      sentBodies.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
      return Promise.resolve({ data: PROVIDER });
    }
    if (url.includes('/oidc/providers')) return Promise.resolve({ data: [PROVIDER] });
    if (url.includes('/oidc/settings')) {
      return Promise.resolve({
        data: {
          disableLocalAuthAdmin: false, disableLocalAuthTenant: false,
          hasBreakGlassSecret: false, protectAdminViaProxy: false,
          protectTenantViaProxy: false, breakGlassPath: null,
        },
      });
    }
    return Promise.resolve({ data: {} });
  });
});

function wrapper({ children }: { readonly children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
}

async function fillAndSubmitAddForm(scope: 'admin' | 'tenant') {
  const user = userEvent.setup();
  render(<OidcPage />, { wrapper });
  await user.click(await screen.findByTestId('add-provider-button'));
  await user.type(screen.getByTestId('provider-name-input'), 'Corporate SSO');
  await user.type(screen.getByTestId('provider-issuer-input'), 'https://idp.example.test');
  await user.type(screen.getByTestId('provider-client-id-input'), 'my-client-id');
  await user.type(screen.getByTestId('provider-secret-input'), 'my-client-secret');
  await user.selectOptions(screen.getByTestId('provider-scope-select'), scope);
  await user.click(screen.getByTestId('submit-provider'));
  await waitFor(() => expect(sentBodies.length).toBeGreaterThan(0));
}

describe('OIDC provider create — request body matches the API contract', () => {
  for (const scope of ['admin', 'tenant'] as const) {
    it(`sends a body the backend accepts (${scope} scope)`, async () => {
      await fillAndSubmitAddForm(scope);
      const post = sentBodies.find((b) => b.method === 'POST');
      expect(post, 'no POST was issued').toBeTruthy();

      // The backend parses with exactly this schema. `.strict()` means a
      // stray `tenant_id` fails here the same way it 400s in production.
      const result = createOidcProviderSchema.safeParse(post!.body);
      expect(
        result.success ? '' : JSON.stringify(result.error.issues),
        'request body rejected by the contract the backend validates with',
      ).toBe('');
    });
  }

  it('carries the operator-entered client credentials, not empty strings', async () => {
    await fillAndSubmitAddForm('tenant');
    const post = sentBodies.find((b) => b.method === 'POST')!;
    const parsed = createOidcProviderSchema.parse(post.body);
    expect(parsed.client_id).toBe('my-client-id');
    expect(parsed.client_secret).toBe('my-client-secret');
    expect(parsed.panel_scope).toBe('tenant');
  });
});

describe('OIDC provider edit — request body matches the API contract', () => {
  it('sends a PATCH the backend accepts', async () => {
    const user = userEvent.setup();
    render(<OidcPage />, { wrapper });
    await user.click(await screen.findByTestId('edit-provider-p1'));
    const idInput = await screen.findByDisplayValue('existing-client-id');
    await user.clear(idInput);
    await user.type(idInput, 'rotated-client-id');
    await user.click(screen.getByTestId('save-provider-p1'));
    await waitFor(() => expect(sentBodies.some((b) => b.method === 'PATCH')).toBe(true));

    const patch = sentBodies.find((b) => b.method === 'PATCH')!;
    const result = updateOidcProviderSchema.safeParse(patch.body);
    expect(
      result.success ? '' : JSON.stringify(result.error.issues),
      'PATCH body rejected by the contract — an unknown key here is a field that silently does not change',
    ).toBe('');
    expect(updateOidcProviderSchema.parse(patch.body).client_id).toBe('rotated-client-id');
  });
});
