/**
 * The tenant's DKIM signing-keys card.
 *
 * It asked for an endpoint that no longer existed, swallowed the failure and
 * told every tenant "No DKIM keys yet" — while their mail was being signed —
 * and its Rotate button sent the domain id to a route that takes the
 * email-domain id, so every rotation answered "not found". These tests drive
 * the real hooks against a mocked fetch, so a wrong URL or a hidden error
 * fails here instead of in production.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmailDomain } from '@/hooks/use-email';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', async (orig) => ({ ...(await orig<typeof import('@/lib/api-client')>()), apiFetch }));

const { default: DkimKeysCard, KEY_SHOWN_MS } = await import('./DkimKeysCard');
const { ApiError } = await import('@/lib/api-client');
const { useAuth } = await import('@/hooks/use-auth');

function signInAs(role: string) {
  useAuth.setState({
    user: { id: 'u1', email: 'owner@example.test', fullName: 'Owner', role, tenantId: TENANT } as never,
    isAuthenticated: true,
  });
}

const TENANT = 't-1';
const DOMAIN: EmailDomain = {
  id: 'email-domain-9',
  domainId: 'domain-4',
  domainName: 'example.test',
  enabled: 1,
  maxMailboxes: 0,
  maxQuotaMb: 0,
};

const KEY = {
  selector: 'dkim-1', algorithm: 'rsa', stage: 'active', current: true,
  txtRecordName: 'dkim-1._domainkey.example.test', txtRecordValue: 'v=DKIM1; k=rsa; p=AAA',
};

const ROTATION = {
  newSelector: 'dkim-2', previousSelector: 'dkim-1', newPublicKey: 'BBB',
  txtRecordName: 'dkim-2._domainkey.example.test', txtRecordValue: 'v=DKIM1; k=rsa; p=BBB',
  stalwartDkimSignatureId: 's2', destroyedSelectors: [], keptCopy: true,
};

function renderCard(opts: { keys?: unknown; keysFail?: Error; manualDns?: boolean; dnsFail?: boolean; keptCopy?: boolean } = {}) {
  apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.endsWith('/dkim/rotate') && init?.method === 'POST') {
      return Promise.resolve({ data: { ...ROTATION, keptCopy: opts.keptCopy ?? true } });
    }
    if (url.endsWith('/dkim/keys')) {
      return opts.keysFail
        ? Promise.reject(opts.keysFail)
        : Promise.resolve({ data: opts.keys ?? { provisioned: true, keys: [KEY] } });
    }
    if (url.endsWith('/dns-records')) {
      if (opts.dnsFail) return Promise.reject(new Error('dns list down'));
      return Promise.resolve({ data: { dnsMode: opts.manualDns ? 'cname' : 'primary', manualRequired: !!opts.manualDns, mailServerHostname: 'mail.example.test', records: [] } });
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DkimKeysCard tenantId={TENANT} domain={DOMAIN} />
    </QueryClientProvider>,
  );
}

describe('DkimKeysCard', () => {
  beforeEach(() => { apiFetch.mockReset(); signInAs('tenant_admin'); });

  it('reads the keys by the EMAIL-DOMAIN id and lists them', async () => {
    renderCard();
    expect(await screen.findByTestId('dkim-key-dkim-1')).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith(`/api/v1/tenants/${TENANT}/email-domains/${DOMAIN.id}/dkim/keys`);
    expect(screen.getByText('Signing')).toBeTruthy();
    expect(screen.getByText('Newest')).toBeTruthy();
    expect(screen.queryByTestId('dkim-no-keys')).toBeNull();
  });

  it('shows a failed read as a failure, never as "no keys"', async () => {
    renderCard({ keysFail: new Error('The mail server did not answer, so the signing keys cannot be shown right now.') });
    expect((await screen.findByTestId('dkim-keys-error')).textContent).toMatch(/did not answer/);
    expect(screen.queryByTestId('dkim-no-keys')).toBeNull();
  });

  it('says plainly when the mail server holds no key, and when the domain is not set up yet', async () => {
    const { unmount } = renderCard({ keys: { provisioned: true, keys: [] } });
    expect((await screen.findByTestId('dkim-no-keys')).textContent).toMatch(/not DKIM-signed/);
    unmount();
    renderCard({ keys: { provisioned: false, keys: [] } });
    expect(await screen.findByTestId('dkim-not-provisioned')).toBeTruthy();
  });

  it('flags a key whose selector has no TXT record on file', async () => {
    renderCard({ keys: { provisioned: true, keys: [{ ...KEY, txtRecordValue: null }] } });
    expect(await screen.findByTestId('dkim-no-record-dkim-1')).toBeTruthy();
  });

  it('rotates only after confirmation, by the EMAIL-DOMAIN id', async () => {
    renderCard();
    await screen.findByTestId('dkim-key-dkim-1');
    fireEvent.click(screen.getByTestId('dkim-rotate-button'));
    expect(screen.getByTestId('dkim-rotate-confirm')).toBeTruthy();
    expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    fireEvent.click(screen.getByTestId('dkim-rotate-confirm-button'));
    await screen.findByTestId('dkim-rotate-result');
    expect(apiFetch).toHaveBeenCalledWith(
      `/api/v1/tenants/${TENANT}/email-domains/${DOMAIN.id}/dkim/rotate`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByTestId('dkim-rotate-result').textContent).toMatch(/published automatically/);
  });

  it('cancel leaves the key alone', async () => {
    renderCard();
    await screen.findByTestId('dkim-key-dkim-1');
    fireEvent.click(screen.getByTestId('dkim-rotate-button'));
    fireEvent.click(screen.getByTestId('dkim-rotate-cancel'));
    expect(screen.queryByTestId('dkim-rotate-confirm')).toBeNull();
    expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('on external DNS, tells the tenant to publish the record instead of claiming it was published', async () => {
    renderCard({ manualDns: true });
    await screen.findByTestId('dkim-key-dkim-1');
    fireEvent.click(screen.getByTestId('dkim-rotate-button'));
    await waitFor(() => expect(screen.getByTestId('dkim-rotate-confirm').textContent).toMatch(/hosted elsewhere/));
    fireEvent.click(screen.getByTestId('dkim-rotate-confirm-button'));
    const result = await screen.findByTestId('dkim-rotate-result');
    expect(result.textContent).toMatch(/Publish the TXT record below at your DNS provider/);
    expect(result.textContent).not.toMatch(/published automatically/);
  });

  it('says so when the platform could not keep a copy of the new key', async () => {
    renderCard({ keptCopy: false });
    fireEvent.click(await screen.findByTestId('dkim-rotate-button'));
    fireEvent.click(screen.getByTestId('dkim-rotate-confirm-button'));
    expect((await screen.findByTestId('dkim-rotate-not-kept')).textContent).toMatch(/could not keep its copy/);
  });

  it('says nothing about the copy when it was kept', async () => {
    renderCard();
    fireEvent.click(await screen.findByTestId('dkim-rotate-button'));
    fireEvent.click(screen.getByTestId('dkim-rotate-confirm-button'));
    await screen.findByTestId('dkim-rotate-result');
    expect(screen.queryByTestId('dkim-rotate-not-kept')).toBeNull();
  });

  it('claims nothing about who published the record when the DNS mode is unknown', async () => {
    renderCard({ dnsFail: true });
    await screen.findByTestId('dkim-key-dkim-1');
    fireEvent.click(screen.getByTestId('dkim-rotate-button'));
    fireEvent.click(screen.getByTestId('dkim-rotate-confirm-button'));
    const result = await screen.findByTestId('dkim-rotate-result');
    expect(result.textContent).toMatch(/Make sure the TXT record below is published/);
    expect(result.textContent).not.toMatch(/published automatically/);
  });
});

describe('DkimKeysCard — Show private key', () => {
  const PRIVATE = {
    domain: 'example.test', selector: 'dkim-1', algorithm: 'rsa',
    txtRecordName: 'dkim-1._domainkey.example.test', published: true,
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMIIEvTEST\n-----END PRIVATE KEY-----\n',
  };
  const keyUrl = `/api/v1/tenants/${TENANT}/email-domains/${DOMAIN.id}/dkim/private-key`;

  /** The key route refuses until a step-up has gone through, like the server. */
  function renderGated(opts: { methods?: string[]; keyError?: unknown } = {}) {
    let stepped = false;
    apiFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith('/dkim/keys')) return Promise.resolve({ data: { provisioned: true, keys: [KEY, { ...KEY, selector: 'dkim-2', current: false }] } });
      if (url.endsWith('/dns-records')) return Promise.resolve({ data: { dnsMode: 'primary', manualRequired: false, mailServerHostname: 'mail.example.test', records: [] } });
      if (url === '/api/v1/me/step-up/password' && init?.method === 'POST') {
        if (JSON.parse(init.body ?? '{}').password !== 'right') {
          return Promise.reject(new ApiError(401, 'STEP_UP_FAILED', 'Step-up authentication failed'));
        }
        stepped = true;
        return Promise.resolve({ data: { ok: true } });
      }
      if (url.endsWith('/dkim/rotate') && init?.method === 'POST') return Promise.resolve({ data: ROTATION });
      if (url === keyUrl) {
        if (opts.keyError) return Promise.reject(opts.keyError);
        return stepped
          ? Promise.resolve({ data: PRIVATE })
          : Promise.reject(new ApiError(403, 'STEP_UP_REQUIRED', 'Confirm it is you', { methods: opts.methods ?? ['password'] }));
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <DkimKeysCard tenantId={TENANT} domain={DOMAIN} />
      </QueryClientProvider>,
    );
  }

  beforeEach(() => { apiFetch.mockReset(); signInAs('tenant_admin'); });

  it('offers it on the signing key only', async () => {
    renderGated();
    await screen.findByTestId('dkim-key-dkim-2');
    expect(screen.getAllByTestId('dkim-show-private-key')).toHaveLength(1);
    expect(screen.getByTestId('dkim-key-dkim-1').querySelector('[data-testid="dkim-show-private-key"]')).toBeTruthy();
  });

  it('is not offered to read-only support or a tenant user', async () => {
    signInAs('support');
    const { unmount } = renderGated();
    await screen.findByTestId('dkim-key-dkim-1');
    expect(screen.queryByTestId('dkim-show-private-key')).toBeNull();
    unmount();
    signInAs('tenant_user');
    renderGated();
    await screen.findByTestId('dkim-key-dkim-1');
    expect(screen.queryByTestId('dkim-show-private-key')).toBeNull();
  });

  it('asks the person to confirm it is them, then shows the key with how to use it', async () => {
    renderGated();
    fireEvent.click(await screen.findByTestId('dkim-show-private-key'));
    expect(await screen.findByTestId('step-up-dialog')).toBeTruthy();
    expect(screen.queryByTestId('dkim-private-key')).toBeNull();

    fireEvent.change(screen.getByTestId('step-up-password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('step-up-password-submit'));
    expect((await screen.findByTestId('step-up-error')).textContent).toMatch(/did not match/);

    fireEvent.change(screen.getByTestId('step-up-password'), { target: { value: 'right' } });
    fireEvent.click(screen.getByTestId('step-up-password-submit'));
    const panel = await screen.findByTestId('dkim-private-key');
    expect(screen.queryByTestId('step-up-dialog')).toBeNull();
    expect((screen.getByTestId('dkim-private-key-pem') as HTMLTextAreaElement).value).toBe(PRIVATE.privateKeyPem);
    expect(panel.textContent).toContain('example.test');
    expect(panel.textContent).toContain('dkim-1');
    expect(screen.getByTestId('dkim-private-key-published').textContent).toMatch(/already published at dkim-1\._domainkey\.example\.test/);
    // The key route was asked twice: refused, then after the step-up.
    expect(apiFetch.mock.calls.filter(([u]) => u === keyUrl)).toHaveLength(2);

    fireEvent.click(screen.getByTestId('dkim-private-key-hide'));
    expect(screen.queryByTestId('dkim-private-key')).toBeNull();
  });

  it('shows nothing when the step-up is cancelled', async () => {
    renderGated();
    fireEvent.click(await screen.findByTestId('dkim-show-private-key'));
    fireEvent.click(await screen.findByLabelText('Close'));
    await waitFor(() => expect(screen.queryByTestId('step-up-dialog')).toBeNull());
    expect(screen.queryByTestId('dkim-private-key')).toBeNull();
    expect(screen.queryByTestId('dkim-private-key-error')).toBeNull();
    expect(screen.getByTestId('dkim-show-private-key')).toBeTruthy();
  });

  it('offers the passkey when that is what the account has', async () => {
    renderGated({ methods: ['passkey'] });
    fireEvent.click(await screen.findByTestId('dkim-show-private-key'));
    expect(await screen.findByTestId('step-up-passkey')).toBeTruthy();
    expect(screen.queryByTestId('step-up-password')).toBeNull();
  });

  it('shows the server\'s reason when the key cannot be shown', async () => {
    renderGated({ keyError: new ApiError(409, 'DKIM_KEY_UNAVAILABLE', 'This key was created before the platform kept a copy of the keys it makes, so it cannot be shown. Rotate key creates a new key that can be.') });
    fireEvent.click(await screen.findByTestId('dkim-show-private-key'));
    expect((await screen.findByTestId('dkim-private-key-error')).textContent).toMatch(/Rotate key/);
    expect(screen.queryByTestId('step-up-dialog')).toBeNull();
  });

  it('says so when the account has nothing to step up with', async () => {
    renderGated({ keyError: new ApiError(409, 'STEP_UP_UNAVAILABLE', 'Confirming it is you needs a password or a passkey on your account, and yours has neither.') });
    fireEvent.click(await screen.findByTestId('dkim-show-private-key'));
    expect((await screen.findByTestId('dkim-private-key-error')).textContent).toMatch(/password or a passkey/);
  });

  /** Show the key through the step-up, as a tenant admin does. */
  async function showKey() {
    fireEvent.click(await screen.findByTestId('dkim-show-private-key'));
    fireEvent.change(await screen.findByTestId('step-up-password'), { target: { value: 'right' } });
    fireEvent.click(screen.getByTestId('step-up-password-submit'));
    return screen.findByTestId('dkim-private-key');
  }

  it('says how to copy by hand when the browser blocks the clipboard', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderGated();
    await showKey();
    fireEvent.click(screen.getByTestId('dkim-private-key-copy'));
    expect((await screen.findByTestId('dkim-private-key-copy-failed')).textContent).toMatch(/blocked copying/);
    expect(writeText).toHaveBeenCalledWith(PRIVATE.privateKeyPem);
  });

  it('confirms a copy that worked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderGated();
    await showKey();
    fireEvent.click(screen.getByTestId('dkim-private-key-copy'));
    await waitFor(() => expect(screen.getByTestId('dkim-private-key-copy').textContent).toMatch(/Copied/));
    expect(screen.queryByTestId('dkim-private-key-copy-failed')).toBeNull();
  });

  it('hides the key by itself after a few minutes', async () => {
    // Installed before the key is shown, so its hide timer runs on them; the
    // clock still advances by itself for the step-up round trip.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderGated();
      await showKey();
      // Halfway, with room for the real time a loaded test run spends: still there.
      await act(async () => { vi.advanceTimersByTime(KEY_SHOWN_MS / 2); });
      expect(screen.queryByTestId('dkim-private-key')).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(KEY_SHOWN_MS / 2); });
      expect(screen.queryByTestId('dkim-private-key')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The rotation replaces the key that was shown; it must not stay on screen
  // until the key list happens to refetch.
  it('drops a shown key as soon as a rotation succeeds', async () => {
    renderGated();
    await showKey();
    fireEvent.click(screen.getByTestId('dkim-rotate-button'));
    fireEvent.click(screen.getByTestId('dkim-rotate-confirm-button'));
    await screen.findByTestId('dkim-rotate-result');
    expect(screen.queryByTestId('dkim-private-key')).toBeNull();
  });
});
