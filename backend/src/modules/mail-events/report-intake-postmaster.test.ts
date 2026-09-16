import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createMailbox } = vi.hoisted(() => ({ createMailbox: vi.fn() }));
vi.mock('../mailboxes/service.js', () => ({ createMailbox }));

const { reportSettingsGet, reportSettingsUpdate, actionReloadSettings } = vi.hoisted(() => ({
  reportSettingsGet: vi.fn(),
  reportSettingsUpdate: vi.fn(),
  actionReloadSettings: vi.fn(),
}));
vi.mock('../stalwart-jmap/client.js', () => ({
  reportSettingsGet, reportSettingsUpdate, actionReloadSettings,
}));

import { ensureReportIntake, POSTMASTER_LOCAL_PART, DMARC_LOCAL_PART } from './report-intake-reconciler.js';
import type { Database } from '../../db/index.js';

/**
 * `postmaster@` must be a real account, not just a registered pattern.
 *
 * The reconciler has listed `postmaster@*` in REQUIRED_INTAKE_PATTERNS since it
 * was written, and its own docblock records that this is not sufficient —
 * Stalwart refuses an unregistered report address at RCPT. Nothing created the
 * account. Measured on DEV 2026-09-16:
 *
 *     550 5.5.0 Mailbox not found    <- RCPT TO postmaster@<apex>
 *     385 messages queued to it, retrying every 24h
 *
 * It is the envelope sender on platform mail, so every DSN routed back to it
 * was undeliverable — and each expiry generated another DSN to the same dead
 * address.
 */

/**
 * A db stub for both call shapes the reconciler uses:
 *   `.where()` awaited directly          — the enabled-email-domain query
 *   `.where().limit(1)`                  — the per-mailbox existence lookup
 * So `where()` returns a value that is BOTH thenable and has `.limit`.
 */
function makeDb(
  domains: ReadonlyArray<{ tenantId: string; emailDomainId: string; domainName: string }>,
  existingMailboxRows: readonly unknown[] = [],
): Database {
  const whereResult = {
    limit: () => Promise.resolve(existingMailboxRows),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(domains).then(res, rej),
  };
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => whereResult,
  } as Record<string, unknown>;
  return { select: () => chain } as unknown as Database;
}

const db = (d: ReadonlyArray<{ tenantId: string; emailDomainId: string; domainName: string }>): Database =>
  makeDb(d);

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

beforeEach(() => {
  createMailbox.mockReset().mockResolvedValue({ id: 'mb' });
  reportSettingsGet.mockReset().mockResolvedValue({ inboundReportAddresses: {} });
  reportSettingsUpdate.mockReset().mockResolvedValue({});
  actionReloadSettings.mockReset().mockResolvedValue(undefined);
});

const created = () =>
  createMailbox.mock.calls.map((c) => (c[3] as { local_part: string }).local_part);

describe('report intake provisions postmaster@, not just the pattern', () => {
  const ONE = [{ tenantId: 't1', emailDomainId: 'ed1', domainName: 'example.test' }];

  it('creates a postmaster@ mailbox for an enabled email domain', async () => {
    await ensureReportIntake(db(ONE), logger);
    expect(created()).toContain(POSTMASTER_LOCAL_PART);
  });

  it('still creates dmarc@ — postmaster must not displace it', async () => {
    await ensureReportIntake(db(ONE), logger);
    expect(created()).toContain(DMARC_LOCAL_PART);
    expect(created()).toHaveLength(2);
  });

  it('creates both for EVERY enabled domain, not just the first', async () => {
    await ensureReportIntake(db([
      { tenantId: 't1', emailDomainId: 'ed1', domainName: 'one.example.test' },
      { tenantId: 't2', emailDomainId: 'ed2', domainName: 'two.example.test' },
    ]), logger);
    expect(created()).toHaveLength(4);
    const domainsTouched = createMailbox.mock.calls.map((c) => c[2]);
    expect(new Set(domainsTouched)).toEqual(new Set(['ed1', 'ed2']));
  });

  it('gives postmaster@ more quota than a report mailbox', async () => {
    // DSNs arrive for every undeliverable message, so it fills faster than a
    // residual-copy report box — but it stays bounded so a bounce storm cannot
    // fill the volume.
    await ensureReportIntake(db(ONE), logger);
    const byLocalPart = Object.fromEntries(
      createMailbox.mock.calls.map((c) => {
        const input = c[3] as { local_part: string; quota_mb: number };
        return [input.local_part, input.quota_mb];
      }),
    );
    expect(byLocalPart[POSTMASTER_LOCAL_PART]).toBeGreaterThan(byLocalPart[DMARC_LOCAL_PART]);
    expect(byLocalPart[POSTMASTER_LOCAL_PART]).toBeLessThanOrEqual(1024);
  });

  it('reports only dmarc@ as a rua= target', async () => {
    // `rua=` records must never be pointed at postmaster@ — it receives DSNs,
    // not aggregate reports, and mixing them would put report parsing behind a
    // mailbox that fills with bounces.
    const result = await ensureReportIntake(db(ONE), logger);
    expect(result.dmarcAddresses).toEqual(['dmarc@example.test']);
  });

  it('keeps postmaster@* registered as an intake pattern', async () => {
    await ensureReportIntake(db(ONE), logger);
    const patch = reportSettingsUpdate.mock.calls[0]?.[0] as
      { patch: { inboundReportAddresses: Record<string, boolean> } } | undefined;
    expect(patch?.patch.inboundReportAddresses).toHaveProperty('postmaster@*', true);
  });

  it('does not recreate a mailbox that already has a row', async () => {
    await ensureReportIntake(makeDb(ONE, [{ id: 'existing', stalwartPrincipalId: 'p1' }]), logger);
    expect(createMailbox).not.toHaveBeenCalled();
  });
});
