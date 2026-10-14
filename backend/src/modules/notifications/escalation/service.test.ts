import { describe, it, expect } from 'vitest';
import {
  isEscalatable,
  describeCandidates,
  concernsTenants,
  countEvents,
  oneLine,
  ESCALATE_AFTER_HOURS,
} from './service.js';

describe('isEscalatable — what is worth chasing', () => {
  it('escalates action, which is the class that asks for something', () => {
    expect(isEscalatable('mailbox.quota_threshold')).toBe(true);
    expect(isEscalatable('subscription.expiry_warning')).toBe(true);
  });

  // Ambient and Record ask for nothing, so there is nothing to chase.
  it('does not escalate ambient or record', () => {
    expect(isEscalatable('admin.slo_alert_resolved')).toBe(false);
    expect(isEscalatable('subscription.renewed')).toBe(false);
  });

  // These already reach every channel the audience has at the moment they
  // fire. There is no higher level; escalating would just send a second copy.
  it('does not escalate incident, availability or security', () => {
    expect(isEscalatable('admin.backup_failed')).toBe(false);
    expect(isEscalatable('admin.node_down')).toBe(false);
    expect(isEscalatable('security.password_reset')).toBe(false);
  });

  it('reads the CLASS, not the severity', () => {
    // subscription.expiry_warning is severity=warning and class=action -> chase.
    // admin.slo_alert_critical is severity=critical and class=incident -> do not.
    expect(isEscalatable('subscription.expiry_warning')).toBe(true);
    expect(isEscalatable('admin.slo_alert_critical')).toBe(false);
  });

  it('ignores an uncategorised row rather than guessing', () => {
    expect(isEscalatable(null)).toBe(false);
    expect(isEscalatable('not.a.category')).toBe(false);
  });

  // Production chased "Email sending at 88% of the hour limit" two days
  // after the hour it measured had ended.
  it('does not chase an action whose window closes before the deadline', () => {
    expect(isEscalatable('tenant.email_quota_warning')).toBe(false);
    expect(isEscalatable('admin.email_abuse_warning')).toBe(false);
  });

  // Its quote of the first reminder would carry tenant text as an admin item.
  it('never chases a reminder with a reminder', () => {
    expect(isEscalatable('admin.notification_escalated')).toBe(false);
  });

  it(`uses a ${ESCALATE_AFTER_HOURS}h deadline`, () => {
    expect(ESCALATE_AFTER_HOURS).toBe(48);
  });
});

// The query itself (class filter, read copies, tenant names) is proven against
// a real Postgres in service.integration.test.ts — a mock would agree with
// whatever SQL it was handed.

const row = (categoryId: string, daysAgo = 3) => ({
  id: `n-${categoryId}`,
  userId: 'u1',
  categoryId,
  title: `${categoryId} title`,
  message: 'm',
  createdAt: new Date(Date.now() - daysAgo * 86_400_000),
  eventId: null as string | null,
  recipientPanel: 'admin' as 'admin' | 'tenant',
  tenantName: null as string | null,
  tenantScoped: false,
});
const tenantRow = (categoryId: string, tenantName: string) => ({
  ...row(categoryId), recipientPanel: 'tenant' as const, tenantName, tenantScoped: true,
});

