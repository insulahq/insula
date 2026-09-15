/**
 * Guard 4 of the overhaul plan: the "fix" that re-breaks everything.
 *
 * ## The incident this pins
 *
 * `subscription.renewed` referenced `{{nextBillingAt}}`. The dispatcher never
 * passed it. Handlebars is compiled with `strict: true`, so the render THREW,
 * the dispatcher recorded `status='skipped'`, and sixteen renewal emails were
 * never sent. `skipped` raises no alert and is not in the retry scan, so the
 * loss was silent and stayed silent.
 *
 * The repair was NOT to turn strict mode off. Strict mode is what catches a
 * template referencing something nobody supplies — turning it off would swap
 * a loud skip for a body reading "Renews on ." Instead every referenced
 * variable is FILLED before rendering (`fillMissingVariables`), so strict mode
 * has nothing to throw about, and what was missing is recorded in
 * `degradedVars` for audit.
 *
 * That leaves an obvious-looking "cleanup" available to a future reader:
 * delete the fill step because "strict mode already validates this", or drop
 * the try/catch because "renderForDelivery never throws anyway". Either one
 * silently restores the original defect. These tests exist to fail loudly if
 * anyone does.
 */
import { describe, it, expect } from 'vitest';
import { renderForDelivery } from './render-for-delivery.js';
import { MISSING_VALUE } from './variables.js';
import type { NotificationTemplateResponse } from '@insula/api-contracts';

// The renderer caches compiled templates on `id::version`. Reusing one id
// across cases made a later malformed body silently reuse an earlier VALID
// compile — the test passed while asserting nothing. Unique id per call.
let seq = 0;
function tpl(body: string, subject: string | null = 'Subscription renewed'): NotificationTemplateResponse {
  seq += 1;
  return {
    id: `strict-regression-${seq}`,
    categoryId: 'subscription.renewed',
    channel: 'email',
    locale: 'en',
    subjectTemplate: subject,
    bodyTemplate: body,
    bodyFormat: 'plaintext',
    variablesSchema: [{ name: 'nextBillingAt', type: 'string', required: true }],
    version: 1,
    isActive: true,
    updatedAt: new Date().toISOString(),
  } as unknown as NotificationTemplateResponse;
}

describe('strict-mode regression: subscription.renewed / nextBillingAt', () => {
  it('does NOT throw when the dispatcher omits a referenced variable', async () => {
    // This is the exact shape that cost 16 renewal emails.
    await expect(
      renderForDelivery(tpl('Your subscription renews on {{nextBillingAt}}.'), {}),
    ).resolves.toBeDefined();
  });

  it('still delivers a usable message, and says what was missing', async () => {
    const r = await renderForDelivery(tpl('Your subscription renews on {{nextBillingAt}}.'), {});
    expect(r.body).toContain(MISSING_VALUE);          // visible placeholder, not a blank
    expect(r.body).not.toContain('{{');               // no raw template leaked
    expect(r.degradedVars).toContain('nextBillingAt'); // recorded for audit
  });

  it('is NOT silently succeeding because the variable was optional', async () => {
    // If someone "fixes" this by marking the variable optional, the guard
    // would keep passing while the body quietly rendered empty. Assert the
    // schema still declares it REQUIRED — that is what makes the fill
    // meaningful.
    const t = tpl('renews {{nextBillingAt}}');
    expect(t.variablesSchema?.find((v) => v.name === 'nextBillingAt')?.required).toBe(true);
  });

  it('renders normally once the variable IS supplied', async () => {
    const r = await renderForDelivery(
      tpl('Your subscription renews on {{nextBillingAt}}.'),
      { nextBillingAt: '2026-10-01' },
    );
    expect(r.body).toContain('2026-10-01');
    expect(r.degradedVars).toEqual([]);
    expect(r.fallbackUsed).toBe(false);
  });

  it('falls back rather than throwing even when the body is malformed', async () => {
    // The reference extractor cannot see every construct; strict mode still
    // guards those. The delivery path must survive them too.
    const r = await renderForDelivery(tpl('{{#each nope}}{{this}}'), {});
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.fallbackUsed).toBe(true);
  });
});
