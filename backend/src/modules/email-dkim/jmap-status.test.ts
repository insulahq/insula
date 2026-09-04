import { describe, it, expect } from 'vitest';
import { parseDkimSelectorsFromZoneFile, foldParenthesisedRecords } from './jmap-status.js';

describe('parseDkimSelectorsFromZoneFile', () => {
  it('returns empty when zone file has no _domainkey TXT records', () => {
    const zoneFile = `; Zone file for example.com
example.com. 3600 IN MX 10 mail.example.com.
example.com. 3600 IN TXT "v=spf1 mx -all"
`;
    const { selectors, rawLines, detectedDomain } = parseDkimSelectorsFromZoneFile(zoneFile);
    expect(selectors).toHaveLength(0);
    expect(rawLines).toHaveLength(0);
    expect(detectedDomain).toBe('example.com');
  });

  it('parses a single well-formed DKIM TXT record', () => {
    const zoneFile = `; Zone file for example.com
default._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0"
`;
    const { selectors, rawLines, detectedDomain } = parseDkimSelectorsFromZoneFile(zoneFile);
    expect(selectors).toHaveLength(1);
    expect(rawLines).toHaveLength(1);
    expect(detectedDomain).toBe('example.com');

    const sel = selectors[0];
    expect(sel.name).toBe('default._domainkey.example.com.');
    expect(sel.txtValue).toBe('v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0');
    expect(sel.publicKey).toBe('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0');
    expect(sel.valid).toBe(true);
  });

  it('parses multiple selectors', () => {
    const zoneFile = `; Zone file for example.com
default._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa; p=AAAA"
default-202501._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa; p=BBBB"
`;
    const { selectors } = parseDkimSelectorsFromZoneFile(zoneFile);
    expect(selectors).toHaveLength(2);
    expect(selectors[0].valid).toBe(true);
    expect(selectors[1].valid).toBe(true);
  });

  it('marks record invalid when p= is missing', () => {
    const zoneFile = `default._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa"
`;
    const { selectors } = parseDkimSelectorsFromZoneFile(zoneFile);
    expect(selectors).toHaveLength(1);
    expect(selectors[0].valid).toBe(false);
    expect(selectors[0].publicKey).toBeNull();
  });

  it('joins multi-chunk quoted TXT fragments', () => {
    const zoneFile = `default._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa; " "p=PART1" "PART2"
`;
    const { selectors } = parseDkimSelectorsFromZoneFile(zoneFile);
    expect(selectors).toHaveLength(1);
    expect(selectors[0].txtValue).toBe('v=DKIM1; k=rsa; p=PART1PART2');
    // p= captures from PART1 forward
    expect(selectors[0].publicKey).toBe('PART1PART2');
    expect(selectors[0].valid).toBe(true);
  });

  it('ignores non-TXT records with _domainkey in the name', () => {
    const zoneFile = `default._domainkey.example.com. 3600 IN CNAME other.example.com.
default._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa; p=CCCC"
`;
    const { selectors } = parseDkimSelectorsFromZoneFile(zoneFile);
    // CNAME line is skipped (no TXT keyword)
    expect(selectors).toHaveLength(1);
  });

  it('detects domain from _domainkey record name when no header comment', () => {
    const zoneFile = `default._domainkey.nodomain.net. 3600 IN TXT "v=DKIM1; k=rsa; p=DDDD"
`;
    const { detectedDomain } = parseDkimSelectorsFromZoneFile(zoneFile);
    expect(detectedDomain).toBe('nodomain.net.');
  });

  it('skips comment lines', () => {
    const zoneFile = `; default._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa; p=AAAA"
default._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa; p=BBBB"
`;
    const { selectors } = parseDkimSelectorsFromZoneFile(zoneFile);
    expect(selectors).toHaveLength(1);
    expect(selectors[0].publicKey).toBe('BBBB');
  });

  it('returns empty detectedDomain when no clues available', () => {
    const zoneFile = `example.com. 3600 IN TXT "v=spf1 -all"
`;
    const { detectedDomain } = parseDkimSelectorsFromZoneFile(zoneFile);
    expect(detectedDomain).toBe('');
  });
});

