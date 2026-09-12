/**
 * What an SLO alert actually SAYS, rendered through the real seed templates.
 *
 * The monitoring tests assert that a rule fires; the notification tests assert
 * that a template renders. Neither asserted what the operator ends up reading,
 * which is how two documented behaviours stayed unimplemented:
 *
 *   - `subject` (WHICH certificate / host / node) was passed by the evaluator,
 *     documented in three places as the fix for "the alert named a symptom and
 *     nothing else", and rendered by no template.
 *   - `absent()` rules printed "Current value: 1", which is not data.
 */
import { describe, it, expect } from 'vitest';
import { ALL_SEED_TEMPLATES } from '../notifications/templates/seed-data.js';
import { renderTemplate, _resetRendererCacheForTests } from '../notifications/templates/renderer.js';
import type { NotificationTemplateResponse } from '@insula/api-contracts';
import { SLO_RULES, sloValueIsInformative, formatSloValue } from './rules.js';

const CHANNELS = ['email', 'in_app', 'ntfy'] as const;
const CATEGORIES = [
  'admin.slo_alert_critical',
  'admin.slo_alert_warning',
  'admin.slo_alert_resolved',
] as const;

function seed(categoryId: string, channel: string): NotificationTemplateResponse {
  const t = ALL_SEED_TEMPLATES.find((x) => x.categoryId === categoryId && x.channel === channel);
  if (!t) throw new Error(`no seed template for ${categoryId}/${channel}`);
  // The compiled-template cache is keyed by `${id}::${version}`; seed rows have
  // neither, so every template would collide on `undefined::undefined` and the
  // first one compiled would be returned for all of them.
  return { ...t, id: `${categoryId}/${channel}`, version: 1 } as NotificationTemplateResponse;
}

/**
 * MJML bodies are HTML and are escaped on purpose (an un-escaped variable in an
 * HTML email is an injection vector), so `host=x` is stored as `host&#x3D;x`
 * and displays as `host=x` in the mail client. Decode before asserting on
 * meaning, so the assertion is about what the operator reads.
 */
function asRead(s: string): string {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

/** Exactly what evaluator.ts puts on the wire for a firing rule. */
function payloadFor(ruleId: string, rawValue: number, subject?: string) {
  const rule = SLO_RULES.find((r) => r.id === ruleId)!;
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    description: rule.description,
    value: sloValueIsInformative(rule.unit) ? formatSloValue(rawValue, rule.unit) : undefined,
    subject,
    platformName: 'Insula',
    userName: 'operator',
    tenantName: null,
  };
}

describe('SLO alert content', () => {
  it('names the affected object on every channel when the rule has one', () => {
    for (const channel of CHANNELS) {
      _resetRendererCacheForTests();
      const r = renderTemplate(
        seed('admin.slo_alert_critical', channel),
        payloadFor('ingress-router-down', 1, 'host=panel.example.test'),
        { skipMjml: true },
      );
      expect(asRead(r.subject ?? ''), `${channel} subject`).toContain('host=panel.example.test');
      expect(asRead(r.body), `${channel} body`).toContain('host=panel.example.test');
    }
  });

  it('says nothing about a subject for a genuinely cluster-wide rule', () => {
    const r = renderTemplate(
      seed('admin.slo_alert_critical', 'in_app'),
      payloadFor('crowdsec-lapi-down', 1),
      { skipMjml: true },
    );
    expect(r.body).not.toContain('Affected:');
    expect(r.subject).toBe('[SLO CRITICAL] CrowdSec LAPI is not running');
  });

  it('omits the value for presence rules instead of printing "Current value: 1"', () => {
    for (const ruleId of ['crowdsec-lapi-down', 'ingress-router-down']) {
      const r = renderTemplate(
        seed('admin.slo_alert_critical', 'in_app'),
        payloadFor(ruleId, 1, 'host=x.example.test'),
        { skipMjml: true },
      );
      expect(r.body, ruleId).not.toContain('Current value');
    }
  });

  it('still shows the value where it carries information', () => {
    const r = renderTemplate(
      seed('admin.slo_alert_warning', 'in_app'),
      payloadFor('platform-latency-slow-share', 0.062),
      { skipMjml: true },
    );
    expect(r.body).toContain('Current value: 6.20%');
  });

  it('carries the subject through the resolved leg too', () => {
    // Firing named the host; if "resolved" does not, the operator cannot tell
    // WHICH of several firing subjects recovered.
    const r = renderTemplate(
      seed('admin.slo_alert_resolved', 'in_app'),
      payloadFor('ingress-router-down', 0, 'host=panel.example.test'),
      { skipMjml: true },
    );
    expect(r.body).toContain('host=panel.example.test');
    expect(r.subject).toContain('host=panel.example.test');
  });

  it('drops the fixed "See Monitoring → SLOs" pointer', () => {
    // It pointed at a page that could not show an entrypoint-level failure,
    // and it was appended to every alert regardless of relevance.
    for (const categoryId of CATEGORIES) {
      for (const channel of CHANNELS) {
        const t = seed(categoryId, channel);
        expect(t.bodyTemplate, `${categoryId}/${channel}`).not.toContain('Monitoring →');
      }
    }
  });

  it('renders EVERY rule on EVERY channel, with and without a subject', () => {
    // Anti-vacuity: a strict-mode lookup failure in one rule's payload shape
    // would otherwise only surface when that rule happened to fire.
    let rendered = 0;
    for (const rule of SLO_RULES) {
      const categoryId = rule.severity === 'critical'
        ? 'admin.slo_alert_critical'
        : 'admin.slo_alert_warning';
      for (const channel of CHANNELS) {
        for (const subject of [undefined, 'namespace=tenant-acme certificate=wildcard-tls']) {
          for (const cat of [categoryId, 'admin.slo_alert_resolved']) {
            _resetRendererCacheForTests();
            const r = renderTemplate(
              seed(cat, channel), payloadFor(rule.id, 1, subject), { skipMjml: true },
            );
            expect(r.body.length, `${rule.id}/${cat}/${channel}`).toBeGreaterThan(0);
            rendered += 1;
          }
        }
      }
    }
    expect(rendered).toBe(SLO_RULES.length * CHANNELS.length * 2 * 2);
    expect(SLO_RULES.length).toBeGreaterThan(20);
  });
});
