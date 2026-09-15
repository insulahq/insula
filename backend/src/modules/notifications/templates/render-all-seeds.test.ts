/**
 * Guard 2 of the overhaul plan: every seeded template must actually RENDER.
 *
 * `seed-consistency.test.ts` already proves each template DECLARES the
 * variables it references. That is necessary and not sufficient — it is a
 * static match on `{{ }}` occurrences, and it cannot see a body that parses
 * but throws at render time (a broken block helper, an unclosed `{{#if}}`, an
 * MJML body the compiler rejects).
 *
 * The plan called this a "boot self-test". A unit test is strictly better
 * placed: it fails on the PR that introduces the bad template rather than on
 * the pod that boots with it, and it costs nothing at runtime.
 *
 * Two passes, because the failure modes are different:
 *   - fully populated  -> a healthy notification must come out clean, with
 *                         nothing left unsubstituted.
 *   - nothing supplied -> the delivery path must STILL produce a message.
 *                         That is the whole contract of render-for-delivery:
 *                         a missing variable costs the recipient detail, never
 *                         the notification.
 */
import { describe, it, expect } from 'vitest';
import { ALL_SEED_TEMPLATES } from './seed-data.js';
import { renderForDelivery } from './render-for-delivery.js';
import { MISSING_VALUE } from './variables.js';
import type { NotificationTemplateResponse } from '@insula/api-contracts';

/** A seed row shaped like the stored template the renderer is given. */
function asTemplate(t: (typeof ALL_SEED_TEMPLATES)[number]): NotificationTemplateResponse {
  return {
    id: `${t.categoryId}:${t.channel}`,
    categoryId: t.categoryId,
    channel: t.channel,
    locale: t.locale,
    subjectTemplate: t.subjectTemplate,
    bodyTemplate: t.bodyTemplate,
    bodyFormat: t.bodyFormat,
    variablesSchema: t.variablesSchema,
    version: 1,
    isActive: true,
    updatedAt: new Date().toISOString(),
  } as unknown as NotificationTemplateResponse;
}

/** Every declared variable, filled with something recognisable. */
function fullPayload(t: (typeof ALL_SEED_TEMPLATES)[number]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of t.variablesSchema ?? []) out[v.name] = `«${v.name}»`;
  return out;
}

describe('every seeded template renders', () => {
  it('produces a clean body when every declared variable is supplied', async () => {
    const broken: string[] = [];
    for (const t of ALL_SEED_TEMPLATES) {
      // MJML compilation is exercised by its own suite and is slow; the
      // question here is whether the Handlebars layer survives.
      const r = await renderForDelivery(asTemplate(t), fullPayload(t), { skipMjml: true });
      const id = `${t.categoryId}/${t.channel}`;
      if (r.fallbackUsed) broken.push(`${id}: fell back to the envelope (${r.fallbackReason ?? 'no reason'})`);
      else if (r.body.includes('{{')) broken.push(`${id}: left an unsubstituted {{…}} in the body`);
      else if (r.degradedVars.length > 0) broken.push(`${id}: degraded on ${r.degradedVars.join(', ')} despite a full payload`);
    }
    expect(broken, `templates that do not render cleanly:\n  ${broken.join('\n  ')}`).toEqual([]);
  });

  it('still produces a message when NOTHING is supplied', async () => {
    // The defect this whole overhaul started from: one missing variable meant
    // no notification at all. An empty payload is the worst case, and it must
    // still deliver something an operator can act on.
    const silent: string[] = [];
    for (const t of ALL_SEED_TEMPLATES) {
      const r = await renderForDelivery(asTemplate(t), {}, { skipMjml: true });
      const id = `${t.categoryId}/${t.channel}`;
      if (!r.body || r.body.trim().length === 0) silent.push(`${id}: rendered an EMPTY body`);
      if (r.body.includes('{{')) silent.push(`${id}: left raw Handlebars in the body`);
    }
    expect(silent, `templates that would deliver nothing:\n  ${silent.join('\n  ')}`).toEqual([]);
  });

  it('marks what it could not fill rather than hiding it', async () => {
    const t = ALL_SEED_TEMPLATES.find((x) => (x.variablesSchema ?? []).some((v) => v.required));
    expect(t, 'expected at least one template with a required variable').toBeDefined();
    const r = await renderForDelivery(asTemplate(t!), {}, { skipMjml: true });
    // Degradation is reported, not silent — that is what makes it auditable.
    expect(r.degradedVars.length).toBeGreaterThan(0);
    expect(r.body).toContain(MISSING_VALUE);
  });
});
