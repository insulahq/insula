import { describe, expect, it } from 'vitest';
import type { WafRuleExclusion } from '@insula/api-contracts';
import {
  DYNAMIC_RULE_ID_BASE,
  DYNAMIC_RULE_ID_MAX,
  WAF_IP_BYPASS_MAX_ENTRIES,
  isRenderableIpValue,
  renderExclusions,
  renderIpBypass,
  renderOneExclusion,
  renderTrustedIps,
  TRUSTED_IP_RULE_ID_BASE,
} from './renderer.js';

const baseExclusion: WafRuleExclusion = {
  id: '00000000-0000-0000-0000-000000000001',
  ruleId: '930120',
  hostnameRegex: '^admin\\.example\\.com$',
  scope: 'args_names_only',
  reason: 'JSON field name false-positive on secretsRestoredCount',
  createdBy: 'admin@example.com',
  createdAt: '2026-05-20T10:00:00.000Z',
  updatedAt: '2026-05-20T10:00:00.000Z',
  disabled: false,
};

describe('renderOneExclusion', () => {
  it('emits args_names_only ctl for the standard scope', () => {
    const out = renderOneExclusion(baseExclusion, 0);
    expect(out).toContain('REQUEST_HEADERS:X-Forwarded-Host');
    expect(out).toContain('@rx ^admin\\.example\\.com$');
    expect(out).toContain('ctl:ruleRemoveTargetById=930120;ARGS_NAMES');
    expect(out).toContain(`id:${DYNAMIC_RULE_ID_BASE},`);
    expect(out).not.toContain('ruleRemoveById=930120"'); // not the full-disable form
  });

  it('emits full_disable ctl when scope is full_disable', () => {
    const out = renderOneExclusion({ ...baseExclusion, scope: 'full_disable' }, 5);
    expect(out).toContain('ctl:ruleRemoveById=930120');
    expect(out).toContain(`id:${DYNAMIC_RULE_ID_BASE + 5},`);
    expect(out).not.toContain('ARGS_NAMES');
  });

  it('strips CR/LF from reason in the comment line', () => {
    const out = renderOneExclusion(
      { ...baseExclusion, reason: 'multi\nline\rreason\n' },
      0,
    );
    expect(out).not.toMatch(/^.*reason\n.*$/m);
    expect(out).toContain('multi line reason');
  });

  it('strips quotes from createdBy in the comment line', () => {
    const out = renderOneExclusion(
      { ...baseExclusion, createdBy: 'attacker"\nname' },
      0,
    );
    // The `[\r\n"]+` collapse means consecutive matching chars become one `_`.
    expect(out).toContain('by attacker_name');
  });

  it('truncates reason to 256 chars in the comment', () => {
    const out = renderOneExclusion(
      { ...baseExclusion, reason: 'a'.repeat(500) },
      0,
    );
    const commentLine = out.split('\n').find((l) => l.startsWith('# rule'));
    expect(commentLine?.length).toBeLessThanOrEqual(512);
  });

  it('hostnameRegex with double-quote is refused at render time (CRITICAL — would escape @rx string)', () => {
    expect(() => renderOneExclusion(
      { ...baseExclusion, hostnameRegex: '^evil".*' },
      0,
    )).toThrow(/unsafe hostnameRegex characters/);
  });

  it('hostnameRegex with trailing backslash is refused at render time (CRITICAL — would CrashLoopBackOff modsec-crs)', () => {
    expect(() => renderOneExclusion(
      { ...baseExclusion, hostnameRegex: 'api\\.example\\.com\\' },
      0,
    )).toThrow(/trailing backslash/);
  });

  it('legitimate escaped-dot regex renders cleanly (helper-generated form)', () => {
    // buildHostnameRegexFromEventHost produces strings like
    // `^admin\.example\.com$` — backslash escapes for `.` are allowed.
    const out = renderOneExclusion(
      { ...baseExclusion, hostnameRegex: '^admin\\.example\\.com$' },
      0,
    );
    expect(out).toContain('@rx ^admin\\.example\\.com$');
  });

  it('uses sequential rule IDs starting at DYNAMIC_RULE_ID_BASE', () => {
    expect(renderOneExclusion(baseExclusion, 0)).toContain(`id:${DYNAMIC_RULE_ID_BASE},`);
    expect(renderOneExclusion(baseExclusion, 1)).toContain(`id:${DYNAMIC_RULE_ID_BASE + 1},`);
    expect(renderOneExclusion(baseExclusion, 999)).toContain(`id:${DYNAMIC_RULE_ID_MAX},`);
  });
});

