import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dmarcReportSettingsGet, dmarcReportSettingsUpdate } = vi.hoisted(() => ({
  dmarcReportSettingsGet: vi.fn(),
  dmarcReportSettingsUpdate: vi.fn(),
}));
vi.mock('../stalwart-jmap/client.js', () => ({ dmarcReportSettingsGet, dmarcReportSettingsUpdate }));

const {
  ensureDmarcReportSender,
  eligibleReportSenders,
  DMARC_REPORT_SENDER_KEY,
  DMARC_REPORT_SENDER_DISABLED,
} = await import('./dmarc-report-sender.js');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

/**
 * Branches on the projection, never on call order: the reconciler reads the
 * setting and then the eligible list, and an order-keyed fake would silently
 * hand one query the other's rows the moment a query is added.
 */
function mockDb(opts: {
  setting?: string | null;
  eligible?: { address: string; domainName: string; tenantName: string; isSystem: boolean }[];
  onWrite?: (value: string) => void;
}) {
  const select = vi.fn().mockImplementation((proj?: Record<string, unknown>) => {
    const keys = new Set(Object.keys(proj ?? {}));
    const rows = keys.has('value')
      ? (opts.setting === undefined || opts.setting === null ? [] : [{ value: opts.setting }])
      : (opts.eligible ?? []);
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => Promise.resolve(rows),
    };
    return chain;
  });
  const insert = vi.fn().mockReturnValue({
    values: (v: { value: string }) => ({
      onConflictDoUpdate: () => { opts.onWrite?.(v.value); return Promise.resolve(); },
    }),
  });
  return { select, insert } as never;
}

beforeEach(() => {
  dmarcReportSettingsGet.mockReset().mockResolvedValue(null);
  dmarcReportSettingsUpdate.mockReset().mockResolvedValue({});
});

