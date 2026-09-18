import { describe, it, expect } from 'vitest';
import { ALL_SEED_TEMPLATES } from './seed-data.js';
import { renderForDelivery } from './render-for-delivery.js';
import { renderTemplate } from './renderer.js';

/**
 * Regression guard for the in-app notification audit: several
 * in-app templates dropped the diagnostic detail (errorMessage / driftSummary /
 * reason) that their email counterpart included, so the dropdown showed
 * "X failed" with no reason. Each now appends the detail via {{#if optional}}.
 *
 * This pins BOTH directions per category: the detail appears when the field is
 * provided, and the template still renders (no strict-mode throw, which would be
 * swallowed by dispatchSafe and vanish silently) when it is absent.
 */
const CASES: Array<{ categoryId: string; field: string; sample: string }> = [
  { categoryId: 'admin.backup_failed', field: 'errorMessage', sample: 'disk full' },
  { categoryId: 'admin.backup_target_unreachable', field: 'errorMessage', sample: 'connection refused' },
  { categoryId: 'admin.cert_renewal_failed', field: 'errorMessage', sample: 'DNS-01 timeout' },
  { categoryId: 'admin.security_hardening_drift', field: 'driftSummary', sample: 'sshd root login re-enabled' },
  { categoryId: 'admin.wal_archive_failing', field: 'reason', sample: 'S3 403' },
  { categoryId: 'admin.wal_archive_auto_disabled', field: 'reason', sample: 'repeated 403s' },
  { categoryId: 'subscription.renewed', field: 'newExpiresAt', sample: '2026-09-01' },
  { categoryId: 'tasks.scheduled_failure', field: 'errorMessage', sample: 'exit 2' },
];

function inAppTemplate(categoryId: string) {
  const t = ALL_SEED_TEMPLATES.find((x) => x.categoryId === categoryId && x.channel === 'in_app');
  if (!t) throw new Error(`no in_app template for ${categoryId}`);
  // The renderer's compile cache keys on id::version — give each a unique id so
  // seed templates (which carry no DB id) don't all collide under undefined.
  return { ...t, id: `test-${categoryId}`, version: 1, isActive: true } as unknown as Parameters<typeof renderTemplate>[0];
}

describe('in-app notifications include their diagnostic detail', () => {
  for (const { categoryId, field, sample } of CASES) {
    // Seed every var the body references (parsed straight from the template) a
    // placeholder so direct-output vars render; the field under test is toggled.
    const seedAll = (t: ReturnType<typeof inAppTemplate>): Record<string, unknown> => {
      const vars: Record<string, unknown> = {};
      const body = String((t as unknown as { bodyTemplate: string }).bodyTemplate);
      for (const m of body.matchAll(/\{\{#?(?:if\s+)?(\w+)\}\}/g)) vars[m[1]] = 'x';
      return vars;
    };

    it(`${categoryId}: shows ${field} when provided`, () => {
      const t = inAppTemplate(categoryId);
      const vars = seedAll(t);
      vars[field] = sample;
      expect(renderTemplate(t, vars).body).toContain(sample);
    });

    // Asserted against the DELIVERY path, not the strict one.
    //
    // This used to require that strict `renderTemplate` not throw when the
    // field was absent, which in practice forced every optional detail into a
    // `{{#if}}` block — and `{{#if}}` is exactly the form that renders '' and
    // strips the fact with no error. The requirement was right ("a missing
    // detail must not cost the message") and the mechanism was wrong.
    //
    // renderForDelivery now guarantees it directly: the variable is pre-filled
    // with a visible placeholder, the message still goes out, and the omission
    // is reported in degradedVars instead of being hidden.
    it(`${categoryId}: still delivers when ${field} is absent, and reports it`, async () => {
      const t = inAppTemplate(categoryId);
      const vars = seedAll(t);
      delete vars[field]; // omit the optional field entirely
      const r = await renderForDelivery(t, vars);
      expect(r.fallbackUsed).toBe(false);
      expect(r.body.length).toBeGreaterThan(0);
      expect(r.degradedVars).toContain(field);
    });
  }
});
