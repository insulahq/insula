import { describe, it, expect } from 'vitest';
import { parseContributingRules, parseModSecurityLine } from './waf-log-scraper.js';

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

/**
 * A real [error] line, redacted. The `[unique_id "..."]` field is what makes a
 * rule-match identifiable across scrape cycles.
 */
const errorLine =
  '2026/09/05 17:16:11 [error] 42#42: *7 [client 10.0.0.1] ModSecurity: Access denied with code 403 ' +
  '[id "949110"] [msg "Inbound Anomaly Score Exceeded (Total Score: 15)"] [severity "0"] ' +
  '[hostname "modsec-crs.traefik.svc.cluster.local"] [unique_id "178862839854.792299"], ' +
  'client: 10.0.0.1, server: localhost, request: "GET /?q=x HTTP/1.1"';

describe('parseModSecurityLine — dedup identity', () => {
  // The scraper re-reads ~5s of every cycle on purpose (35s window, 30s
  // interval). event_key is what makes that re-read idempotent, and it is only
  // safe to set when the id came from ModSecurity itself.
  it('marks a line carrying [unique_id ...] as stable and keys it on that id', () => {
    const event = parseModSecurityLine(errorLine);
    expect(event).not.toBeNull();
    expect(event!.hasStableUid).toBe(true);
    // Same rule match must produce the same key on every re-read.
    expect(event!.uniqueId).toBe('178862839854.792299:949110');
    expect(parseModSecurityLine(errorLine)!.uniqueId).toBe(event!.uniqueId);
  });

  it('marks a line WITHOUT [unique_id ...] as unstable so it never gets a key', () => {
    const withoutUid = errorLine.replace(' [unique_id "178862839854.792299"],', ',');
    const event = parseModSecurityLine(withoutUid);
    expect(event).not.toBeNull();
    expect(event!.hasStableUid).toBe(false);
  });

  // This is the trap the flag exists to avoid. The fallback id is built from
  // Date.now(), so two reads of the SAME line produce different values. Writing
  // that to event_key would not dedupe anything — it would quietly guarantee a
  // duplicate row per re-read while looking like a working unique index.
  it('the fallback id is NOT stable across reads — hence it must not be a key', async () => {
    const withoutUid = errorLine.replace(' [unique_id "178862839854.792299"],', ',');
    const first = parseModSecurityLine(withoutUid)!;
    await new Promise((r) => setTimeout(r, 2));
    const second = parseModSecurityLine(withoutUid)!;
    expect(second.uniqueId).not.toBe(first.uniqueId);
    expect(first.hasStableUid).toBe(false);
  });
});
