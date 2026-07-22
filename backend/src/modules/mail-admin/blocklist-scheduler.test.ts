import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  createK8sClients: vi.fn(() => ({ core: { listNode: vi.fn() } })),
  resolveServerNodeIps: vi.fn(),
  resolveDefaultMailHost: vi.fn(),
  probeDeliverability: vi.fn(),
  notifyAdminMailBlocklisted: vi.fn(),
}));

vi.mock('../k8s-provisioner/k8s-client.js', () => ({ createK8sClients: h.createK8sClients }));
vi.mock('./server-node-ips.js', () => ({ resolveServerNodeIps: h.resolveServerNodeIps }));
vi.mock('./mail-acme-override-route.js', () => ({ resolveDefaultMailHost: h.resolveDefaultMailHost }));
vi.mock('./deliverability.js', () => ({ probeDeliverability: h.probeDeliverability }));
vi.mock('../notifications/events.js', () => ({ notifyAdminMailBlocklisted: h.notifyAdminMailBlocklisted }));

import { runBlocklistCheckOnce } from './blocklist-scheduler.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = {} as any;
const log = { info: vi.fn(), warn: vi.fn() };

interface BL { ip: string; list: string; zone: string; listed: boolean; severity: string; lookupUrl: string | null }
function component(blocklists: BL[]) {
  return { blocklists };
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.createK8sClients.mockReturnValue({ core: { listNode: vi.fn() } });
  log.info.mockReset();
  log.warn.mockReset();
});

describe('runBlocklistCheckOnce', () => {
  it('alerts on fail/warning listings, ignores advisory and unlisted', async () => {
    h.resolveDefaultMailHost.mockResolvedValue('mail.example.test');
    h.resolveServerNodeIps.mockResolvedValue(['203.0.113.10']);
    h.probeDeliverability.mockResolvedValue(component([
      { ip: '203.0.113.10', list: 'Spamhaus ZEN', zone: 'zen.spamhaus.org', listed: true, severity: 'fail', lookupUrl: 'https://check.spamhaus.org' },
      { ip: '203.0.113.10', list: 'SORBS', zone: 'dnsbl.sorbs.net', listed: true, severity: 'warning', lookupUrl: null },
      { ip: '203.0.113.10', list: 'UCEPROTECT L1', zone: 'dnsbl-1.uceprotect.net', listed: true, severity: 'advisory', lookupUrl: null },
      { ip: '203.0.113.10', list: 'Barracuda', zone: 'b.barracudacentral.org', listed: false, severity: 'ok', lookupUrl: null },
    ]));

    const fired = await runBlocklistCheckOnce(db, log, undefined);

    expect(fired).toBe(2);
    expect(h.notifyAdminMailBlocklisted).toHaveBeenCalledTimes(2);
    const [, payload, dedupeKey] = h.notifyAdminMailBlocklisted.mock.calls[0];
    expect(payload).toMatchObject({ ip: '203.0.113.10', list: 'Spamhaus ZEN', severity: 'fail' });
    expect(dedupeKey).toMatch(/^blocklist:203\.0\.113\.10:zen\.spamhaus\.org:\d{4}-\d{2}-\d{2}$/);
  });

  it('skips (no probe) when the mail hostname is unresolved', async () => {
    h.resolveDefaultMailHost.mockResolvedValue(null);
    h.resolveServerNodeIps.mockResolvedValue(['203.0.113.10']);
    const fired = await runBlocklistCheckOnce(db, log, undefined);
    expect(fired).toBe(0);
    expect(h.probeDeliverability).not.toHaveBeenCalled();
    expect(h.notifyAdminMailBlocklisted).not.toHaveBeenCalled();
  });

  it('skips (no probe) when there are no server-role IPs', async () => {
    h.resolveDefaultMailHost.mockResolvedValue('mail.example.test');
    h.resolveServerNodeIps.mockResolvedValue([]);
    const fired = await runBlocklistCheckOnce(db, log, undefined);
    expect(fired).toBe(0);
    expect(h.probeDeliverability).not.toHaveBeenCalled();
  });

  it('does not fire when nothing is listed', async () => {
    h.resolveDefaultMailHost.mockResolvedValue('mail.example.test');
    h.resolveServerNodeIps.mockResolvedValue(['203.0.113.10']);
    h.probeDeliverability.mockResolvedValue(component([
      { ip: '203.0.113.10', list: 'Spamhaus ZEN', zone: 'zen.spamhaus.org', listed: false, severity: 'ok', lookupUrl: null },
    ]));
    const fired = await runBlocklistCheckOnce(db, log, undefined);
    expect(fired).toBe(0);
    expect(h.notifyAdminMailBlocklisted).not.toHaveBeenCalled();
  });
});
