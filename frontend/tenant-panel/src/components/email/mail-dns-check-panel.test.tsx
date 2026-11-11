/**
 * The live-zone check and "Re-create mail records" on the Settings & DNS tab.
 *
 * What it must never do: claim the zone is fine when it was not read, or
 * change DNS without first listing exactly what it will publish and remove.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MailDnsCheck } from '@insula/api-contracts';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => ({ ...(await importOriginal<object>()), apiFetch }));

const { default: MailDnsCheckPanel, mailRecordStatus } = await import('./MailDnsCheckPanel');

const HOST = 'mail.platform.test';
const record = (type: string, name: string, value: string, purpose: string, status: 'ok' | 'missing' | 'replaced' = 'ok') =>
  ({ type, name, value, ttl: 3600, priority: type === 'MX' ? 10 : null, purpose, status });

const clean = (): MailDnsCheck => ({
  checked: true,
  reason: null,
  records: [
    record('MX', 'alpha.test', HOST, 'mx'),
    record('TXT', 'alpha.test', 'v=spf1 mx ~all', 'spf'),
    record('TXT', '_dmarc.alpha.test', 'v=DMARC1; p=quarantine; rua=mailto:dmarc@alpha.test', 'dmarc'),
  ],
  issues: [],
  repair: { add: [], remove: [], storedFixes: 0 },
});

const broken = (): MailDnsCheck => ({
  ...clean(),
  records: [
    record('MX', 'alpha.test', HOST, 'mx', 'missing'),
    record('TXT', 'alpha.test', 'v=spf1 mx ~all', 'spf'),
    record('TXT', '_dmarc.alpha.test', 'v=DMARC1; p=quarantine; rua=mailto:dmarc@alpha.test', 'dmarc'),
  ],
  issues: [
    { kind: 'duplicate_spf', severity: 'error', type: 'TXT', name: 'alpha.test', value: 'v=spf1 include:_spf.old.test ~all', message: 'alpha.test has 2 SPF records.', removable: true },
    { kind: 'dmarc_reports_elsewhere', severity: 'warning', type: 'TXT', name: '_dmarc.alpha.test', value: 'v=DMARC1; p=none; rua=mailto:r@old.test', message: 'Reports go elsewhere.', removable: false },
  ],
  repair: {
    add: [{ type: 'MX', name: 'alpha.test', value: HOST, priority: 10 }],
    remove: [
      { type: 'TXT', name: 'alpha.test', value: 'v=spf1 include:_spf.old.test ~all', optional: false },
      { type: 'MX', name: 'alpha.test', value: '50 backup.old.test.', optional: true },
    ],
    storedFixes: 1,
  },
});

function renderPanel(check: MailDnsCheck, repair?: () => Promise<unknown>) {
  apiFetch.mockImplementation((url?: string, init?: { method?: string }) => {
    if (init?.method === 'POST') {
      return repair ? repair() : Promise.resolve({ data: { added: 1, removed: 1, kept: 0, failures: [], check: clean() } });
    }
    if (typeof url === 'string' && url.endsWith('/dns-check')) return Promise.resolve({ data: check });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MailDnsCheckPanel tenantId="t-1" domainId="d-1" domainName="alpha.test" />
    </QueryClientProvider>,
  );
}

const posts = () => apiFetch.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');

describe('MailDnsCheckPanel', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('asks the tenant-scoped check endpoint', async () => {
    renderPanel(clean());
    await screen.findByTestId('mail-dns-ok');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/tenants/t-1/email/domains/d-1/dns-check');
  });

  it('says the zone was checked and holds every record', async () => {
    renderPanel(clean());
    expect(await screen.findByTestId('mail-dns-ok')).toHaveTextContent('every mail record is published');
    expect(screen.queryByTestId('mail-dns-issues')).not.toBeInTheDocument();
  });

  it("lists the records in the way, with their values, and says which the repair removes", async () => {
    renderPanel(broken());
    const box = await screen.findByTestId('mail-dns-issues');
    expect(box).toHaveTextContent('alpha.test has DNS records that break its mail');
    expect(screen.getByTestId('mail-dns-issue-duplicate_spf')).toHaveTextContent('v=spf1 include:_spf.old.test ~all');
    expect(screen.getByTestId('mail-dns-issue-duplicate_spf')).toHaveTextContent('Re-create mail records removes it.');
    expect(screen.getByTestId('mail-dns-issue-dmarc_reports_elsewhere')).not.toHaveTextContent('removes it');
    expect(screen.getByTestId('mail-dns-missing')).toHaveTextContent('1 of the platform');
  });

  it('lists every change before it touches DNS, and only then posts the repair', async () => {
    renderPanel(broken());
    fireEvent.click(await screen.findByTestId('mail-dns-repair-button'));
    expect(screen.getByTestId('mail-dns-repair-add')).toHaveTextContent(`MX alpha.test 10 ${HOST}`);
    expect(screen.getByTestId('mail-dns-repair-remove')).toHaveTextContent('v=spf1 include:_spf.old.test ~all');
    expect(screen.getByTestId('mail-dns-repair-confirm')).toHaveTextContent('1 entry');
    expect(posts()).toHaveLength(0);

    // Only the other MX may be kept; the duplicate SPF has no choice.
    expect(screen.queryByTestId('mail-dns-repair-remove-toggle-TXT-v=spf1 include:_spf.old.test ~all')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mail-dns-repair-confirm-button'));
    await waitFor(() => expect(posts().map(([url]) => url)).toEqual(['/api/v1/tenants/t-1/email/domains/d-1/dns-records/repair']));
    expect(JSON.parse((posts()[0][1] as { body: string }).body)).toEqual({ keep: [] });
    expect(await screen.findByTestId('mail-dns-repair-result')).toHaveTextContent('Published 1 record, removed 1.');
    // The check returned by the repair replaces the old one.
    expect(await screen.findByTestId('mail-dns-ok')).toBeInTheDocument();
  });

  it('sends the MX the tenant unticked as one to keep', async () => {
    renderPanel(broken());
    fireEvent.click(await screen.findByTestId('mail-dns-repair-button'));
    fireEvent.click(screen.getByTestId('mail-dns-repair-remove-toggle-MX-50 backup.old.test.'));
    fireEvent.click(screen.getByTestId('mail-dns-repair-confirm-button'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse((posts()[0][1] as { body: string }).body)).toEqual({
      keep: [{ type: 'MX', name: 'alpha.test', value: '50 backup.old.test.' }],
    });
  });

  it('a DNS server that cannot list the zone is said so', async () => {
    renderPanel({ ...clean(), checked: false, reason: 'zone_unlisted', records: [] });
    expect(await screen.findByTestId('mail-dns-unlisted')).toBeInTheDocument();
    expect(screen.queryByTestId('mail-dns-ok')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mail-dns-repair-button')).not.toBeInTheDocument();
  });

  it('cancel changes nothing', async () => {
    renderPanel(broken());
    fireEvent.click(await screen.findByTestId('mail-dns-repair-button'));
    fireEvent.click(screen.getByTestId('mail-dns-repair-cancel'));
    expect(screen.queryByTestId('mail-dns-repair-confirm')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('with nothing to change, says so and offers no confirm button', async () => {
    renderPanel(clean());
    fireEvent.click(await screen.findByTestId('mail-dns-repair-button'));
    expect(screen.getByTestId('mail-dns-repair-confirm')).toHaveTextContent('nothing to re-create');
    expect(screen.queryByTestId('mail-dns-repair-confirm-button')).not.toBeInTheDocument();
  });

  it('shows the records the repair could not change', async () => {
    renderPanel(broken(), () => Promise.resolve({
      data: {
        added: 0, removed: 1, kept: 0, check: broken(),
        failures: [{ action: 'add', type: 'MX', name: 'alpha.test', value: HOST, message: 'The DNS server rejected this record: 422' }],
      },
    }));
    fireEvent.click(await screen.findByTestId('mail-dns-repair-button'));
    fireEvent.click(screen.getByTestId('mail-dns-repair-confirm-button'));
    expect(await screen.findByTestId('mail-dns-repair-failure')).toHaveTextContent('Could not add MX alpha.test: The DNS server rejected this record: 422');
  });

  it('a failed repair is an error, not a silent no-op', async () => {
    renderPanel(broken(), () => Promise.reject(new Error('The DNS server for alpha.test could not be read')));
    fireEvent.click(await screen.findByTestId('mail-dns-repair-button'));
    fireEvent.click(screen.getByTestId('mail-dns-repair-confirm-button'));
    expect(await screen.findByTestId('mail-dns-repair-error')).toBeInTheDocument();
  });

  it('a zone it could not read is said so — never shown as all published', async () => {
    renderPanel({ ...clean(), checked: false, reason: 'zone_unreadable', records: [] });
    expect(await screen.findByTestId('mail-dns-unreadable')).toBeInTheDocument();
    expect(screen.queryByTestId('mail-dns-ok')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mail-dns-repair-button')).not.toBeInTheDocument();
  });

  it('renders nothing for a zone hosted elsewhere', async () => {
    const { container } = renderPanel({ ...clean(), checked: false, reason: 'external_dns', records: [] });
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('mail-dns-checking')).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('mailRecordStatus', () => {
  it('matches a table row on type, name and purpose', () => {
    const check = broken();
    expect(mailRecordStatus(check, { type: 'MX', name: 'alpha.test', purpose: 'mx' })).toBe('missing');
    expect(mailRecordStatus(check, { type: 'TXT', name: '_dmarc.alpha.test', purpose: 'dmarc' })).toBe('ok');
    expect(mailRecordStatus(check, { type: 'SRV', name: '_imaps._tcp.alpha.test', purpose: 'srv' })).toBeNull();
  });

  it('claims nothing when the zone was not read', () => {
    expect(mailRecordStatus({ ...clean(), checked: false, reason: 'zone_unreadable' }, { type: 'MX', name: 'alpha.test', purpose: 'mx' })).toBeNull();
    expect(mailRecordStatus(undefined, { type: 'MX', name: 'alpha.test', purpose: 'mx' })).toBeNull();
  });
});