describe('outbound DMARC reporting is off unless a sender is named', () => {
  it('DISABLES reporting when nothing is configured — including at bootstrap', async () => {
    // The Stalwart singleton starts EMPTY, and empty means its built-in
    // defaults apply: daily, from a hostname-derived address with no mailbox.
    // So "do nothing" is not a safe default — disabling has to be written.
    const r = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(r.state).toBe('disabled');
    expect(r.sender).toBeNull();
    const patch = dmarcReportSettingsUpdate.mock.calls[0]?.[0]?.patch;
    expect(patch.aggregateSendFrequency).toEqual({ match: {}, else: "'disable'" });
    expect(patch.aggregateFromAddress).toBeUndefined();
  });

  it('disables when the operator explicitly chose Disabled', async () => {
    const r = await ensureDmarcReportSender(mockDb({ setting: DMARC_REPORT_SENDER_DISABLED }), logger);
    expect(r.state).toBe('disabled');
    expect(dmarcReportSettingsUpdate.mock.calls[0]?.[0]?.patch.aggregateSendFrequency)
      .toEqual({ match: {}, else: "'disable'" });
  });

  it('enables DAILY from a configured postmaster address', async () => {
    const db = mockDb({
      setting: 'postmaster@example.test',
      eligible: [{ address: 'postmaster@example.test', domainName: 'example.test', tenantName: 'Example Ltd', isSystem: false }],
    });
    const r = await ensureDmarcReportSender(db, logger);
    expect(r.state).toBe('enabled');
    expect(r.sender).toBe('postmaster@example.test');
    const patch = dmarcReportSettingsUpdate.mock.calls[0]?.[0]?.patch;
    expect(patch.aggregateSendFrequency).toEqual({ match: {}, else: "'daily'" });
    expect(patch.aggregateFromAddress).toEqual({ match: {}, else: "'postmaster@example.test'" });
    // Org name and DKIM signing follow the sender's own domain, so the report
    // is signed by the domain it claims to come from.
    expect(patch.aggregateOrgName).toEqual({ match: {}, else: "'example.test'" });
    expect(patch.aggregateDkimSignDomain).toEqual({ match: {}, else: "'example.test'" });
  });

  it('falls back to disabled AND resets the stored setting when the mailbox is gone', async () => {
    // Operator requirement: if the chosen postmaster disappears — tenant
    // deleted, suspended, domain email disabled — reporting must not keep
    // sending from a dead address, and the panel must not keep showing it as
    // configured.
    let written: string | null = null;
    const db = mockDb({
      setting: 'postmaster@deleted-tenant.test',
      eligible: [],                      // it is no longer eligible
      onWrite: (v) => { written = v; },
    });
    const r = await ensureDmarcReportSender(db, logger);
    expect(r.state).toBe('disabled');
    expect(r.reason).toMatch(/no longer an active postmaster address/);
    expect(written).toBe(DMARC_REPORT_SENDER_DISABLED);
    expect(dmarcReportSettingsUpdate.mock.calls[0]?.[0]?.patch.aggregateSendFrequency)
      .toEqual({ match: {}, else: "'disable'" });
  });

  it('skips the write when Stalwart already agrees', async () => {
    dmarcReportSettingsGet.mockResolvedValue({
      id: 'singleton',
      aggregateSendFrequency: { match: {}, else: "'disable'" },
      failureSendFrequency: { match: {}, else: "'disable'" },
    });
    const r = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(r.state).toBe('in-sync');
    expect(dmarcReportSettingsUpdate).not.toHaveBeenCalled();
  });

  it('writes MORE than one field when disabling — a one-field patch stores nothing', async () => {
    // Found on DEV, not by a test: a single-field patch against a settings
    // group Stalwart has never written is accepted (`updated: {singleton:
    // null}`, empty `notUpdated`) and persists NOTHING. So the disable-only
    // patch logged success on a fresh install and left the group empty — and
    // an empty group means the built-in defaults are live, which is daily
    // reporting from an address with no mailbox. Exactly the bug this module
    // exists to prevent, reported as fixed.
    await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    const patch = dmarcReportSettingsUpdate.mock.calls[0][0].patch;
    expect(Object.keys(patch).length).toBeGreaterThan(1);
    expect(patch.aggregateSendFrequency.else).toBe("'disable'");
  });

  it('disables FAILURE reports too, in both directions', async () => {
    // Failure (`ruf=`) reports are the same subsystem with the same broken
    // default sender, so gating only the aggregate half would leave the other
    // half mailing from an address nobody owns. They stay off even when
    // aggregate reporting is ON: a failure report forwards somebody's
    // individual message headers to whoever asked, which "send DMARC reports"
    // does not imply.
    await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(dmarcReportSettingsUpdate.mock.calls[0][0].patch.failureSendFrequency.else).toBe("'disable'");

    dmarcReportSettingsUpdate.mockClear();
    await ensureDmarcReportSender(
      mockDb({
        setting: 'postmaster@example.test',
        eligible: [{ address: 'postmaster@example.test', domainName: 'example.test', tenantName: 'Example Ltd', isSystem: false }],
      }),
      logger,
    );
    const onPatch = dmarcReportSettingsUpdate.mock.calls[0][0].patch;
    expect(onPatch.aggregateSendFrequency.else).toBe("'daily'");
    expect(onPatch.failureSendFrequency.else).toBe("'disable'");
  });

  it('rewrites when only the failure half has drifted back on', async () => {
    // Without the failure field in the comparison, a live `failureSendFrequency`
    // would sit next to a correctly-disabled aggregate half and read as in-sync.
    dmarcReportSettingsGet.mockResolvedValue({
      id: 'singleton',
      aggregateSendFrequency: { match: {}, else: "'disable'" },
      failureSendFrequency: { match: {}, else: '[1, 1d]' },
    });
    const r = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(r.state).toBe('disabled');
    expect(dmarcReportSettingsUpdate).toHaveBeenCalled();
  });

  it('stays in-sync when disabled even though Stalwart still holds the old sender', async () => {
    // Disabling deliberately leaves `aggregateFromAddress` in place — `disable`
    // already stops every send, and clearing it would throw away the
    // operator's last choice. So the stale address must not count as
    // disagreement: comparing it would make the 5-minute self-heal tick
    // rewrite the same patch, and log it, forever.
    dmarcReportSettingsGet.mockResolvedValue({
      id: 'singleton',
      aggregateSendFrequency: { match: {}, else: "'disable'" },
      aggregateFromAddress: { match: {}, else: "'postmaster@previously-chosen.test'" },
      failureSendFrequency: { match: {}, else: "'disable'" },
    });
    const r = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(r.state).toBe('in-sync');
    expect(dmarcReportSettingsUpdate).not.toHaveBeenCalled();
  });

  it('still writes when ENABLED and only the sender differs — the control', async () => {
    // The mirror case: with a desired sender, the address IS part of the
    // comparison, or a changed selection would never reach Stalwart.
    dmarcReportSettingsGet.mockResolvedValue({
      id: 'singleton',
      aggregateSendFrequency: { match: {}, else: "'daily'" },
      aggregateFromAddress: { match: {}, else: "'postmaster@stale.test'" },
      failureSendFrequency: { match: {}, else: "'disable'" },
    });
    const r = await ensureDmarcReportSender(
      mockDb({
        setting: 'postmaster@example.test',
        eligible: [{ address: 'postmaster@example.test', domainName: 'example.test', tenantName: 'Example Ltd', isSystem: false }],
      }),
      logger,
    );
    expect(r.state).toBe('enabled');
    expect(dmarcReportSettingsUpdate).toHaveBeenCalled();
  });

  it('treats an EMPTY singleton as disagreement, not agreement', async () => {
    // The trap this whole module exists for: empty means the built-in
    // defaults are live (daily, hostname sender), which is exactly the state
    // we are here to overwrite.
    dmarcReportSettingsGet.mockResolvedValue(null);
    const r = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(r.state).toBe('disabled');
    expect(dmarcReportSettingsUpdate).toHaveBeenCalled();
  });

  it('never throws — it must not break the rest of the mail self-heal tick', async () => {
    dmarcReportSettingsUpdate.mockRejectedValue(new Error('stalwart down'));
    const r = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(r.state).toBe('skipped');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('eligibleReportSenders', () => {
  it('returns the postmaster addresses it is given, sorted', async () => {
    const db = mockDb({
      eligible: [
        { address: 'postmaster@b.test', domainName: 'b.test', tenantName: 'B', isSystem: false },
        { address: 'postmaster@a.test', domainName: 'a.test', tenantName: 'SYSTEM', isSystem: true },
      ],
    });
    const list = await eligibleReportSenders(db);
    expect(list.map((e) => e.address)).toEqual(['postmaster@a.test', 'postmaster@b.test']);
    // SYSTEM is included when its domain has email enabled — operator
    // requirement — and flagged so the dropdown can label it.
    expect(list[0]?.isSystemTenant).toBe(true);
  });
});

describe('the settings key', () => {
  it('is the single switch — there is no separate enable flag', () => {
    expect(DMARC_REPORT_SENDER_KEY).toBe('dmarc_report_sender');
    expect(DMARC_REPORT_SENDER_DISABLED).toBe('disabled');
  });
});
