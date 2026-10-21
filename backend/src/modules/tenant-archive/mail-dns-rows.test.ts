import { describe, it, expect } from 'vitest';
import { rebuiltByMailRestore } from './mail-dns-rows.js';

/** The records a rebuilt mail domain writes afresh — never kept from the archive. */

const r = (recordType: string, recordName: string | null, recordValue: string | null = null) => ({ recordType, recordName, recordValue });

describe('rebuiltByMailRestore', () => {
  it('MX, SPF, DKIM, DMARC and every mail-discovery SRV record', () => {
    expect(rebuiltByMailRestore(r('MX', 'example.test', 'mail.example.test'), 'example.test', false)).toBe(true);
    expect(rebuiltByMailRestore(r('TXT', 'example.test', 'v=spf1 mx ~all'), 'example.test', false)).toBe(true);
    expect(rebuiltByMailRestore(r('TXT', 's1._domainkey.example.test', 'v=DKIM1; p=x'), 'example.test', false)).toBe(true);
    expect(rebuiltByMailRestore(r('TXT', '_dmarc.example.test', 'v=DMARC1; p=none'), 'example.test', false)).toBe(true);
    for (const srv of ['_imaps', '_imap', '_pop3s', '_submissions', '_submission']) {
      expect(rebuiltByMailRestore(r('SRV', `${srv}._tcp.example.test`, '0 1 993 mail.example.test'), 'example.test', false)).toBe(true);
    }
  });

  it('the webmail CNAME only when the mail domain has webmail on', () => {
    expect(rebuiltByMailRestore(r('CNAME', 'webmail.example.test', 'webmail.example.test.'), 'example.test', true)).toBe(true);
    expect(rebuiltByMailRestore(r('CNAME', 'webmail', 'webmail.example.test.'), 'example.test', true)).toBe(true);
    expect(rebuiltByMailRestore(r('CNAME', 'webmail.example.test', 'webmail.example.test.'), 'example.test', false)).toBe(false);
  });

  it('never a site record or another TXT', () => {
    expect(rebuiltByMailRestore(r('A', 'www', '192.0.2.10'), 'example.test', true)).toBe(false);
    expect(rebuiltByMailRestore(r('TXT', 'example.test', 'google-site-verification=abc'), 'example.test', true)).toBe(false);
    expect(rebuiltByMailRestore(r('CNAME', 'shop', 'shops.example.test.'), 'example.test', true)).toBe(false);
  });
});
