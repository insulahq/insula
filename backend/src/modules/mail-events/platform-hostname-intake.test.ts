/**
 * `postmaster@`/`abuse@` on the platform's own mail hostname.
 *
 * The behaviours worth pinning are the refusals, not the happy path: every one
 * of them is a way to look fixed while being worse than the 550 this replaces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getCachedPrincipalsAccountId, domainQuery, domainGet } = vi.hoisted(() => ({
  getCachedPrincipalsAccountId: vi.fn(),
  domainQuery: vi.fn(),
  domainGet: vi.fn(),
}));
vi.mock('../stalwart-jmap/client.js', () => ({ getCachedPrincipalsAccountId, domainQuery, domainGet }));

const { getExplicitMailHostname } = vi.hoisted(() => ({ getExplicitMailHostname: vi.fn() }));
vi.mock('../mail-admin/stalwart-domain-reconciler.js', () => ({ getExplicitMailHostname }));

const { listMailingLists, createMailingList, updateMailingListRecipients } = vi.hoisted(() => ({
  listMailingLists: vi.fn(),
  createMailingList: vi.fn(),
  updateMailingListRecipients: vi.fn(),
}));
vi.mock('../stalwart-jmap/mailing-lists.js', () => ({
  listMailingLists, createMailingList, updateMailingListRecipients,
}));

const { ensurePlatformHostnameIntake, platformHostnameAddresses } =
  await import('./platform-hostname-intake.js');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

/**
 * Branches on the projection, never on call order: the reconciler asks for
 * admin emails and then twice per address whether something already answers
 * it, and an order-keyed fake would hand one query another's rows the moment
 * an address is added to the list.
 */
function mockDb(opts: { admins?: readonly string[]; answered?: boolean } = {}) {
  const { admins = ['ops@example.test'], answered = false } = opts;
  const select = vi.fn().mockImplementation((proj?: Record<string, unknown>) => {
    const keys = new Set(Object.keys(proj ?? {}));
    const rows = keys.has('email')
      ? admins.map((email) => ({ email }))
      : (answered ? [{ id: 'occupied' }] : []);
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
    };
    return chain;
  });
  return { select } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  getExplicitMailHostname.mockResolvedValue('mail.example.test');
  getCachedPrincipalsAccountId.mockResolvedValue('acct-1');
  domainQuery.mockResolvedValue({ ids: ['d1', 'd2'] });
  domainGet.mockResolvedValue({
    list: [{ id: 'd1', name: 'tenant.example.test' }, { id: 'd2', name: 'mail.example.test' }],
  });
  listMailingLists.mockResolvedValue([]);
  createMailingList.mockResolvedValue('list-1');
  updateMailingListRecipients.mockResolvedValue(undefined);
});

describe('platform hostname intake', () => {
  it('creates both RFC 2142 addresses on the mail hostname', async () => {
    const r = await ensurePlatformHostnameIntake(mockDb(), logger);
    expect(r.state).toBe('created');
    expect(r.addresses).toEqual(['postmaster@mail.example.test', 'abuse@mail.example.test']);
    const locals = createMailingList.mock.calls.map((c) => c[0].localPart);
    expect(locals).toEqual(['postmaster', 'abuse']);
  });

  it('attaches the lists to the HOSTNAME domain, not the first domain it saw', async () => {
    // domainGet returns a tenant domain first. Taking list[0] would forward
    // the platform's postmaster mail into a customer's domain.
    await ensurePlatformHostnameIntake(mockDb(), logger);
    for (const call of createMailingList.mock.calls) {
      expect(call[0].stalwartDomainId).toBe('d2');
    }
  });

  it('forwards to the active admin roster', async () => {
    await ensurePlatformHostnameIntake(mockDb({ admins: ['b@example.test', 'a@example.test'] }), logger);
    expect(createMailingList.mock.calls[0][0].destinations).toEqual(['a@example.test', 'b@example.test']);
  });

  it('REFUSES to create a list when there is no admin to receive it', async () => {
    // A MailingList with no recipients accepts mail and drops it — the sender
    // is told the report was delivered and nobody ever sees it. Strictly worse
    // than the 550 being fixed.
    const r = await ensurePlatformHostnameIntake(mockDb({ admins: [] }), logger);
    expect(r.state).toBe('skipped');
    expect(r.reason).toBe('no admin recipients');
    expect(createMailingList).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('skips quietly when the hostname is not a Stalwart domain yet', async () => {
    // Normal mid-install: bootstrap registers the domain and the next tick
    // builds the lists. Must not be an error, or every fresh cluster logs one.
    domainGet.mockResolvedValue({ list: [{ id: 'd1', name: 'tenant.example.test' }] });
    const r = await ensurePlatformHostnameIntake(mockDb(), logger);
    expect(r.state).toBe('skipped');
    expect(r.reason).toBe('hostname not a stalwart domain');
    expect(createMailingList).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not shadow an address the platform already answers with a mailbox', async () => {
    // If the hostname is somehow hosted as a real email domain with a real
    // postmaster mailbox, a forwarder on the same address would silently
    // redirect their mail.
    const r = await ensurePlatformHostnameIntake(mockDb({ answered: true }), logger);
    expect(createMailingList).not.toHaveBeenCalled();
    expect(r.addresses).toHaveLength(2);
  });

  it('is idempotent once the lists match the roster', async () => {
    listMailingLists.mockResolvedValue([
      { id: 'l1', emailAddress: 'postmaster@mail.example.test', recipients: { 'ops@example.test': true } },
      { id: 'l2', emailAddress: 'abuse@mail.example.test', recipients: { 'ops@example.test': true } },
    ]);
    const r = await ensurePlatformHostnameIntake(mockDb(), logger);
    expect(r.state).toBe('in-sync');
    expect(createMailingList).not.toHaveBeenCalled();
    expect(updateMailingListRecipients).not.toHaveBeenCalled();
  });

  it('re-syncs recipients when the admin roster changed', async () => {
    // An admin who left must stop receiving abuse reports; one who joined must
    // start. The roster is the only place that is recorded.
    listMailingLists.mockResolvedValue([
      { id: 'l1', emailAddress: 'postmaster@mail.example.test', recipients: { 'gone@example.test': true } },
      { id: 'l2', emailAddress: 'abuse@mail.example.test', recipients: { 'gone@example.test': true } },
    ]);
    const r = await ensurePlatformHostnameIntake(mockDb({ admins: ['new@example.test'] }), logger);
    expect(r.state).toBe('updated');
    expect(updateMailingListRecipients).toHaveBeenCalledTimes(2);
    expect(updateMailingListRecipients.mock.calls[0][0].destinations).toEqual(['new@example.test']);
  });

  it('never throws — the mail self-heal tick must survive it', async () => {
    listMailingLists.mockRejectedValue(new Error('stalwart down'));
    const r = await ensurePlatformHostnameIntake(mockDb(), logger);
    expect(r.state).toBe('skipped');
    expect(logger.error).toHaveBeenCalled();
  });

  it('exposes the declared addresses so drift detection can recognise them', async () => {
    // These lists have no email_aliases row by design, so the orphan-list
    // check would otherwise report them as drift every scan — and an operator
    // would eventually delete the thing that stops the 550s.
    expect(platformHostnameAddresses('Mail.Example.Test.')).toEqual([
      'postmaster@mail.example.test',
      'abuse@mail.example.test',
    ]);
    expect(platformHostnameAddresses('  ')).toEqual([]);
  });
});
