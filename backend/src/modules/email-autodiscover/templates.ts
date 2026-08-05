/**
 * Autodiscover / autoconfig / MTA-STS template renderers.
 *
 * Pure functions — take domain / hostname inputs and return the
 * rendered XML or plain-text body. No DB, no I/O. Tested with
 * golden-output snapshots.
 *
 * Endpoints:
 *   - /.well-known/autoconfig/mail/config-v1.1.xml (Mozilla / Thunderbird)
 *   - /Autodiscover/Autodiscover.xml (Microsoft / Outlook)
 *   - /.well-known/mta-sts.txt (MTA-STS policy)
 *
 * Phase 3.C.1.
 */

import { MAIL_SERVICE_PORTS, type MailServicePort } from '@insula/api-contracts';

/**
 * Ports are read from the shared table rather than written inline, so the XML a
 * client auto-fetches and the "How to connect" guide a human reads can never
 * disagree. Lookups are strict: a missing entry throws at render time instead
 * of silently emitting a wrong port.
 */
function portFor(protocol: MailServicePort['protocol'], socketType: MailServicePort['socketType']): number {
  const match = MAIL_SERVICE_PORTS.find((p) => p.protocol === protocol && p.socketType === socketType);
  if (!match) throw new Error(`no ${protocol}/${socketType} entry in MAIL_SERVICE_PORTS`);
  return match.port;
}

const IMAP_SSL = portFor('imap', 'ssl');
const POP3_SSL = portFor('pop3', 'ssl');
const SMTP_SSL = portFor('smtp', 'ssl');
const SMTP_STARTTLS = portFor('smtp', 'starttls');

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Mozilla Autoconfig ───────────────────────────────────────────────────

export interface MozillaAutoconfigInput {
  readonly domain: string;
  readonly mailServerHostname: string;
  readonly displayName: string;
}

export function renderMozillaAutoconfigXml(input: MozillaAutoconfigInput): string {
  const domain = escapeXml(input.domain);
  const host = escapeXml(input.mailServerHostname);
  const name = escapeXml(input.displayName);

  return `<?xml version="1.0" encoding="UTF-8"?>
<tenantConfig version="1.1">
  <emailProvider id="${domain}">
    <identity/>
    <domain>${domain}</domain>
    <displayName>${name}</displayName>
    <displayShortName>${name}</displayShortName>

    <incomingServer type="imap">
      <hostname>${host}</hostname>
      <port>${IMAP_SSL}</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>

    <incomingServer type="pop3">
      <hostname>${host}</hostname>
      <port>${POP3_SSL}</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
      <pop3>
        <leaveMessagesOnServer>true</leaveMessagesOnServer>
      </pop3>
    </incomingServer>

    <outgoingServer type="smtp">
      <hostname>${host}</hostname>
      <port>${SMTP_SSL}</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>

    <outgoingServer type="smtp">
      <hostname>${host}</hostname>
      <port>${SMTP_STARTTLS}</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>

    <documentation url="https://${host}/">
      <descr lang="en">Generic configuration page</descr>
    </documentation>
  </emailProvider>
</tenantConfig>
`;
}

// ─── Microsoft Autodiscover ──────────────────────────────────────────────

export interface OutlookAutodiscoverInput {
  readonly emailAddress: string;
  readonly mailServerHostname: string;
}

export function renderOutlookAutodiscoverXml(input: OutlookAutodiscoverInput): string {
  const email = escapeXml(input.emailAddress);
  const host = escapeXml(input.mailServerHostname);

  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <User>
      <DisplayName>${email}</DisplayName>
    </User>
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${host}</Server>
        <Port>${IMAP_SSL}</Port>
        <LoginName>${email}</LoginName>
        <SSL>on</SSL>
        <SPA>off</SPA>
        <AuthRequired>on</AuthRequired>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${host}</Server>
        <Port>${SMTP_SSL}</Port>
        <LoginName>${email}</LoginName>
        <SSL>on</SSL>
        <SPA>off</SPA>
        <AuthRequired>on</AuthRequired>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>
`;
}

// ─── MTA-STS policy ──────────────────────────────────────────────────────

export interface MtaStsPolicyInput {
  readonly mailServerHostname: string;
  readonly mode?: 'testing' | 'enforce' | 'none';
  readonly maxAge?: number;
}

export function renderMtaStsPolicyText(input: MtaStsPolicyInput): string {
  const mode = input.mode ?? 'testing';
  const maxAge = input.maxAge ?? 86400;
  return `version: STSv1
mode: ${mode}
mx: ${input.mailServerHostname}
max_age: ${maxAge}
`;
}
