import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '../../db/index.js';

/**
 * A fake Stalwart that answers the way v0.16.27 was measured to on DEV: a
 * by-id read of a singleton returns the stored group, or Stalwart's built-in
 * defaults while it is unwritten; an update is applied on top of that and
 * stored. Spam tags are ordinary rows found by tag name.
 */
const SENDER_AUTH_DEFAULTS = {
  dkimSignDomain: { match: { '0': { if: 'is_local_domain(sender_domain) && !is_empty(authenticated_as)', then: 'sender_domain' } }, else: 'false' },
  dkimStrict: true,
  dkimVerify: { match: {}, else: 'relaxed' },
  spfEhloVerify: { match: { '0': { if: 'local_port == 25', then: 'relaxed' } }, else: 'disable' },
  spfFromVerify: { match: { '0': { if: 'local_port == 25', then: 'relaxed' } }, else: 'disable' },
  arcVerify: { match: {}, else: 'disable' },
  dmarcVerify: { match: { '0': { if: 'local_port == 25', then: 'relaxed' } }, else: 'disable' },
  reverseIpVerify: { match: { '0': { if: 'local_port == 25', then: 'relaxed' } }, else: 'disable' },
};
const SPAM_SETTINGS_DEFAULTS = {
  trustContacts: true, enable: true, greylistFor: null, scoreDiscard: 0, scoreReject: 0, scoreSpam: 5,
  trustReplies: true, spamFilterRulesUrl: 'https://rules.example.test/spam-filter-rules.json.gz',
};

let senderAuth: Record<string, unknown> | null;
let spamSettings: Record<string, unknown> | null;
let tags: Array<{ id: string; tag: string; '@type': string; score?: number }>;
const writes: Array<{ group: string; patch: Record<string, unknown> }> = [];
let unreachable = false;
let refuse: string | null = null;
let failReload = false;
const reload = vi.fn(async () => {
  if (failReload) throw new Error('ReloadSettings rejected');
});

function setter(group: 'SenderAuth' | 'SpamSettings') {
  return async ({ patch }: { patch: Record<string, unknown> }) => {
    if (unreachable) throw new Error('ECONNREFUSED');
    writes.push({ group, patch });
    if (refuse === group) return { notUpdated: { singleton: { type: 'invalidProperties' } } };
    if (group === 'SenderAuth') senderAuth = { ...(senderAuth ?? SENDER_AUTH_DEFAULTS), ...patch };
    else spamSettings = { ...(spamSettings ?? SPAM_SETTINGS_DEFAULTS), ...patch };
    return { updated: { singleton: null }, notUpdated: null };
  };
}

vi.mock('../stalwart-jmap/client.js', () => ({
  senderAuthGet: async () => {
    if (unreachable) throw new Error('ECONNREFUSED');
    return { ...(senderAuth ?? SENDER_AUTH_DEFAULTS), id: 'singleton' };
  },
  senderAuthUpdate: (a: { patch: Record<string, unknown> }) => setter('SenderAuth')(a),
  spamSettingsGet: async () => {
    if (unreachable) throw new Error('ECONNREFUSED');
    return { ...(spamSettings ?? SPAM_SETTINGS_DEFAULTS), id: 'singleton' };
  },
  spamSettingsUpdate: (a: { patch: Record<string, unknown> }) => setter('SpamSettings')(a),
  spamTagFind: async ({ tag }: { tag: string }) => {
    const row = tags.find((t) => t.tag === tag);
    return row ? { ...row } : null;
  },
  spamTagSet: async ({ create, update }: {
    create?: Record<string, { tag: string; '@type': string; score: number }>;
    update?: Record<string, { score: number }>;
  }) => {
    writes.push({ group: 'SpamTag', patch: { ...(create ?? {}), ...(update ?? {}) } });
    if (refuse === 'SpamTag') return { notUpdated: { x: { type: 'forbidden' } }, notCreated: { q: { type: 'forbidden' } } };
    const created: Record<string, { id: string }> = {};
    for (const [key, row] of Object.entries(create ?? {})) {
      tags.push({ id: `new-${key}`, ...row });
      created[key] = { id: `new-${key}` };
    }
    for (const [id, patch] of Object.entries(update ?? {})) {
      const row = tags.find((t) => t.id === id)!;
      row.score = patch.score;
    }
    return { created, updated: Object.fromEntries(Object.keys(update ?? {}).map((id) => [id, null])), notUpdated: null };
  },
  actionReloadSettings: () => reload(),
}));