describe('describeCandidates', () => {
  it('says who received it, what it was, since when, and what it said', () => {
    const s = describeCandidates([{
      ...tenantRow('tenant.email_quota_warning', 'Acme'),
      title: 'Email sending at 88% of the hour limit',
      message: '44 of 50 messages sent this hour as of 2026-10-12 18:48 UTC. Sending accounts: \n• box@example.test (44 sent)',
      createdAt: new Date('2026-10-12T18:48:41Z'),
    }]);
    expect(s).toEqual([
      'Tenant Acme: Email sending at 88% of the hour limit — unread since 2026-10-12. It said: '
      + '44 of 50 messages sent this hour as of 2026-10-12 18:48 UTC. Sending accounts: box@example.test (44 sent)',
    ]);
  });

  it("labels a platform admin's own copy as theirs", () => {
    const s = describeCandidates([{ ...row('admin.backup_never_run'), title: 'Backups never ran', message: '' }]);
    expect(s[0]).toMatch(/^Platform admins: Backups never ran — unread since \d{4}-\d{2}-\d{2}\.$/);
  });

  it('collapses repeated titles for the same recipient into one counted line, quoting the newest', () => {
    // The first real escalation on DEV listed the SAME SLO warning six times.
    // An escalation that repeats itself is the noise it exists to cut through.
    const dup = Array.from({ length: 6 }, (_, i) => ({
      ...row('mailbox.quota_threshold'),
      id: `n${i}`,
      title: 'Ingress p95 latency',
      message: `p95 at ${600 + i}ms`,
      createdAt: new Date(Date.UTC(2026, 7, 9 + i)),
    }));
    const s = describeCandidates(dup);
    expect(s).toEqual(['Platform admins: Ingress p95 latency x6 — oldest unread since 2026-08-09. The latest said: p95 at 605ms']);
  });

  it('keeps the same title for two tenants apart — a count names neither', () => {
    const s = describeCandidates([
      { ...tenantRow('subscription.expiry_warning', 'Acme'), id: 'a', title: 'Subscription expiring soon' },
      { ...tenantRow('subscription.expiry_warning', 'Globex'), id: 'b', title: 'Subscription expiring soon' },
    ]);
    expect(s).toHaveLength(2);
    expect(s.some((l) => l.startsWith('Tenant Acme: Subscription expiring soon'))).toBe(true);
    expect(s.some((l) => l.startsWith('Tenant Globex: Subscription expiring soon'))).toBe(true);
  });

  it('counts an event once, however many recipients left their copy unread', () => {
    const copies = ['u1', 'u2', 'u3'].map((userId, i) => ({
      ...tenantRow('mailbox.quota_threshold', 'Acme'), id: `c${i}`, userId, eventId: 'e1', title: 'Mailbox full', message: '',
    }));
    expect(describeCandidates(copies)).toEqual([expect.stringMatching(/^Tenant Acme: Mailbox full — unread since/)]);
    expect(countEvents(copies)).toBe(1);
  });

  it('orders the most-repeated first', () => {
    const mixed = [
      { ...row('mailbox.quota_threshold'), id: 'a', title: 'Once' },
      { ...row('mailbox.quota_threshold'), id: 'b', title: 'Twice' },
      { ...row('mailbox.quota_threshold'), id: 'c', title: 'Twice' },
    ];
    const s = describeCandidates(mixed);
    expect(s[0]).toMatch(/^Platform admins: Twice x2/);
    expect(s[1]).toMatch(/^Platform admins: Once/);
  });

  it('caps the list by count, so one bad day cannot produce an unbounded body', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      ...row('mailbox.quota_threshold'), id: `n${i}`, title: `Notification number ${i}`,
    }));
    const s = describeCandidates(many);
    expect(s).toHaveLength(26);
    expect(s[25]).toBe('…and 475 more.');
  });
});

describe('oneLine', () => {
  it("joins the original's own list onto its sentence, items comma-separated", () => {
    expect(oneLine('Sending accounts:\n• a@example.test (40 sent)\n• b@example.test (4 sent)'))
      .toBe('Sending accounts: a@example.test (40 sent), b@example.test (4 sent)');
  });

  it('shortens a long message at a word, never mid-word', () => {
    const out = oneLine(`${'word '.repeat(200)}end`);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.endsWith('word…')).toBe(true);
  });
});

describe('concernsTenants', () => {
  // A tenant's mailbox address must never reach the operator's shared push topic.
  it('is true as soon as one item is a tenant\'s', () => {
    expect(concernsTenants([row('admin.backup_never_run')])).toBe(false);
    expect(concernsTenants([row('admin.backup_never_run'), tenantRow('mailbox.quota_threshold', 'Acme')])).toBe(true);
  });

  it('reads the row\'s scope, not the tenant name beside it', () => {
    expect(concernsTenants([{ ...row('admin.backup_never_run'), tenantScoped: true }])).toBe(true);
  });
});
