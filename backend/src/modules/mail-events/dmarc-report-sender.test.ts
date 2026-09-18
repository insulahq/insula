import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dmarcReportSettingsGet, dmarcReportSettingsUpdate } = vi.hoisted(() => ({
  dmarcReportSettingsGet: vi.fn(),
  dmarcReportSettingsUpdate: vi.fn(),
}));
vi.mock('../stalwart-jmap/client.js', () => ({ dmarcReportSettingsGet, dmarcReportSettingsUpdate }));

// The disable patch names an address, and the only address the platform always
// owns is postmaster@ on its own mail hostname — so the reconciler resolves it
// before writing. (It is NOT what materialises the settings group; #621
// assumed that and was wrong. See DMARC_SETTINGS_FIELDS.)
const { getExplicitMailHostname } = vi.hoisted(() => ({ getExplicitMailHostname: vi.fn() }));
vi.mock('../mail-admin/stalwart-domain-reconciler.js', () => ({ getExplicitMailHostname }));

const {
  ensureDmarcReportSender,
  eligibleReportSenders,
  DMARC_REPORT_SENDER_KEY,
  DMARC_REPORT_SENDER_DISABLED,
  DMARC_SETTINGS_FIELDS,
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

/**
 * A fake Stalwart that reproduces the behaviour measured on a fresh,
 * bootstrapped v0.16.20 (throwaway cluster):
 *
 *   COLD  (singleton never written)
 *     - the FIRST /set primes the group and stores NOTHING
 *     - the next COMPLETE /set persists
 *     - an IDENTICAL repeat is deduped, so it is not "the next write" —
 *       this is why production, rewriting the same patch every 5 minutes,
 *       stayed cold for weeks while logging a successful disable
 *   WARM  (singleton exists)
 *     - a single complete /set lands, in both directions
 *
 * The fake before this one returned a fixed object regardless of what was
 * written, so a reconciler that wrote nothing at all still passed its tests.
 * That is how two "fixes" for this shipped broken.
 */
let stalwart: Record<string, unknown> | null = null;
let primed = false;
let lastPatch: string | null = null;
function seedStalwart(row: Record<string, unknown>): void {
  stalwart = row;
}

/** The patch that COMMITS — on a cold group a 1-field primer is sent first. */
function committedPatch(): Record<string, { match: unknown; else: string }> {
  const calls = dmarcReportSettingsUpdate.mock.calls;
  return calls[calls.length - 1][0].patch;
}

beforeEach(() => {
  stalwart = null;
  primed = false;
  lastPatch = null;
  dmarcReportSettingsGet.mockReset().mockImplementation(async () => stalwart);
  dmarcReportSettingsUpdate.mockReset().mockImplementation(async (args: { patch: Record<string, unknown> }) => {
    const serialised = JSON.stringify(args.patch);
    if (serialised === lastPatch) return {};          // deduped: a no-op
    lastPatch = serialised;
    const complete = Object.keys(args.patch).length === DMARC_SETTINGS_FIELDS.length;
    if (stalwart) {
      if (complete) stalwart = { ...stalwart, ...args.patch };
    } else if (!primed) {
      primed = true;                                   // cold: primes, stores nothing
    } else if (complete) {
      stalwart = { id: 'singleton', ...args.patch };
    }
    return {};
  });
  getExplicitMailHostname.mockReset().mockResolvedValue('mail.example.test');
});

describe('outbound DMARC reporting is off unless a sender is named', () => {
  it('DISABLES reporting when nothing is configured — including at bootstrap', async () => {
    // The Stalwart singleton starts EMPTY, and empty means its built-in
    // defaults apply: daily, from a hostname-derived address with no mailbox.
    // So "do nothing" is not a safe default — disabling has to be written.
    const r = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(r.state).toBe('disabled');
    expect(r.sender).toBeNull();
    const patch = committedPatch();
    expect(patch.aggregateSendFrequency).toEqual({ match: {}, else: "'disable'" });
    // INVERTED. This asserted `aggregateFromAddress` was UNDEFINED
    // on the disable path, reasoning that the operator's last choice should not
    // be clobbered. That assumption is what made the defect possible: without
    // an address field Stalwart accepts the patch and stores NOTHING, leaving
    // its own defaults (daily, from `noreply-dmarc@` + the hostname domain)
    // live while the reconciler logs a successful disable.
    //
    // Nothing is lost by writing it: the operator's choice lives in
    // `platform_settings.dmarc_report_sender`, and Stalwart's copy is derived
    // from it. Re-enabling rewrites the address from the setting.
    expect(patch.aggregateFromAddress).toEqual({ match: {}, else: "'postmaster@mail.example.test'" });
  });

  it('disables when the operator explicitly chose Disabled', async () => {
    const r = await ensureDmarcReportSender(mockDb({ setting: DMARC_REPORT_SENDER_DISABLED }), logger);
    expect(r.state).toBe('disabled');
    expect(committedPatch().aggregateSendFrequency).toEqual({ match: {}, else: "'disable'" });
  });

  it('enables DAILY from a configured postmaster address', async () => {
    const db = mockDb({
      setting: 'postmaster@example.test',
      eligible: [{ address: 'postmaster@example.test', domainName: 'example.test', tenantName: 'Example Ltd', isSystem: false }],
    });
    const r = await ensureDmarcReportSender(db, logger);
    expect(r.state).toBe('enabled');
    expect(r.sender).toBe('postmaster@example.test');
    const patch = committedPatch();
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
    expect(committedPatch().aggregateSendFrequency).toEqual({ match: {}, else: "'disable'" });
  });

  it('skips the write when Stalwart already agrees', async () => {
    seedStalwart({
      id: 'singleton',
      aggregateSendFrequency: { match: {}, else: "'disable'" },
      failureSendFrequency: { match: {}, else: "'disable'" },
    });
    const r = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(r.state).toBe('in-sync');
    expect(dmarcReportSettingsUpdate).not.toHaveBeenCalled();
  });

  it('writes EVERY field of the group — never a partial patch', async () => {
    // Production reads the singleton back EMPTY while this reconciler logs a
    // successful disable, so a partial patch demonstrably does not persist
    // there. Which write DOES materialise the group is still unknown (see
    // DMARC_SETTINGS_FIELDS); writing the whole group is the safer shape, and
    // the read-back assertion below is what actually catches the failure.
    const db = mockDb({ setting: null });
    await ensureDmarcReportSender(db, logger);
    const patch = committedPatch();
    expect(new Set(Object.keys(patch))).toEqual(new Set(DMARC_SETTINGS_FIELDS));
  });

  it('writes EVERY field of the group in the ENABLED direction too', async () => {
    const db = mockDb({
      setting: 'postmaster@example.test',
      eligible: [{ address: 'postmaster@example.test', domainName: 'example.test', tenantName: 'T', isSystem: false }],
    });
    await ensureDmarcReportSender(db, logger);
    const patch = committedPatch();
    expect(new Set(Object.keys(patch))).toEqual(new Set(DMARC_SETTINGS_FIELDS));
  });

  it('PRIMES a cold group, then commits — one write is never enough', async () => {
    // Cold: the first /set primes the singleton and stores nothing, so the
    // reconciler sends a deliberately different 1-field primer before the real
    // patch. Without it the group stays empty and Stalwart's defaults stay live.
    const r = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(r.state).toBe('disabled');
    expect(dmarcReportSettingsUpdate).toHaveBeenCalledTimes(2);
    const [primer, commit] = dmarcReportSettingsUpdate.mock.calls.map((c: [{ patch: object }]) => c[0].patch);
    expect(Object.keys(primer)).toEqual(['aggregateSendFrequency']);
    expect(new Set(Object.keys(commit))).toEqual(new Set(DMARC_SETTINGS_FIELDS));
    // The primer must differ in shape or Stalwart dedupes it against the commit.
    expect(JSON.stringify(primer)).not.toBe(JSON.stringify(commit));
  });

  it('does NOT prime a warm group — a single complete write lands', async () => {
    seedStalwart({
      id: 'singleton',
      aggregateSendFrequency: { match: {}, else: "'daily'" },
      failureSendFrequency: { match: {}, else: '[1, 1d]' },
    });
    const r = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(r.state).toBe('disabled');
    expect(dmarcReportSettingsUpdate).toHaveBeenCalledTimes(1);
  });

  it('converges on a cold group instead of looping forever', async () => {
    // Production's failure mode: the same patch every 5 minutes, deduped by
    // Stalwart, so the group never materialised and the reconciler logged a
    // successful disable for weeks. Two ticks must reach a real disable.
    const first = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(first.state).toBe('disabled');
    const second = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(second.state).toBe('in-sync');
    expect(stalwart).not.toBeNull();
    expect((stalwart as Record<string, { else: string }>).aggregateSendFrequency.else).toBe("'disable'");
  });

  it('reports FAILURE when Stalwart accepts the write and stores nothing', async () => {
    // The exact production symptom: `updated: {singleton: null}`, empty
    // `notUpdated`, and the singleton still EMPTY afterwards. For six weeks
    // this logged "DISABLED" every 5 minutes while Stalwart sent 47 aggregate
    // reports a day. An accepted /set is not evidence — read it back.
    const db = mockDb({ setting: null });
    // Stalwart swallows the write: empty before AND after.
    dmarcReportSettingsGet.mockResolvedValue(null);
    const res = await ensureDmarcReportSender(db, logger);
    expect(dmarcReportSettingsUpdate).toHaveBeenCalled();
    expect(res.state).not.toBe('disabled'); // must NOT claim success
    expect(res.state).toBe('skipped');
    expect(res.reason).toMatch(/did not store|not persist/i);
    expect(logger.error).toHaveBeenCalled();
  });

  it('carries an ADDRESS field when disabling — schedule fields alone store nothing', async () => {
    // Measured on staging, one connection, read back after each:
    //
    //   {aggregateSendFrequency, failureSendFrequency}  -> accepted, read NULL
    //   {aggregateSendFrequency, aggregateFromAddress}  -> accepted, and now
    //                                                      ALL THREE appear
    //
    // So what materialises a never-written settings group is an address, not a
    // second field. The previous fix assumed the field COUNT mattered and
    // shipped two schedule fields; it passed on DEV only because an earlier
    // diagnostic probe had already created that group with an address in it.
    await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    const patch = committedPatch();
    expect(patch.aggregateFromAddress).toBeDefined();
    expect(patch.aggregateFromAddress.else).toBe("'postmaster@mail.example.test'");
    expect(patch.aggregateSendFrequency.else).toBe("'disable'");
  });

  it('refuses to write a disable it cannot persist when there is no hostname', async () => {
    // Without an address the patch is accepted and stores nothing, so the
    // reconciler would log a disable that never happened — which is how this
    // defect survived a release. Refusing loudly is the honest failure.
    getExplicitMailHostname.mockResolvedValue(null);
    const r = await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(r.state).toBe('skipped');
    expect(r.reason).toBe('no mail hostname for the disable patch');
    expect(dmarcReportSettingsUpdate).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('disables FAILURE reports too, in both directions', async () => {
    // Failure (`ruf=`) reports are the same subsystem with the same broken
    // default sender, so gating only the aggregate half would leave the other
    // half mailing from an address nobody owns. They stay off even when
    // aggregate reporting is ON: a failure report forwards somebody's
    // individual message headers to whoever asked, which "send DMARC reports"
    // does not imply.
    await ensureDmarcReportSender(mockDb({ setting: null }), logger);
    expect(committedPatch().failureSendFrequency.else).toBe("'disable'");

    dmarcReportSettingsUpdate.mockClear();
    await ensureDmarcReportSender(
      mockDb({
        setting: 'postmaster@example.test',
        eligible: [{ address: 'postmaster@example.test', domainName: 'example.test', tenantName: 'Example Ltd', isSystem: false }],
      }),
      logger,
    );
    const onPatch = committedPatch();
    expect(onPatch.aggregateSendFrequency.else).toBe("'daily'");
    expect(onPatch.failureSendFrequency.else).toBe("'disable'");
  });

  it('rewrites when only the failure half has drifted back on', async () => {
    // Without the failure field in the comparison, a live `failureSendFrequency`
    // would sit next to a correctly-disabled aggregate half and read as in-sync.
    seedStalwart({
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
    seedStalwart({
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
    seedStalwart({
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
    expect(stalwart).toBeNull();
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
