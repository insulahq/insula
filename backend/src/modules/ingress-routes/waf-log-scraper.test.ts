import { describe, it, expect } from 'vitest';
import { parseContributingRules } from './waf-log-scraper.js';

/**
 * Shape copied from a real modsec-crs audit record, with every identifier
 * redacted. The original also carried the caller's Authorization bearer
 * token and session cookies in `request.headers` — see the note in
 * k8s/base/modsecurity-crs/exclusion-rules-configmap.yaml. Never paste a
 * raw audit record into a fixture.
 */
const auditRecord = JSON.stringify({
  transaction: {
    client_ip: '192.0.2.50',
    unique_id: '178579623278.134968',
    request: {
      method: 'POST',
      uri: '/api/v1/admin/dns-servers',
      headers: { 'X-Forwarded-Host': 'admin.example.test' },
    },
    response: { http_code: 403 },
    messages: [
      {
        message: 'Possible Remote File Inclusion (RFI) Attack: URL Parameter using IP Address',
        details: {
          match: 'Matched "Operator `Rx\' with parameter ... against variable `ARGS:json.connection_config.api_url\'',
          ruleId: '931100',
          file: '/etc/modsecurity.d/owasp-crs/rules/REQUEST-931-APPLICATION-ATTACK-RFI.conf',
          severity: '2',
        },
      },
      {
        message: 'Inbound Anomaly Score Exceeded (Total Score: 5)',
        details: {
          match: 'Matched "Operator `Ge\' with parameter `5\'',
          ruleId: '949110',
          file: '/etc/modsecurity.d/owasp-crs/rules/REQUEST-949-BLOCKING-EVALUATION.conf',
          severity: '0',
        },
      },
    ],
  },
});

describe('parseContributingRules', () => {
  // The whole point: at PL1 the rule that MATCHED acts with `pass` and never
  // reaches an [error] line, so before this the operator only ever saw 949110
  // — the rule that denies, which cannot be whitelisted into a fix.
  it('surfaces the rule that actually matched, not just the one that denied', () => {
    const rules = parseContributingRules(auditRecord);
    expect(rules.map((r) => r.ruleId)).toEqual(['931100']);
    expect(rules[0].message).toContain('Remote File Inclusion');
  });

  it('never returns the anomaly-scoring meta-rules', () => {
    const ids = parseContributingRules(auditRecord).map((r) => r.ruleId);
    // 949110 is the block itself (already recorded from the [error] line);
    // whitelisting it at full_disable would disable blocking for the host.
    expect(ids).not.toContain('949110');
    expect(ids.some((id) => id.startsWith('980'))).toBe(false);
  });

  it('maps CRS severity onto the scraper severity bands', () => {
    // severity 2 → critical (matches parseModSecurityLine's <=2 rule)
    expect(parseContributingRules(auditRecord)[0].severity).toBe('critical');
  });

  it('de-duplicates a rule that matched several arguments', () => {
    const twice = auditRecord.replace(
      '"messages":[',
      '"messages":[{"message":"Possible Remote File Inclusion (RFI) Attack: URL Parameter using IP Address","details":{"ruleId":"931100","severity":"2"}},',
    );
    expect(parseContributingRules(twice).filter((r) => r.ruleId === '931100')).toHaveLength(1);
  });

  it('ignores lines that are not audit records', () => {
    expect(parseContributingRules('2026/08/03 [error] ModSecurity: Access denied [id "949110"]')).toEqual([]);
    expect(parseContributingRules('')).toEqual([]);
    expect(parseContributingRules('{"transaction":{"unique_id":"x"}}')).toEqual([]);
  });

  it('survives a record with no message next to the rule id', () => {
    const rules = parseContributingRules('{"messages":[{"details":{"ruleId":"942100","severity":"5"}}]}');
    expect(rules).toHaveLength(1);
    expect(rules[0].ruleId).toBe('942100');
    expect(rules[0].message).toBeTruthy();
    expect(rules[0].severity).toBe('info');
  });
});
