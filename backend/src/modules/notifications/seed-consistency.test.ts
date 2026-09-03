import { describe, it, expect } from 'vitest';
import { NOTIFICATION_CHANNEL_ID } from '@insula/api-contracts';
import { ALL_CATEGORIES } from './categories/seed.js';
import { ALL_SEED_TEMPLATES } from './templates/seed-data.js';

/**
 * The coverage guard for the (category × channel) template matrix.
 *
 * Two files seed independently — `categories/seed.ts` and
 * `templates/seed-data.ts` — and nothing in the type system connects them.
 * A category with no template dispatches happily and delivers a
 * notification that says nothing; a *channel* with no templates delivers
 * nothing at all, and the only trace is `no_template` in the delivery log.
 *
 * This guard has now failed to catch that twice, both times because it
 * looked at a narrower set than the code did:
 *
 *   1. It skipped any channel that was not `in_app` or `email`
 *      (`if (channel !== 'in_app' && channel !== 'email') continue`). The
 *      ntfy channel shipped with a provider, an enum entry, a publisher, a
 *      queue worker and ZERO templates, and this file stayed green.
 *   2. It only required a template for channels a category listed in its
 *      *seed* `defaultChannels`. But `defaultChannels` is operator-editable
 *      at runtime (`PATCH /admin/notifications/categories/:id` accepts any
 *      subset of NOTIFICATION_CHANNEL_ID), so the seed list is a default,
 *      not a bound. `tls.certificate_issued` seeds `['in_app']` and had no
 *      email template — one operator toggle from silent delivery.
 *
 * So the invariant asserted here is the FULL matrix, driven off the
 * contract enum: every category, every channel, locale 'en'. No
 * exclusions, no exemption list — an exemption is what both misses were.
 *
 * Compile-time companion: `CHANNEL_SEED_STRATEGY` in templates/seed-data.ts
 * is `Record<NotificationChannelId, …>`, so adding a channel to the
 * contract enum fails `tsc` before it ever reaches these tests.
 * CI companion: scripts/ci-notification-template-coverage.sh.
 */
