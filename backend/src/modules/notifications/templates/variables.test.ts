import { describe, it, expect, beforeEach } from 'vitest';
import {
  referencedVariables,
  templateReferencedVariables,
  fillMissingVariables,
  MISSING_VALUE,
  _resetVariableCacheForTests,
} from './variables.js';
import type { NotificationTemplateResponse } from '@insula/api-contracts';

type Tpl = Pick<NotificationTemplateResponse, 'id' | 'version' | 'subjectTemplate' | 'bodyTemplate'>;

function tpl(body: string, subject: string | null = null, version = 1): Tpl {
  return { id: 't1', version, subjectTemplate: subject, bodyTemplate: body };
}

beforeEach(() => _resetVariableCacheForTests());

describe('referencedVariables', () => {
  it('finds a bare reference', () => {
    expect(referencedVariables('next={{nextBillingAt}}')).toEqual(['nextBillingAt']);
  });

  // The whole point of this module: {{#if}} is the form that fails SILENTLY,
  // so a matcher that missed it would report a clean contract for exactly the
  // template that drops data without an error.
  it('finds a block-helper subject', () => {
    expect(referencedVariables('{{#if nextBillingAt}}x{{/if}}')).toEqual(['nextBillingAt']);
  });

  it('finds an unless-block subject', () => {
    expect(referencedVariables('{{#unless verified}}x{{/unless}}')).toEqual(['verified']);
  });

  it('finds a triple-stash reference', () => {
    expect(referencedVariables('{{{rawHtml}}}')).toEqual(['rawHtml']);
  });

  it('records the ROOT of a dotted path, which is what a caller supplies', () => {
    expect(referencedVariables('{{tenant.name}}')).toEqual(['tenant']);
  });

  it('ignores closing tags and else', () => {
    expect(referencedVariables('{{#if a}}x{{else}}y{{/if}}')).toEqual(['a']);
  });

  it('deduplicates repeats', () => {
    expect(referencedVariables('{{a}} {{a}} {{a}}')).toEqual(['a']);
  });

  it('returns empty for null/empty input rather than throwing', () => {
    expect(referencedVariables(null)).toEqual([]);
    expect(referencedVariables('')).toEqual([]);
    expect(referencedVariables('no variables here')).toEqual([]);
  });
});

describe('templateReferencedVariables', () => {
  it('unions subject and body', () => {
    const refs = templateReferencedVariables(tpl('body {{b}}', 'subject {{a}}'));
    expect([...refs].sort()).toEqual(['a', 'b']);
  });

  it('re-reads when the version bumps, so an operator edit is not served stale', () => {
    const first = templateReferencedVariables(tpl('{{a}}', null, 1));
    expect(first).toEqual(['a']);
    const second = templateReferencedVariables(tpl('{{b}}', null, 2));
    expect(second).toEqual(['b']);
  });
});

describe('fillMissingVariables', () => {
  it('fills an absent reference with a visible marker and reports it', () => {
    const r = fillMissingVariables(tpl('Next: {{nextBillingAt}}'), { newExpiresAt: '2026-10-01' });
    expect(r.variables.nextBillingAt).toBe(MISSING_VALUE);
    expect(r.degradedVars).toEqual(['nextBillingAt']);
  });

  it('leaves supplied variables untouched', () => {
    const r = fillMissingVariables(tpl('{{a}}'), { a: 'real' });
    expect(r.variables.a).toBe('real');
    expect(r.degradedVars).toEqual([]);
  });

  // A caller that explicitly passed null CHOSE an empty value. Only a key the
  // emitter never mentioned is a contract defect.
  it('does not treat an explicit null as degraded', () => {
    const r = fillMissingVariables(tpl('{{a}}'), { a: null });
    expect(r.variables.a).toBeNull();
    expect(r.degradedVars).toEqual([]);
  });

  it('does not report the dispatcher-seeded common variables as degraded', () => {
    const r = fillMissingVariables(tpl('{{platformName}} {{userName}} {{tenantName}}'), {});
    expect(r.degradedVars).toEqual([]);
    expect(r.variables.platformName).toBe(MISSING_VALUE);
  });

  // The exact production defect, pinned.
  it('pins the subscription.renewed mismatch: nextBillingAt vs newExpiresAt', () => {
    const emailBody = 'Your subscription for {{tenantName}} was renewed. The next billing cycle starts on {{nextBillingAt}}.';
    const inAppBody = 'Your subscription was renewed.{{#if nextBillingAt}} Next billing: {{nextBillingAt}}.{{/if}}';
    const payload = { tenantName: 'Example Ltd', newExpiresAt: '2026-10-01T00:00:00.000Z' };

    for (const body of [emailBody, inAppBody]) {
      const r = fillMissingVariables(tpl(body), payload);
      expect(r.degradedVars).toEqual(['nextBillingAt']);
    }
  });
});
