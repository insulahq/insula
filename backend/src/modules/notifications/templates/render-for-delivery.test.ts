import { describe, it, expect, beforeEach } from 'vitest';
import { renderForDelivery, buildEnvelopeFallback } from './render-for-delivery.js';
import { MISSING_VALUE, _resetVariableCacheForTests } from './variables.js';
import { _resetRendererCacheForTests } from './renderer.js';
import type { NotificationTemplateResponse } from '@insula/api-contracts';

function tpl(over: Partial<NotificationTemplateResponse> = {}): NotificationTemplateResponse {
  return {
    id: 'tpl-1',
    categoryId: 'subscription.renewed',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Subscription renewed',
    bodyTemplate: 'Your subscription for {{tenantName}} was renewed. Next billing: {{nextBillingAt}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [],
    version: 1,
    isActive: true,
    updatedAt: new Date().toISOString(),
    ...over,
  } as unknown as NotificationTemplateResponse;
}

beforeEach(() => {
  _resetVariableCacheForTests();
  _resetRendererCacheForTests();
});

describe('renderForDelivery — the production defect', () => {
  // Emitter sends newExpiresAt; every template reads nextBillingAt.
  const payload = { tenantName: 'Example Ltd', newExpiresAt: '2026-10-01' };

  it('DELIVERS instead of throwing when a referenced variable is absent', async () => {
    const r = await renderForDelivery(tpl(), payload);
    expect(r.fallbackUsed).toBe(false);
    expect(r.body).toContain('Example Ltd');
    expect(r.body).toContain(MISSING_VALUE);
  });

  it('reports the absent variable so the gap is visible, not silent', async () => {
    const r = await renderForDelivery(tpl(), payload);
    expect(r.degradedVars).toEqual(['nextBillingAt']);
  });

  it('catches the {{#if}} form too — the one that used to lose data quietly', async () => {
    const t = tpl({
      bodyTemplate: 'Renewed.{{#if nextBillingAt}} Next billing: {{nextBillingAt}}.{{/if}}',
    });
    const r = await renderForDelivery(t, payload);
    expect(r.degradedVars).toEqual(['nextBillingAt']);
    expect(r.fallbackUsed).toBe(false);
  });

  it('reports nothing degraded when the contract is honoured', async () => {
    const r = await renderForDelivery(tpl(), { tenantName: 'Example Ltd', nextBillingAt: '2026-10-01' });
    expect(r.degradedVars).toEqual([]);
    expect(r.body).toContain('2026-10-01');
    expect(r.body).not.toContain(MISSING_VALUE);
  });
});

describe('renderForDelivery — never throws', () => {
  // An unclosed block is a Handlebars PARSE error, which throws inside
  // compile() before any variable is substituted — the one failure the
  // reference extractor cannot pre-empt, and therefore the case the
  // envelope fallback exists for.
  it('falls back to the envelope when the template cannot compile', async () => {
    const t = tpl({ bodyTemplate: 'Renewed.{{#if nextBillingAt}}unclosed' });
    const r = await renderForDelivery(t, { tenantName: 'Example Ltd' }, { fallbackTitle: 'Subscription renewed' });
    expect(r.fallbackUsed).toBe(true);
    expect(r.subject).toBe('Subscription renewed');
    expect(r.body).toContain('Example Ltd');
    expect(r.fallbackReason).toBeTruthy();
  });

  it('never leaves un-substituted handlebars in the fallback subject', async () => {
    const t = tpl({ subjectTemplate: 'Renewed for {{tenantName}}', bodyTemplate: '{{#if a}}unclosed' });
    const r = await renderForDelivery(t, { tenantName: 'Example Ltd' }, { fallbackTitle: 'Subscription renewed' });
    expect(r.subject).not.toContain('{{');
  });

  it('still reports degraded vars when it also fell back', async () => {
    const t = tpl({ bodyTemplate: '{{missingOne}} {{#if other}}unclosed' });
    const r = await renderForDelivery(t, {}, { fallbackTitle: 'X' });
    expect(r.fallbackUsed).toBe(true);
    expect(r.degradedVars).toContain('missingOne');
  });
});

describe('buildEnvelopeFallback', () => {
  it('orders the envelope fields who → what → when → action', () => {
    const body = buildEnvelopeFallback(
      { occurredAt: '2026-09-14', tenantName: 'Example Ltd', objectLabel: 'user@example.test', value: '90%' },
      'Mailbox nearly full',
    );
    const lines = body.split('\n').filter(Boolean);
    expect(lines[0]).toBe('Mailbox nearly full');
    expect(lines.findIndex((l) => l.startsWith('Tenant Name')))
      .toBeLessThan(lines.findIndex((l) => l.startsWith('Occurred At')));
  });

  it('keeps facts outside the envelope rather than dropping them', () => {
    const body = buildEnvelopeFallback({ somethingCustom: 'kept' }, 'T');
    expect(body).toContain('Something Custom: kept');
  });

  it('omits placeholder values — a fallback full of dashes helps nobody', () => {
    const body = buildEnvelopeFallback({ tenantName: MISSING_VALUE, value: '90%' }, 'T');
    expect(body).not.toContain('Tenant Name');
    expect(body).toContain('Value: 90%');
  });

  it('degrades to the bare title when there is nothing to say', () => {
    expect(buildEnvelopeFallback({}, 'Just the title')).toBe('Just the title');
  });
});
