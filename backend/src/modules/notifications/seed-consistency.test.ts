import { describe, it, expect } from 'vitest';
import { ALL_CATEGORIES } from './categories/seed.js';
import { ALL_SEED_TEMPLATES } from './templates/seed-data.js';

/**
 * A category and its templates are seeded from two separate files, and nothing
 * connected them. Add a category without templates and the dispatcher happily
 * fires it — the operator gets a notification row with no rendered subject or
 * body, which is arguably worse than no notification, because the alert now
 * exists and says nothing.
 *
 * Written while adding `admin.mail_health_degraded`; it applies to every
 * category, so it is a general guard rather than a test of that one addition.
 */
describe('notification seed consistency', () => {
  const templatesFor = (categoryId: string, channel: string): number =>
    ALL_SEED_TEMPLATES.filter((t) => t.categoryId === categoryId && t.channel === channel).length;

  it('every category has a template for each of its default channels', () => {
    const missing: string[] = [];
    for (const cat of ALL_CATEGORIES) {
      for (const channel of cat.defaultChannels) {
        // Webhook/slack-style channels render from the payload, not a seeded
        // template — only the two rendered channels are required here.
        if (channel !== 'in_app' && channel !== 'email') continue;
        if (templatesFor(cat.id, channel) === 0) missing.push(`${cat.id} → ${channel}`);
      }
    }
    expect(missing, `categories with a default channel but no seeded template:\n  ${missing.join('\n  ')}`)
      .toEqual([]);
  });

  it('every seeded template points at a real category', () => {
    const known = new Set(ALL_CATEGORIES.map((c) => c.id));
    const orphans = [...new Set(
      ALL_SEED_TEMPLATES.filter((t) => !known.has(t.categoryId)).map((t) => t.categoryId),
    )];
    expect(orphans, `templates referencing a category that does not exist:\n  ${orphans.join('\n  ')}`)
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

  // The specific category this work added, asserted by name so a later
  // refactor that drops it fails loudly rather than silently going quiet.
  it('ships the mail-health category on both rendered channels', () => {
    const cat = ALL_CATEGORIES.find((c) => c.id === 'admin.mail_health_degraded');
    expect(cat, 'admin.mail_health_degraded category is missing').toBeDefined();
    expect(cat?.audience).toBe('admin');
    expect(cat?.defaultChannels).toContain('in_app');
    expect(cat?.defaultChannels).toContain('email');
    expect(templatesFor('admin.mail_health_degraded', 'in_app')).toBe(1);
    expect(templatesFor('admin.mail_health_degraded', 'email')).toBe(1);
  });
});
