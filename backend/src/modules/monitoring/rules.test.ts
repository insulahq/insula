import { describe, it, expect } from 'vitest';
import { SLO_RULES, ruleById, renderExpr } from './rules.js';

describe('SLO_RULES — mail monitoring additions', () => {
  const MAIL_RULES = [
    'mail-server-down',
    'mail-queue-backlog',
    'mail-cert-expiry',
    'mail-cert-self-signed',
    'mail-mailbox-over-quota',
  ] as const;

  it('registers every new mail rule', () => {
    for (const id of MAIL_RULES) {
      expect(ruleById(id), `rule ${id} present`).toBeDefined();
    }
  });

  it('gives each mail rule a valid severity and a $T-parameterised expr', () => {
    for (const id of MAIL_RULES) {
      const rule = ruleById(id)!;
      expect(['warning', 'critical']).toContain(rule.severity);
      expect(rule.expr).toContain('$T');
      // renderExpr must fully substitute the threshold placeholder.
      const rendered = renderExpr(rule, undefined);
      expect(rendered).not.toContain('$T');
      expect(rendered).toContain(String(rule.threshold));
    }
  });

  it('reads first-party mail gauges (no un-scraped Stalwart metric)', () => {
    expect(ruleById('mail-server-down')!.expr).toContain('platform_mail_server_up');
    expect(ruleById('mail-queue-backlog')!.expr).toContain('platform_mail_outbound_queue_depth');
    expect(ruleById('mail-cert-expiry')!.expr).toContain('platform_mail_tls_cert_expiry_seconds');
    expect(ruleById('mail-cert-self-signed')!.expr).toContain('platform_mail_tls_cert_self_signed');
    expect(ruleById('mail-mailbox-over-quota')!.expr).toContain('platform_mail_mailboxes_over_quota');
  });

  it('mail-server-down folds an absent series to healthy (no false-fire when mail absent)', () => {
    // `or vector(0)` guarantees the count(==0) expr yields 0, not empty,
    // when the gauge series does not exist (mail not deployed).
    expect(ruleById('mail-server-down')!.expr).toContain('or vector(0)');
  });

  it('keeps unique rule ids across the whole pack', () => {
    const ids = SLO_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