const {
  DMARC_QUARANTINE_HEADROOM,
  DMARC_VERIFY_STRICT,
  dmarcQuarantineScore,
  ensureSpamPolicy,
  parseSpamThresholds,
  sameExpression,
  serializeSpamScore,
} = await import('./spam-policy.js');

/** platform_settings rows the fake DB returns, and whether the lock was taken. */
let settingRows: Array<{ key: string; value: string }> = [];
let locked = 0;
const db = {
  transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ execute: async () => { locked++; } }),
  select: () => ({ from: () => ({ where: async () => settingRows }) }),
} as unknown as Database;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  senderAuth = null;
  spamSettings = null;
  tags = [{ id: 'jirfmwhscpqa', tag: 'DMARC_POLICY_QUARANTINE', '@type': 'Score', score: 1.5 }];
  writes.length = 0;
  unreachable = false;
  refuse = null;
  failReload = false;
  settingRows = [];
  locked = 0;
  reload.mockClear();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('parseSpamThresholds', () => {
  it('reads an unset setting as Stalwart\'s defaults: Junk at 5, nothing refused', () => {
    expect(parseSpamThresholds(undefined, undefined)).toEqual({ junk: 5, reject: null });
  });

  it('reads stored values, rounded to one decimal', () => {
    expect(parseSpamThresholds('6.25', '15')).toEqual({ junk: 6.3, reject: 15 });
  });

  it('falls back to the default Junk threshold for an unreadable or out-of-range value', () => {
    expect(parseSpamThresholds('abc', 'off').junk).toBe(5);
    expect(parseSpamThresholds('0.5', 'off').junk).toBe(5);
    expect(parseSpamThresholds('21', 'off').junk).toBe(5);
  });

  it('reads a refuse threshold that is off, unreadable or not above Junk as off — Junk is the safe side', () => {
    expect(parseSpamThresholds('5', 'off').reject).toBeNull();
    expect(parseSpamThresholds('5', 'x').reject).toBeNull();
    expect(parseSpamThresholds('8', '8').reject).toBeNull();
    expect(parseSpamThresholds('8', '7').reject).toBeNull();
    expect(parseSpamThresholds('5', '51').reject).toBeNull();
  });

  it('round-trips through serializeSpamScore', () => {
    expect(serializeSpamScore(null)).toBe('off');
    expect(parseSpamThresholds(serializeSpamScore(7.25), serializeSpamScore(12))).toEqual({ junk: 7.3, reject: 12 });
  });
});

describe('dmarcQuarantineScore', () => {
  it('puts a quarantine failure well past the Junk line when nothing is refused', () => {
    expect(dmarcQuarantineScore({ junk: 5, reject: null })).toBe(5 + DMARC_QUARANTINE_HEADROOM);
  });

  it('keeps that score when the refuse threshold is above it', () => {
    expect(dmarcQuarantineScore({ junk: 5, reject: 30 })).toBe(18);
  });

  it('scores just under a lower refuse threshold — the domain asked for Junk, not a bounce', () => {
    expect(dmarcQuarantineScore({ junk: 5, reject: 10 })).toBe(9.9);
    expect(dmarcQuarantineScore({ junk: 5, reject: 18 })).toBe(17.9);
  });

  it('never scores under the Junk line', () => {
    expect(dmarcQuarantineScore({ junk: 5, reject: 5.1 })).toBe(5);
  });
});

describe('sameExpression', () => {
  it('compares the rules, not the key order', () => {
    expect(sameExpression({ else: 'disable', match: { '0': { then: 'strict', if: 'local_port == 25' } } }, DMARC_VERIFY_STRICT)).toBe(true);
    expect(sameExpression(SENDER_AUTH_DEFAULTS.dmarcVerify, DMARC_VERIFY_STRICT)).toBe(false);
    expect(sameExpression(undefined, DMARC_VERIFY_STRICT)).toBe(false);
  });
});