describe('notification seed consistency', () => {
  const LOCALE = 'en';

  const templatesFor = (categoryId: string, channel: string): number =>
    ALL_SEED_TEMPLATES.filter(
      (t) => t.categoryId === categoryId && t.channel === channel && t.locale === LOCALE,
    ).length;

  it('every category has a template for EVERY channel', () => {
    const missing: string[] = [];
    for (const cat of ALL_CATEGORIES) {
      // Deliberately NOT `cat.defaultChannels` — that is an operator-editable
      // default, so any category can be routed to any channel at runtime.
      for (const channel of NOTIFICATION_CHANNEL_ID) {
        if (templatesFor(cat.id, channel) === 0) missing.push(`${cat.id} → ${channel}`);
      }
    }
    expect(
      missing,
      'Every category needs a seed template on every channel in NOTIFICATION_CHANNEL_ID.\n'
        + 'Missing (the dispatcher would drop these with `no_template`):\n  '
        + missing.join('\n  '),
    ).toEqual([]);
  });

  it('every channel in the contract enum has full category coverage', () => {
    // Same matrix, pivoted: this is the assertion that fails loudly and
    // legibly when a NEW CHANNEL is added with no templates behind it,
    // rather than reporting 50 unrelated-looking per-category misses.
    const shortfall: string[] = [];
    for (const channel of NOTIFICATION_CHANNEL_ID) {
      const covered = new Set(
        ALL_SEED_TEMPLATES.filter((t) => t.channel === channel && t.locale === LOCALE)
          .map((t) => t.categoryId),
      );
      if (covered.size !== ALL_CATEGORIES.length) {
        shortfall.push(`${channel}: ${covered.size}/${ALL_CATEGORIES.length} categories`);
      }
    }
    expect(
      shortfall,
      'A delivery channel with partial template coverage sends nothing for the\n'
        + 'uncovered categories. Add its templates to templates/seed-data.ts\n'
        + '(hand-authored, or derived via CHANNEL_SEED_STRATEGY).\n  '
        + shortfall.join('\n  '),
    ).toEqual([]);
  });

  it('every seeded template points at a real category', () => {
    const known = new Set(ALL_CATEGORIES.map((c) => c.id));
    const orphans = [...new Set(
      ALL_SEED_TEMPLATES.filter((t) => !known.has(t.categoryId)).map((t) => t.categoryId),
    )];
    expect(orphans, `templates referencing a category that does not exist:\n  ${orphans.join('\n  ')}`)
      .toEqual([]);
  });

  it('every seeded template names a channel in the contract enum', () => {
    const known = new Set<string>(NOTIFICATION_CHANNEL_ID);
    const strays = [...new Set(
      ALL_SEED_TEMPLATES.filter((t) => !known.has(t.channel)).map((t) => t.channel),
    )];
    expect(strays, `templates on a channel the API does not know:\n  ${strays.join('\n  ')}`)
      .toEqual([]);
  });

  it('has no duplicate (category, channel, locale) template', () => {
    const seen = new Map<string, number>();
    for (const t of ALL_SEED_TEMPLATES) {
      const key = `${t.categoryId}|${t.channel}|${t.locale}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    expect(dupes, `duplicate templates (last one silently wins at seed time):\n  ${dupes.join('\n  ')}`)
      .toEqual([]);
  });

  it('has no duplicate category id', () => {
    const seen = new Map<string, number>();
    for (const c of ALL_CATEGORIES) seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    expect(dupes).toEqual([]);
  });

  it('declares every variable its body and subject reference', () => {
    // The renderer compiles with `strict: true`, so a body referencing a
    // variable the dispatcher does not pass THROWS, and the dispatcher
    // records a skip instead of delivering. A template that references an
    // undeclared variable is a notification that silently never arrives.
    const VAR = /\{\{\{?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}?\}\}/g;
    const offenders: string[] = [];
    for (const t of ALL_SEED_TEMPLATES) {
      const declared = new Set((t.variablesSchema ?? []).map((v) => v.name));
      const refs = new Set([
        ...[...t.bodyTemplate.matchAll(VAR)].map((m) => m[1]),
        ...[...(t.subjectTemplate ?? '').matchAll(VAR)].map((m) => m[1]),
      ]);
      const undeclared = [...refs].filter((r) => !declared.has(r));
      if (undeclared.length > 0) {
        offenders.push(`${t.categoryId}/${t.channel}: ${undeclared.join(', ')}`);
      }
    }
    expect(
      offenders,
      `templates referencing variables absent from variablesSchema (strict Handlebars throws):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('ships ntfy templates as plaintext with a push title', () => {
    // ntfy is a phone push: the publisher sends `title` + `message` as JSON
    // and never sets X-Markdown, so a markdown/MJML body would arrive as
    // raw source on the device.
    const ntfy = ALL_SEED_TEMPLATES.filter((t) => t.channel === 'ntfy');
    expect(ntfy.length).toBe(ALL_CATEGORIES.length);
    expect(ntfy.filter((t) => t.bodyFormat !== 'plaintext').map((t) => t.categoryId)).toEqual([]);
    expect(ntfy.filter((t) => !t.subjectTemplate).map((t) => t.categoryId)).toEqual([]);
  });

  it('keeps derived ntfy variables identical to their in_app source', () => {
    // The dispatcher hands the ntfy leg the SAME event variables as the
    // in_app leg. If the two schemas diverge, one of them renders against
    // a variable set it was not written for.
    const mismatched: string[] = [];
    for (const cat of ALL_CATEGORIES) {
      const src = ALL_SEED_TEMPLATES.find((t) => t.categoryId === cat.id && t.channel === 'in_app');
      const push = ALL_SEED_TEMPLATES.find((t) => t.categoryId === cat.id && t.channel === 'ntfy');
      if (!src || !push) continue; // covered by the matrix tests above
      const a = [...(src.variablesSchema ?? [])].map((v) => `${v.name}:${v.type}:${v.required ?? false}`).sort();
      const b = [...(push.variablesSchema ?? [])].map((v) => `${v.name}:${v.type}:${v.required ?? false}`).sort();
      if (a.join('|') !== b.join('|')) mismatched.push(cat.id);
    }
    expect(mismatched, `ntfy/in_app variable schemas diverged:\n  ${mismatched.join('\n  ')}`)
      .toEqual([]);
  });

  // Asserted by name so a later refactor that drops it fails loudly rather
  // than silently going quiet.
  it('ships the mail-health category on every channel', () => {
    const cat = ALL_CATEGORIES.find((c) => c.id === 'admin.mail_health_degraded');
    expect(cat, 'admin.mail_health_degraded category is missing').toBeDefined();
    expect(cat?.audience).toBe('admin');
    expect(cat?.defaultChannels).toContain('in_app');
    expect(cat?.defaultChannels).toContain('email');
    for (const channel of NOTIFICATION_CHANNEL_ID) {
      expect(templatesFor('admin.mail_health_degraded', channel), `missing ${channel} template`).toBe(1);
    }
  });
});
