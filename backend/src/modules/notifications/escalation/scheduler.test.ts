/**
 * The escalation sweep must never mark work as chased that nobody was told
 * about. Both tests below reproduce a defect measured on the DEV cluster.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const notifySpy = vi.fn();
vi.mock('../events.js', () => ({
  notifyAdminEscalation: (...args: unknown[]) => { notifySpy(...args); return Promise.resolve(); },
}));

const markSpy = vi.fn();
vi.mock('./service.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    findEscalationCandidates: () => Promise.resolve(candidates),
    markEscalated: (...args: unknown[]) => { markSpy(...args); return Promise.resolve(); },
  };
});

let candidates: Array<{
  id: string; userId: string; categoryId: string; title: string; message: string; createdAt: Date;
  eventId: string | null; tenantName: string | null; tenantScoped: boolean;
}> = [];

const { runOnce } = await import('./scheduler.js');

/** A db whose delivery lookup returns `rows` — empty means nothing was delivered. */
function db(rows: unknown[]) {
  const chain = { from: () => chain, where: () => chain, limit: () => Promise.resolve(rows) };
  return { select: () => chain } as never;
}

const cand = (id: string, tenantName: string | null = null) => ({
  id, userId: 'u1', categoryId: 'mailbox.quota_threshold',
  title: `title ${id}`, message: 'm', createdAt: new Date('2026-08-09T00:00:00Z'),
  eventId: `e-${id}`, tenantName, tenantScoped: tenantName !== null,
});

beforeEach(() => { notifySpy.mockClear(); markSpy.mockClear(); });

describe('escalation sweep', () => {
  it('does NOT mark rows when no delivery exists for the batch', async () => {
    // The exact DEV failure: today's per-day dedupe key had already been
    // consumed by an earlier run, so the dispatch was silently skipped while
    // markEscalated ran anyway — 45 unread actions marked "chased" that no
    // operator was ever told about, and permanently ineligible to escalate.
    candidates = [cand('a'), cand('b')];
    const n = await runOnce(db([]), new Date('2026-09-15T12:00:00Z'));
    expect(markSpy).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it('marks rows once a delivery for the batch exists', async () => {
    candidates = [cand('a'), cand('b')];
    const n = await runOnce(db([{ id: 'd1' }]), new Date('2026-09-15T12:00:00Z'));
    expect(markSpy).toHaveBeenCalledOnce();
    expect((markSpy.mock.calls[0][1] as Array<{ id: string }>).map((c) => c.id)).toEqual(['a', 'b']);
    expect(n).toBe(2);
  });

  it('gives a DIFFERENT batch a different dedupe key on the same day', async () => {
    // A per-day key suppressed every batch after the first. The backlog drains
    // over several ticks, so batch two must still get through.
    candidates = [cand('a')];
    await runOnce(db([{ id: 'd1' }]), new Date('2026-09-15T12:00:00Z'));
    const first = notifySpy.mock.calls[0][2];

    candidates = [cand('c')];
    await runOnce(db([{ id: 'd2' }]), new Date('2026-09-15T13:00:00Z'));
    const second = notifySpy.mock.calls[1][2];

    expect(first).not.toEqual(second);
    expect(first).toContain('escalation:2026-09-15:');
  });

  it('gives an IDENTICAL batch the same key, so a repeat tick does not spam', async () => {
    candidates = [cand('a'), cand('b')];
    await runOnce(db([{ id: 'd1' }]), new Date('2026-09-15T12:00:00Z'));
    await runOnce(db([{ id: 'd1' }]), new Date('2026-09-15T18:00:00Z'));
    expect(notifySpy.mock.calls[0][2]).toEqual(notifySpy.mock.calls[1][2]);
  });

  it("keeps a reminder that names a tenant off the shared push topic", async () => {
    // The items quote notifications about a tenant — its workloads, its
    // mailboxes. ntfy is one topic for everyone subscribed to it.
    candidates = [cand('a'), cand('b', 'Acme')];
    await runOnce(db([{ id: 'd1' }]), new Date('2026-09-15T12:00:00Z'));
    expect(notifySpy.mock.calls[0][3]).toEqual({ tenantScopedContent: true });

    candidates = [cand('c')];
    await runOnce(db([{ id: 'd2' }]), new Date('2026-09-15T13:00:00Z'));
    expect(notifySpy.mock.calls[1][3]).toEqual({ tenantScopedContent: false });
  });

  it('counts notifications, not the recipients\' copies of them', async () => {
    candidates = [cand('a'), { ...cand('b'), eventId: 'e-a' }, cand('c')];
    await runOnce(db([{ id: 'd1' }]), new Date('2026-09-15T12:00:00Z'));
    expect(notifySpy.mock.calls[0][1]).toMatchObject({ count: '2' });
  });
});
