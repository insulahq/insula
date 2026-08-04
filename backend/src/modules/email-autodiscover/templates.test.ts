import { describe, it, expect } from 'vitest';
import { MAIL_SERVICE_PORTS, recommendedMailPort } from '@insula/api-contracts';
import {
  renderMozillaAutoconfigXml,
  renderOutlookAutodiscoverXml,
  renderMtaStsPolicyText,
} from './templates.js';

describe('renderMozillaAutoconfigXml', () => {
  it('emits valid XML with IMAP + SMTP config for the given domain', () => {
    const xml = renderMozillaAutoconfigXml({
      domain: 'acme.com',
      mailServerHostname: 'mail.platform.com',
      displayName: 'Acme',
    });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<tenantConfig version="1.1">');
    expect(xml).toContain('<emailProvider id="acme.com">');
    expect(xml).toContain('<domain>acme.com</domain>');
    expect(xml).toContain('<displayName>Acme</displayName>');
    // IMAP incoming
    expect(xml).toContain('<incomingServer type="imap">');
    expect(xml).toContain('<hostname>mail.platform.com</hostname>');
    expect(xml).toContain('<port>993</port>');
    expect(xml).toContain('<socketType>SSL</socketType>');
    expect(xml).toContain('<authentication>password-cleartext</authentication>');
    // SMTP outgoing
    expect(xml).toContain('<outgoingServer type="smtp">');
    expect(xml).toContain('<port>465</port>');
  });

  it('escapes XML special characters in the domain and display name', () => {
    const xml = renderMozillaAutoconfigXml({
      domain: 'foo&bar.com',
      mailServerHostname: 'mail.example.com',
      displayName: 'A <B> & "C"',
    });
    expect(xml).toContain('foo&amp;bar.com');
    expect(xml).toContain('A &lt;B&gt; &amp; &quot;C&quot;');
    // Unescaped characters must not appear
    expect(xml).not.toMatch(/<domain>foo&bar/);
  });

  it('uses %EMAILADDRESS% placeholder for the username template', () => {
    const xml = renderMozillaAutoconfigXml({
      domain: 'acme.com',
      mailServerHostname: 'mail.platform.com',
      displayName: 'Acme',
    });
    expect(xml).toContain('%EMAILADDRESS%');
  });
});

describe('renderOutlookAutodiscoverXml', () => {
  it('emits valid Autodiscover XML for the given email address', () => {
    const xml = renderOutlookAutodiscoverXml({
      emailAddress: 'alice@acme.com',
      mailServerHostname: 'mail.platform.com',
    });

    expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toContain('<Autodiscover');
    expect(xml).toContain('<Response');
    expect(xml).toContain('<Type>IMAP</Type>');
    expect(xml).toContain('<Server>mail.platform.com</Server>');
    expect(xml).toContain('<Port>993</Port>');
    expect(xml).toContain('<SSL>on</SSL>');
    // SMTP protocol
    expect(xml).toContain('<Type>SMTP</Type>');
    expect(xml).toContain('<LoginName>alice@acme.com</LoginName>');
  });

  it('escapes XML special characters', () => {
    const xml = renderOutlookAutodiscoverXml({
      emailAddress: 'alice<test>@acme.com',
      mailServerHostname: 'mail.platform.com',
    });
    expect(xml).toContain('alice&lt;test&gt;@acme.com');
  });
});

describe('renderMtaStsPolicyText', () => {
  it('emits a valid MTA-STS policy body', () => {
    const text = renderMtaStsPolicyText({
      mailServerHostname: 'mail.platform.com',
      mode: 'enforce',
      maxAge: 604800,
    });

    expect(text).toContain('version: STSv1');
    expect(text).toContain('mode: enforce');
    expect(text).toContain('mx: mail.platform.com');
    expect(text).toContain('max_age: 604800');
  });

  it('defaults mode to testing for safe rollout', () => {
    const text = renderMtaStsPolicyText({
      mailServerHostname: 'mail.platform.com',
    });
    expect(text).toContain('mode: testing');
  });
});

// The tenant panel's "How to connect" guide renders MAIL_SERVICE_PORTS
// directly. These assert the XML a client auto-fetches is built from that same
// table, so the two surfaces cannot drift apart: change a port in the contract
// and the golden assertions above fail until the docs/UI agree.
describe('port table is single-sourced from @insula/api-contracts', () => {
  it('renders every Mozilla autoconfig port from MAIL_SERVICE_PORTS', () => {
    const xml = renderMozillaAutoconfigXml({
      domain: 'acme.com',
      mailServerHostname: 'mail.platform.com',
      displayName: 'Acme',
    });

    for (const protocol of ['imap', 'pop3', 'smtp'] as const) {
      const entry = recommendedMailPort(protocol);
      expect(xml).toContain(`<port>${entry.port}</port>`);
    }
    const starttlsSmtp = MAIL_SERVICE_PORTS.find(
      (p) => p.protocol === 'smtp' && p.socketType === 'starttls',
    );
    expect(starttlsSmtp).toBeDefined();
    expect(xml).toContain(`<port>${starttlsSmtp!.port}</port>`);
  });

  it('renders Outlook autodiscover ports from MAIL_SERVICE_PORTS', () => {
    const xml = renderOutlookAutodiscoverXml({
      emailAddress: 'user@acme.com',
      mailServerHostname: 'mail.platform.com',
    });

    expect(xml).toContain(`<Port>${recommendedMailPort('imap').port}</Port>`);
    expect(xml).toContain(`<Port>${recommendedMailPort('smtp').port}</Port>`);
  });

  it('registers exactly one recommended entry per protocol', () => {
    for (const protocol of ['imap', 'pop3', 'smtp'] as const) {
      const recommended = MAIL_SERVICE_PORTS.filter((p) => p.protocol === protocol && p.recommended);
      expect(recommended).toHaveLength(1);
    }
  });
});
