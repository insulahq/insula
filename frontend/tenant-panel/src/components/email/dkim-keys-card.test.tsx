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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmailDomain } from '@/hooks/use-email';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch }));

const { default: DkimKeysCard } = await import('./DkimKeysCard');

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
  stalwartDkimSignatureId: 's2', destroyedSelectors: [],
};

function renderCard(opts: { keys?: unknown; keysFail?: Error; manualDns?: boolean; dnsFail?: boolean } = {}) {
  apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.endsWith('/dkim/rotate') && init?.method === 'POST') return Promise.resolve({ data: ROTATION });
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
  beforeEach(() => { apiFetch.mockReset(); });

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