/**
 * The production bug: every RSA DKIM selector showed "invalid" with a blank
 * TXT value, on domains whose keys demonstrably existed and whose mail was
 * being signed and delivered normally.
 *
 * Cause: Stalwart wraps any TXT value too long for one line in parentheses,
 * and an RSA public key always is. The parser worked line by line, so it saw
 * only the opening line — which carries `_domainkey` and `TXT` but no quoted
 * fragments — and the continuation lines were skipped because they lack
 * `_domainkey`. Ed25519 keys fit on one line, which is why the platform apex
 * looked healthy while every tenant domain showed invalid.
 *
 * Fixture is the real record shape taken from a production zone file, key
 * material replaced.
 */
describe('parseDkimSelectorsFromZoneFile — multi-line (parenthesised) records', () => {
  const RSA_WRAPPED = [
    'dkim-1._domainkey.example.test. IN TXT (',
    '    "v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAppxIB"',
    '    "3G9xIsFalbV8Q8K6Q2xLo5NcuVVbYAMDh60ZYDX7UuJQIDAQAB"',
    ')',
    'example.test. IN TXT "v=spf1 mx -all"',
  ].join('\n');

  it('reports a wrapped RSA selector as VALID', () => {
    const { selectors } = parseDkimSelectorsFromZoneFile(RSA_WRAPPED);
    expect(selectors).toHaveLength(1);
    expect(selectors[0].name).toBe('dkim-1._domainkey.example.test.');
    expect(selectors[0].valid).toBe(true);
  });

  it('joins every continuation fragment into one TXT value', () => {
    const [sel] = parseDkimSelectorsFromZoneFile(RSA_WRAPPED).selectors;
    expect(sel.txtValue).toBe(
      'v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAppxIB'
      + '3G9xIsFalbV8Q8K6Q2xLo5NcuVVbYAMDh60ZYDX7UuJQIDAQAB',
    );
    // The key must be the WHOLE thing — a truncated p= would still look
    // "valid" while being useless to a verifier.
    expect(sel.publicKey?.endsWith('IDAQAB')).toBe(true);
  });

  it('still handles the single-line ed25519 form', () => {
    const { selectors } = parseDkimSelectorsFromZoneFile(
      'default._domainkey.example.test. IN TXT "v=DKIM1; k=ed25519; h=sha256; p=LJh4YYCFE7kk="',
    );
    expect(selectors).toHaveLength(1);
    expect(selectors[0].valid).toBe(true);
  });

  it('does not let a wrapped record swallow the records after it', () => {
    const { selectors } = parseDkimSelectorsFromZoneFile(
      RSA_WRAPPED + '\ndefault._domainkey.example.test. IN TXT "v=DKIM1; k=ed25519; p=AAA="',
    );
    expect(selectors.map((s) => s.name)).toEqual([
      'dkim-1._domainkey.example.test.',
      'default._domainkey.example.test.',
    ]);
  });
});

describe('foldParenthesisedRecords', () => {
  it('leaves unwrapped lines exactly as they were', () => {
    const z = 'a. IN TXT "x"\nb. IN MX 10 mail.example.test.';
    expect(foldParenthesisedRecords(z)).toEqual(['a. IN TXT "x"', 'b. IN MX 10 mail.example.test.']);
  });

  // A parenthesis inside a quoted value is DATA, not grouping. Counting it
  // would swallow every following record into one line.
  it('ignores parentheses inside quoted strings', () => {
    const z = 'a. IN TXT "note (see docs)"\nb. IN TXT "y"';
    expect(foldParenthesisedRecords(z)).toEqual(['a. IN TXT "note (see docs)"', 'b. IN TXT "y"']);
  });

  it('emits an unterminated record rather than dropping the rest of the file', () => {
    const z = 'a. IN TXT (\n  "x"';
    expect(foldParenthesisedRecords(z)).toEqual(['a. IN TXT ( "x"']);
  });

  it('handles nested parentheses', () => {
    const z = 'a. IN TXT ( ( "x" ) )\nb. IN TXT "y"';
    expect(foldParenthesisedRecords(z)).toEqual(['a. IN TXT ( ( "x" ) )', 'b. IN TXT "y"']);
  });
});