describe('renderOneExclusion — path scope and text_plain_as_json', () => {
  const AJAX = '^/lib/ajax/service\\.php$';

  it('a host-wide row renders exactly as before (one SecRule, no chain)', () => {
    const out = renderOneExclusion({ ...baseExclusion, scope: 'args', pathRegex: null }, 0);
    expect(out).not.toContain('chain');
    expect(out).not.toContain('REQUEST_FILENAME');
    expect(out).toContain('ctl:ruleRemoveTargetById=930120;ARGS,     ctl:ruleRemoveTargetById=930120;ARGS_NAMES"');
  });

  it('a path chains REQUEST_FILENAME and puts the ctl on the last link', () => {
    const out = renderOneExclusion({ ...baseExclusion, scope: 'full_disable', pathRegex: AJAX }, 3);
    const lines = out.split('\n');
    expect(lines[0]).toContain(`path ${AJAX}`);
    expect(out).toContain(`id:${DYNAMIC_RULE_ID_BASE + 3},`);
    expect(out).toMatch(/nolog,\\\n\s+chain"\n/);
    expect(out).toContain(`    SecRule REQUEST_FILENAME "@rx ${AJAX}" \\`);
    expect(lines.at(-1)).toBe('         ctl:ruleRemoveById=930120"');
    // The starter carries no ctl: it would run before the path was checked.
    expect(out.slice(0, out.indexOf('REQUEST_FILENAME'))).not.toContain('ctl:');
  });

  it('text_plain_as_json removes 920420 only for text/plain and parses the body as JSON', () => {
    const out = renderOneExclusion({ ...baseExclusion, ruleId: '920420', scope: 'text_plain_as_json', pathRegex: AJAX }, 0);
    expect(out).toContain(`SecRule REQUEST_FILENAME "@rx ${AJAX}" \\\n        "t:none,\\\n         chain"`);
    expect(out).toContain('SecRule REQUEST_HEADERS:Content-Type "@rx ^text/plain(?:[\\s;]|$)"');
    expect(out).toContain('t:lowercase');
    expect(out.trimEnd().endsWith('ctl:ruleRemoveById=920420,\\\n         ctl:requestBodyProcessor=JSON"')).toBe(true);
  });

  it('text_plain_as_json without a path still checks the Content-Type', () => {
    const out = renderOneExclusion({ ...baseExclusion, ruleId: '920420', scope: 'text_plain_as_json' }, 0);
    expect(out).not.toContain('REQUEST_FILENAME');
    expect(out).toContain('REQUEST_HEADERS:Content-Type');
    expect(out).toContain('ctl:requestBodyProcessor=JSON"');
  });

  it.each([
    ['a double-quote', '^/a".*', /unsafe pathRegex/],
    ['a newline', '^/a\nSecRuleEngine Off', /unsafe pathRegex/],
    ['a trailing backslash', '^/a\\', /trailing backslash in pathRegex/],
  ])('refuses a pathRegex with %s', (_label, pathRegex, message) => {
    expect(() => renderOneExclusion({ ...baseExclusion, pathRegex }, 0)).toThrow(message);
  });

  it('refuses a pathRegex PCRE would not compile (it would fail the WAF config load)', () => {
    expect(() => renderOneExclusion({ ...baseExclusion, pathRegex: '^/x\\q' }, 0)).toThrow(/not portable to PCRE/);
    expect(() => renderOneExclusion({ ...baseExclusion, pathRegex: '^/x[\\d-z]' }, 0)).toThrow(/not portable to PCRE/);
  });

  it('rows without a path render byte-for-byte as before path scoping existed', () => {
    // The sha256 of the file the renderer on development produced for these
    // three rows before this change. The reconciler rolls the WAF on any byte
    // change, so a reformat here would restart it on every installation's upgrade.
    const rows = (['args', 'args_names_only', 'full_disable'] as const).map((scope, i) => ({
      ...baseExclusion, id: `00000000-0000-4000-8000-00000000000${i}`, ruleId: String(941100 + i),
      hostnameRegex: '^moodle\\.example\\.test$', scope, reason: 'golden', createdBy: 'u', pathRegex: null,
    }));
    expect(renderExclusions(rows).hash).toBe('703e1a882ed6f004a59863a98ae6626db2cc25e6e4e90916c1e68e14051fbcc4');
  });

  it('every SecRule in a mixed file terminates: no rule ends with a dangling chain', () => {
    const { body } = renderExclusions([
      { ...baseExclusion, pathRegex: AJAX },
      { ...baseExclusion, id: '00000000-0000-0000-0000-000000000002', ruleId: '920420', scope: 'text_plain_as_json', pathRegex: AJAX },
    ]);
    // Each "chain" action must be followed by exactly one more SecRule before the next blank line.
    for (const block of body.split('\n\n').filter((b) => b.includes('SecRule'))) {
      const rules = (block.match(/^\s*SecRule /gm) ?? []).length;
      const chains = (block.match(/chain"/g) ?? []).length;
      expect(rules, block).toBe(chains + 1);
    }
  });
});

describe('renderExclusions', () => {
  it('returns the empty-body banner for zero exclusions', () => {
    const result = renderExclusions([]);
    expect(result.count).toBe(0);
    expect(result.body).toContain('No DB-rendered exclusions are currently enabled.');
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders multiple exclusions with sequential rule IDs', () => {
    const a = baseExclusion;
    const b: WafRuleExclusion = { ...baseExclusion, id: '00000000-0000-0000-0000-000000000002', ruleId: '931100' };
    const result = renderExclusions([a, b]);

    expect(result.count).toBe(2);
    expect(result.body).toContain(`id:${DYNAMIC_RULE_ID_BASE},`);
    expect(result.body).toContain(`id:${DYNAMIC_RULE_ID_BASE + 1},`);
    expect(result.body).toContain('930120');
    expect(result.body).toContain('931100');
  });

  it('hash changes when content changes', () => {
    const a = renderExclusions([baseExclusion]);
    const b = renderExclusions([{ ...baseExclusion, ruleId: '931100' }]);
    expect(a.hash).not.toBe(b.hash);
  });

  it('hash is stable for identical input', () => {
    const a = renderExclusions([baseExclusion]);
    const b = renderExclusions([baseExclusion]);
    expect(a.hash).toBe(b.hash);
  });

  it('hash differs from the empty body', () => {
    const a = renderExclusions([]);
    const b = renderExclusions([baseExclusion]);
    expect(a.hash).not.toBe(b.hash);
  });

  it('throws when input exceeds the reserved rule-ID range', () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({
      ...baseExclusion,
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    }));
    expect(() => renderExclusions(tooMany)).toThrow(/exceeds reserved rule-ID range/);
  });

  it('every rendered SecRule uses X-Forwarded-Host (never Host)', () => {
    const result = renderExclusions([
      baseExclusion,
      { ...baseExclusion, id: '00000000-0000-0000-0000-000000000002', ruleId: '931100' },
    ]);
    expect(result.body).toContain('REQUEST_HEADERS:X-Forwarded-Host');
    // The literal regex `REQUEST_HEADERS:Host"` (followed by a quote = end of header name)
    // would indicate the bug yesterday's CI guard catches. Make sure we never emit it.
    expect(result.body).not.toMatch(/REQUEST_HEADERS:Host[^a-zA-Z-]/);
  });
});

describe('operator IP bypass (never blocked, still logged)', () => {
  it('uses DetectionOnly so allowlisted sources stay visible in WAF Events', () => {
    const out = renderIpBypass(['192.0.2.10'])!;
    expect(out).toContain('ctl:ruleEngine=DetectionOnly');
    // `Off` would stop the rules evaluating at all, so the operator would lose
    // the record that an allowlisted host tripped anything.
    expect(out).not.toContain('ruleEngine=Off');
  });

  it('matches X-Real-Ip, never REMOTE_ADDR', () => {
    const out = renderIpBypass(['192.0.2.10'])!;
    expect(out).toContain('REQUEST_HEADERS:X-Real-Ip');
    // REMOTE_ADDR is the Traefik pod IP behind the plugin — allowlisting that
    // would un-block every request arriving from the internet.
    expect(out).not.toContain('REMOTE_ADDR');
  });

  it('emits a single @ipMatch rule for the whole list', () => {
    const out = renderIpBypass(['192.0.2.10', '198.51.100.0/24', '2001:db8::1'])!;
    expect(out).toContain('@ipMatch 192.0.2.10,198.51.100.0/24,2001:db8::1');
    expect(out.match(/SecRule/g)).toHaveLength(1);
  });

  it('returns null when nothing is allowlisted so the body stays the seed', () => {
    expect(renderIpBypass([])).toBeNull();
    expect(renderExclusions([], []).body).toBe(renderExclusions([]).body);
  });

  // Values arrive from CrowdSec's store via cscli — outside this process — and
  // are interpolated into a SecRule. A value that escaped the @ipMatch argument
  // would turn the rest of the line into rule text.
  it('refuses anything that is not a literal address or CIDR', () => {
    const hostile = [
      '1.2.3.4" \\\n    SecRule REQUEST_URI "@rx .*" "id:1,phase:1,allow"',
      '1.2.3.4,5.6.7.8',
      '1.2.3.4 ',
      'evil.example.test',
      '1.2.3.4/33',
      '1.2.3.4/x',
      '10.0.0.0/8/16',
      '',
      '::1/129',
    ];
    for (const v of hostile) expect(isRenderableIpValue(v)).toBe(false);
    expect(renderIpBypass(hostile)).toBeNull();
  });

  it('accepts the forms an operator actually uses', () => {
    for (const v of ['192.0.2.10', '192.0.2.0/24', '2001:db8::1', '2001:db8::/32', '::1/128']) {
      expect(isRenderableIpValue(v)).toBe(true);
    }
  });

  it('drops hostile entries while keeping the valid ones', () => {
    const out = renderIpBypass(['192.0.2.10', 'evil.example.test', '198.51.100.5'])!;
    expect(out).toContain('@ipMatch 192.0.2.10,198.51.100.5');
    expect(out).not.toContain('evil.example.test');
  });

  it('de-duplicates and caps the list', () => {
    expect(renderIpBypass(['192.0.2.10', '192.0.2.10'])).toContain('@ipMatch 192.0.2.10"');
    const many = Array.from({ length: WAF_IP_BYPASS_MAX_ENTRIES + 50 },
      (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`);
    // Assert on the @ipMatch argument only — the SecRule's action list is
    // comma-separated too, so splitting the whole rule over-counts.
    const arg = /@ipMatch ([^"]+)"/.exec(renderIpBypass(many)!)![1];
    expect(arg.split(',')).toHaveLength(WAF_IP_BYPASS_MAX_ENTRIES);
  });

  it('is emitted before the per-rule exclusions', () => {
    const body = renderExclusions([{ ...baseExclusion, ruleId: '931100' }], ['192.0.2.10']).body;
    expect(body.indexOf('DetectionOnly')).toBeLessThan(body.indexOf('931100'));
  });
});

describe('scope all_rules (no rule id, one path, the WAF does not check it)', () => {
  const MCP = '^/mcp$';
  const allRules = { ...baseExclusion, ruleId: '0', scope: 'all_rules' as const, pathRegex: MCP };

  it('switches the rule engine off for the path, chained behind the host', () => {
    const out = renderOneExclusion(allRules, 2);
    const lines = out.split('\n');
    expect(lines[0]).toBe(`# all rules for ^admin\\.example\\.com$ path ${MCP} — ${baseExclusion.reason} (by ${baseExclusion.createdBy})`);
    expect(out).toContain('SecRule REQUEST_HEADERS:X-Forwarded-Host "@rx ^admin\\.example\\.com$" \\');
    expect(out).toContain(`    SecRule REQUEST_FILENAME "@rx ${MCP}" \\`);
    expect(lines.at(-1)).toBe('         ctl:ruleEngine=Off"');
    expect(out).not.toContain('ruleRemove');
    expect(out.slice(0, out.indexOf('REQUEST_FILENAME'))).not.toContain('ctl:');
  });

  it('refuses to render one without a path (it would switch the WAF off for the host)', () => {
    expect(() => renderOneExclusion({ ...allRules, pathRegex: null }, 0)).toThrow(/no path/);
  });
});

describe('route trusted IPs (inspected and logged, never blocked, on one hostname)', () => {
  const group = { routeId: '11111111-1111-4111-8111-111111111111', hostname: 'shop.example.test', values: ['203.0.113.7', '2001:db8:1::/48'] };

  it('chains the source match behind the route hostname and sets DetectionOnly', () => {
    const out = renderTrustedIps([group])!;
    expect(out).toBe([
      '# Trusted IPs of route 11111111-1111-4111-8111-111111111111 (shop.example.test): inspected and logged, never blocked',
      'SecRule REQUEST_HEADERS:X-Forwarded-Host "@rx ^shop\\.example\\.test$" \\',
      `    "id:${TRUSTED_IP_RULE_ID_BASE},\\`,
      '     phase:1,\\',
      '     pass,\\',
      '     nolog,\\',
      '     chain"',
      '    SecRule REQUEST_HEADERS:X-Real-Ip "@ipMatch 203.0.113.7,2001:db8:1::/48" \\',
      '        "t:none,\\',
      '         ctl:ruleEngine=DetectionOnly"',
    ].join('\n'));
  });

  it('skips a wildcard route: no host regex covers only what it serves', () => {
    expect(renderTrustedIps([{ ...group, hostname: '*.sites.example.test' }])).toBeNull();
  });

  it('one rule id per route, in their own range', () => {
    const out = renderTrustedIps([group, { ...group, routeId: '2', hostname: 'blog.example.test' }])!;
    expect(out).toContain(`id:${TRUSTED_IP_RULE_ID_BASE},`);
    expect(out).toContain(`id:${TRUSTED_IP_RULE_ID_BASE + 1},`);
  });

  it('drops values that are not literal addresses, and a group left with none', () => {
    expect(renderTrustedIps([{ ...group, values: ['203.0.113.7" ,phase:2', 'x'] }])).toBeNull();
    const out = renderTrustedIps([{ ...group, values: ['bad value', '203.0.113.7'] }])!;
    expect(out).toContain('@ipMatch 203.0.113.7"');
  });

  it('nothing to render leaves the file byte-identical (no WAF roll on upgrade)', () => {
    expect(renderExclusions([], [], []).body).toBe(renderExclusions([]).body);
    expect(renderExclusions([], ['192.0.2.10'], []).body).toBe(renderExclusions([], ['192.0.2.10']).body);
    const rows = [{ ...baseExclusion, ruleId: '931100' }];
    expect(renderExclusions(rows, ['192.0.2.10'], []).body).toBe(renderExclusions(rows, ['192.0.2.10']).body);
  });

  it('comes after the platform bypass and before the exclusions, so an all_rules path wins', () => {
    const body = renderExclusions(
      [{ ...baseExclusion, ruleId: '0', scope: 'all_rules', pathRegex: '^/mcp$' }],
      ['192.0.2.10'],
      [group],
    ).body;
    const bypass = body.indexOf('Operator IP bypass');
    const trusted = body.indexOf('Trusted IPs of route');
    const off = body.indexOf('ctl:ruleEngine=Off');
    expect(bypass).toBeGreaterThan(-1);
    expect(bypass).toBeLessThan(trusted);
    expect(trusted).toBeLessThan(off);
  });

  it('every SecRule in a file with all three terminates (no dangling chain or continuation)', () => {
    const body = renderExclusions(
      [{ ...baseExclusion, ruleId: '0', scope: 'all_rules', pathRegex: '^/mcp$' }],
      ['192.0.2.10'],
      [group],
    ).body;
    const lines = body.split('\n');
    lines.forEach((line, i) => {
      if (line.endsWith('\\')) expect(lines[i + 1]?.trim().length).toBeGreaterThan(0);
    });
    expect(body.match(/chain"/g)?.length).toBe((body.match(/^ {4}SecRule /gm) ?? []).length);
  });
});