describe('ensureSpamPolicy', () => {
  it('on a mail server with the defaults: enforces DMARC, scores quarantine into Junk, reloads once', async () => {
    const result = await ensureSpamPolicy(db, logger);

    expect(result.state).toBe('committed');
    expect(result.parts).toEqual({ dmarc: 'committed', thresholds: 'in-sync', quarantine: 'committed' });
    expect(locked).toBe(1);
    // The whole SenderAuth group is written — every field, the others as they were.
    const auth = writes.find((w) => w.group === 'SenderAuth')!.patch;
    expect(Object.keys(auth).sort()).toEqual(Object.keys(SENDER_AUTH_DEFAULTS).sort());
    expect(auth.dmarcVerify).toEqual(DMARC_VERIFY_STRICT);
    expect(auth.spfFromVerify).toEqual(SENDER_AUTH_DEFAULTS.spfFromVerify);
    expect(senderAuth?.dmarcVerify).toEqual(DMARC_VERIFY_STRICT);
    // Junk 5 / nothing refused is what Stalwart already has: no write.
    expect(writes.some((w) => w.group === 'SpamSettings')).toBe(false);
    expect(tags[0].score).toBe(18);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('is a no-op once in sync — no writes and no reload', async () => {
    await ensureSpamPolicy(db, logger);
    writes.length = 0;
    reload.mockClear();

    const result = await ensureSpamPolicy(db, logger);
    expect(result.state).toBe('in-sync');
    expect(writes).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('applies the operator\'s thresholds and scores quarantine just under the refuse line', async () => {
    settingRows = [{ key: 'mail_spam_junk_score', value: '6' }, { key: 'mail_spam_reject_score', value: '15' }];
    const result = await ensureSpamPolicy(db, logger);

    expect(result.parts.thresholds).toBe('committed');
    const patch = writes.find((w) => w.group === 'SpamSettings')!.patch;
    expect(Object.keys(patch).sort()).toEqual(Object.keys(SPAM_SETTINGS_DEFAULTS).sort());
    expect(spamSettings).toMatchObject({ scoreSpam: 6, scoreReject: 15, spamFilterRulesUrl: SPAM_SETTINGS_DEFAULTS.spamFilterRulesUrl });
    expect(tags[0].score).toBe(14.9);
  });

  it('turning the refuse threshold off writes Stalwart\'s 0', async () => {
    spamSettings = { ...SPAM_SETTINGS_DEFAULTS, scoreReject: 12 };
    settingRows = [{ key: 'mail_spam_reject_score', value: 'off' }];
    await ensureSpamPolicy(db, logger);
    expect(spamSettings.scoreReject).toBe(0);
  });

  it('keeps the fields it does not own as stored — an operator\'s strict DKIM stays', async () => {
    senderAuth = { ...SENDER_AUTH_DEFAULTS, dkimVerify: { match: {}, else: 'strict' } };
    await ensureSpamPolicy(db, logger);
    expect(senderAuth.dkimVerify).toEqual({ match: {}, else: 'strict' });
    expect(senderAuth.dmarcVerify).toEqual(DMARC_VERIFY_STRICT);
  });

  it('creates the quarantine tag when the server has no rules yet', async () => {
    tags = [];
    const result = await ensureSpamPolicy(db, logger);
    expect(result.parts.quarantine).toBe('committed');
    expect(tags).toEqual([{ id: 'new-q', '@type': 'Score', tag: 'DMARC_POLICY_QUARANTINE', score: 18 }]);
  });

  it('leaves a quarantine tag the operator made a Reject action — stricter than Junk', async () => {
    tags = [{ id: 't1', tag: 'DMARC_POLICY_QUARANTINE', '@type': 'Reject' }];
    const result = await ensureSpamPolicy(db, logger);
    expect(result.parts.quarantine).toBe('kept');
    expect(writes.some((w) => w.group === 'SpamTag')).toBe(false);
  });

  it('reports a refused write as incomplete, still applies and reloads the rest', async () => {
    refuse = 'SenderAuth';
    const result = await ensureSpamPolicy(db, logger);
    expect(result.state).toBe('incomplete');
    expect(result.parts).toEqual({ dmarc: 'rejected', thresholds: 'in-sync', quarantine: 'committed' });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ part: 'dmarc' }), expect.stringContaining('did not store'));
  });

  it('skips without writing or reloading when Stalwart is unreachable', async () => {
    unreachable = true;
    const result = await ensureSpamPolicy(db, logger);
    expect(result).toMatchObject({ state: 'skipped', reason: 'stalwart unreachable' });
    expect(writes).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a failed reload is logged — the values are stored and apply from the next restart', async () => {
    failReload = true;
    const result = await ensureSpamPolicy(db, logger);
    expect(result.state).toBe('committed');
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('ReloadSettings failed'));
  });

  it('never throws when the database is down', async () => {
    const down = { transaction: async () => { throw new Error('connection refused'); } } as unknown as Database;
    await expect(ensureSpamPolicy(down, logger)).resolves.toMatchObject({ state: 'skipped', reason: 'database unavailable' });
  });
});
