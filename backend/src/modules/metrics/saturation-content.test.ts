/**
 * What the saturation messages actually SAY, rendered through the real seed
 * templates with the real payloads the evaluator builds.
 *
 * The renderer compiles in Handlebars STRICT mode, which throws on an ABSENT
 * key — and a throw here is a silently dropped delivery, not a visible error.
 * A new template that references a variable the evaluator does not pass is
 * therefore invisible until an operator notices an alert that never arrived.
 * These render every (category × channel) for the episode lifecycle against a
 * payload assembled exactly the way tenant-saturation.ts assembles it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ALL_SEED_TEMPLATES } from '../notifications/templates/seed-data.js';
import { PREVIEW_ENVELOPE_SAMPLE } from '../notifications/templates/variables.js';
import { renderTemplate, _resetRendererCacheForTests } from '../notifications/templates/renderer.js';
import type { NotificationTemplateResponse } from '@insula/api-contracts';
import { durationText } from './saturation-policy.js';

const CHANNELS = ['email', 'in_app', 'ntfy'] as const;

function seed(categoryId: string, channel: string): NotificationTemplateResponse {
  const t = ALL_SEED_TEMPLATES.find((x) => x.categoryId === categoryId && x.channel === channel);
  if (!t) throw new Error(`no seed template for ${categoryId}/${channel}`);
  return { ...t, id: `${categoryId}/${channel}`, version: 1 } as NotificationTemplateResponse;
}

// Exactly the shape tenant-saturation.ts passes: `common` (+ tenantLabel for
// the admin copies, + durationText for the recovered ones).
const common = {
  resource: 'storage',
  usedPct: '94',
  used: '93.95',
  limit: '100',
  unit: ' GiB',
  occurredAt: '2026-09-21 16:49 UTC',
};
const lasted = durationText(Date.parse('2026-09-21T12:00:00Z'), Date.parse('2026-09-21T18:00:00Z'));

const CASES: ReadonlyArray<{ category: string; vars: Record<string, string> }> = [
  { category: 'tenant.resource_saturation_warning', vars: { ...common } },
  { category: 'tenant.resource_saturation_critical', vars: { ...common } },
  { category: 'tenant.resource_saturation_recovered', vars: { ...common, durationText: lasted } },
  { category: 'admin.tenant_resource_saturation_warning', vars: { tenantLabel: 'Acme Ltd', ...common } },
  { category: 'admin.tenant_resource_saturation_critical', vars: { tenantLabel: 'Acme Ltd', ...common } },
  { category: 'admin.tenant_resource_saturation_recovered', vars: { tenantLabel: 'Acme Ltd', ...common, durationText: lasted } },
];

function asRead(s: string): string {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

beforeEach(() => _resetRendererCacheForTests());

describe('saturation notification content', () => {
  for (const { category, vars } of CASES) {
    for (const channel of CHANNELS) {
      it(`${category} / ${channel} renders without a strict-mode throw`, async () => {
        const out = await renderTemplate(seed(category, channel), {
          ...PREVIEW_ENVELOPE_SAMPLE,
          ...vars,
        });
        expect(out.subject.length).toBeGreaterThan(0);
        expect(out.body.length).toBeGreaterThan(0);
        // A template that lost its variables renders the literal braces.
        expect(out.subject).not.toContain('{{');
        expect(asRead(out.body)).not.toContain('{{');
      });
    }
  }

  it('the all-clear says how long it ran and what the number is now', async () => {
    const out = await renderTemplate(
      seed('admin.tenant_resource_saturation_recovered', 'email'),
      { ...PREVIEW_ENVELOPE_SAMPLE, tenantLabel: 'Acme Ltd', ...common, durationText: lasted },
    );
    const body = asRead(out.body);
    expect(out.subject).toContain('Acme Ltd');
    expect(body).toContain('6 hours');
    expect(body).toContain('93.95');
    expect(body).toContain('No action required');
  });

  it('the tenant all-clear addresses the tenant, not the operator', async () => {
    const out = await renderTemplate(
      seed('tenant.resource_saturation_recovered', 'email'),
      { ...PREVIEW_ENVELOPE_SAMPLE, ...common, durationText: lasted },
    );
    expect(asRead(out.body)).toContain('Nothing further is needed');
  });

  it('renders a resolve caused by the LIMIT being removed, not usage dropping', async () => {
    // tenant-saturation.ts substitutes 'unlimited' + an empty unit here; a
    // template that assumed a number would print "of its 0 GiB limit".
    const out = await renderTemplate(
      seed('admin.tenant_resource_saturation_recovered', 'email'),
      { ...PREVIEW_ENVELOPE_SAMPLE, tenantLabel: 'Acme Ltd', ...common, limit: 'unlimited', unit: '', durationText: lasted },
    );
    const body = asRead(out.body);
    expect(body).toContain('unlimited');
    expect(body).not.toContain('0 GiB');
  });
});
