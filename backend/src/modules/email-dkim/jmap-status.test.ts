import { describe, it, expect } from 'vitest';
import { parseDkimSelectorsFromZoneFile } from './jmap-status.js';

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
