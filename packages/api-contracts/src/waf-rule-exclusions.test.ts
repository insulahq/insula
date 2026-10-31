import { describe, expect, it } from 'vitest';
import {
  buildPathRegexFromEventUri,
  isPortablePathRegex,
  createTenantWafRuleExclusionRequestSchema,
  createWafRuleExclusionRequestSchema,
  updateWafRuleExclusionRequestSchema,
  wafRuleExclusionPathRegexSchema,
} from './waf-rule-exclusions.js';

describe('wafRuleExclusionPathRegexSchema', () => {
  it.each(['^/lib/ajax/service\\.php$', '^/', '^/mod/(forum|assign)/'])('accepts %s', (v) => {
    expect(wafRuleExclusionPathRegexSchema.safeParse(v).success).toBe(true);
  });

  it.each([
    ['unanchored', '/lib/ajax/service.php'],
    ['anchored without a slash', '^lib/'],
    ['a double-quote', '^/a"b'],
    ['a newline', '^/a\nb'],
    ['a trailing backslash', '^/a\\'],
    ['an unbalanced group', '^/(a'],
    ['too long', `^/${'a'.repeat(254)}`],
  ])('refuses %s', (_label, v) => {
    expect(wafRuleExclusionPathRegexSchema.safeParse(v).success).toBe(false);
  });
});

// Measured on the CRS 4.30 image (libmodsecurity 3.0.17 + PCRE): every pattern
// in ACCEPTED compiles there, and every pattern in BREAKS_THE_WAF compiles in
// JavaScript but fails the WAF's config load — the outage this check prevents.
describe('isPortablePathRegex — only what PCRE compiles too', () => {
  const BS = String.fromCharCode(92);
  const ACCEPTED = [
    '^/lib/ajax/service\\.php$', '^/mod/(forum|assign)/', '^/mod/(?:forum|assign)/view\\.php$',
    '^/[0-9]{1,6}/x$', '^/[0-9]{2}/x$', '^/[0-9]{2,}/x$', '^/a\\d+\\w*\\s?\\b\\B\\D\\W\\S', '^/[.]x$',
    '^/[a-z_.~-]+$', '^/[^/]+\\.php$', '^/[\\-\\]\\[\\\\]x', '^/x\\/y\\-z\\.\\*\\+\\?\\(\\)\\{\\}\\|\\$\\^',
    '^/r\\.php/api/rest/v2/.*', '^/a|^/b', '^/(a(b(c)))+$',
  ];
  const BREAKS_THE_WAF = ['^/x[\\d-z]', '^/x(?<=a+)', '^/x\\q', '^/x\\1', '^/x\\k<n>', '^/x[:alpha:]', '^/x[=a=]'];
  // Compile in PCRE but are refused anyway: rare, or they mean something else in JS.
  const REFUSED_TOO = [
    '^/x(?<n>a)', '^/x[[:alpha:]]', '^/x[]a]', '^/x[^]a]', '^/x{,3}', '^/x}', '^/x{a}', '^/x\\p{L}',
    '^/x\\x41', '^/x\\cA', '^/x\\0', '^/x(?=a)', '^/x(?!a)', '^/x[\\b]', `^/x${BS}u0041`,
  ];

  it.each(ACCEPTED)('accepts %s', (v) => {
    expect(isPortablePathRegex(v)).toBe(true);
    expect(wafRuleExclusionPathRegexSchema.safeParse(v).success).toBe(true);
  });

  it.each([...BREAKS_THE_WAF, ...REFUSED_TOO])('refuses %s although JavaScript compiles it', (v) => {
    expect(() => new RegExp(v)).not.toThrow();
    expect(isPortablePathRegex(v)).toBe(false);
    expect(wafRuleExclusionPathRegexSchema.safeParse(v).success).toBe(false);
  });

  it('refuses a regex ending in an escaped backslash (the DB CHECK would, with a 500)', () => {
    const v = `^/a${BS}${BS}`;
    expect(() => new RegExp(v)).not.toThrow();
    expect(wafRuleExclusionPathRegexSchema.safeParse(v).error?.issues[0]?.message).toMatch(/must not end with a backslash/);
  });
});

describe('create / update requests', () => {
  const tenant = { ruleId: '920420', scope: 'text_plain_as_json', reason: 'H5P beacons' } as const;

  it('takes an optional or null pathRegex', () => {
    expect(createTenantWafRuleExclusionRequestSchema.safeParse(tenant).success).toBe(true);
    expect(createTenantWafRuleExclusionRequestSchema.safeParse({ ...tenant, pathRegex: null }).success).toBe(true);
    expect(createTenantWafRuleExclusionRequestSchema.safeParse({ ...tenant, pathRegex: '^/x$' }).success).toBe(true);
    expect(createTenantWafRuleExclusionRequestSchema.safeParse({ ...tenant, pathRegex: 'x' }).success).toBe(false);
  });

  it('refuses text_plain_as_json on any rule but 920420', () => {
    const r = createTenantWafRuleExclusionRequestSchema.safeParse({ ...tenant, ruleId: '941100' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['scope']);
    expect(createWafRuleExclusionRequestSchema.safeParse({
      ...tenant, ruleId: '941100', hostnameRegex: '^h$',
    }).success).toBe(false);
  });

  it('an update can clear the path with null', () => {
    expect(updateWafRuleExclusionRequestSchema.parse({ pathRegex: null })).toEqual({ pathRegex: null });
  });
});

describe('buildPathRegexFromEventUri', () => {
  it('drops the query string and fragment, escapes and anchors', () => {
    expect(buildPathRegexFromEventUri('/lib/ajax/service.php?sesskey=abc&info=x')).toBe('^/lib/ajax/service\\.php$');
    expect(buildPathRegexFromEventUri('/r.php/api/rest/v2/x#frag')).toBe('^/r\\.php/api/rest/v2/x$');
  });

  it('returns a regex that matches exactly that path', () => {
    const re = new RegExp(buildPathRegexFromEventUri('/mod/quiz/processattempt.php?cmid=1')!);
    expect(re.test('/mod/quiz/processattempt.php')).toBe(true);
    expect(re.test('/mod/quiz/processattemptXphp')).toBe(false);
    expect(re.test('/mod/quiz/processattempt.php/x')).toBe(false);
  });

  it.each([null, undefined, '', 'relative/path', '/a"b', `/${'a'.repeat(300)}`])('gives null for %j', (v) => {
    expect(buildPathRegexFromEventUri(v)).toBeNull();
  });
});
