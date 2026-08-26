import { describe, it, expect } from 'vitest';
import { buildMailRulesScript, buildAccountPermissions, PLATFORM_SIEVE_SCRIPT_NAME } from './sieve.js';

describe('buildMailRulesScript', () => {
  it('returns null for a normal mailbox without forwarding (no script needed)', () => {
    expect(buildMailRulesScript({ mailboxType: 'mailbox', forwardingAddresses: [] })).toBeNull();
    expect(buildMailRulesScript({ mailboxType: 'mailbox', forwardingAddresses: ['  '] })).toBeNull();
  });

  it('normal mailbox + forwarding → redirect :copy per target (local copy kept)', () => {
    const script = buildMailRulesScript({ mailboxType: 'mailbox', forwardingAddresses: ['a@example.test', 'b@example.test'] });
    expect(script).toContain('require ["copy"];');
    expect(script).toContain('redirect :copy "a@example.test";');
    expect(script).toContain('redirect :copy "b@example.test";');
    expect(script).not.toContain('ereject');
  });

  it('send-only + forwarding → plain redirect (implicit keep cancelled, not stored)', () => {
    const script = buildMailRulesScript({ mailboxType: 'send_only', forwardingAddresses: ['a@example.test'] });
    expect(script).toContain('redirect "a@example.test";');
    expect(script).not.toContain(':copy');
    expect(script).not.toContain('ereject');
  });

  it('send-only without forwarding → ereject bounce', () => {
    const script = buildMailRulesScript({ mailboxType: 'send_only', forwardingAddresses: [] });
    expect(script).toContain('require ["ereject"];');
    expect(script).toContain('ereject "This address does not accept incoming mail.";');
    expect(script).not.toContain('redirect');
  });

  it('escapes quotes and backslashes in addresses (Sieve string safety)', () => {
    // Not creatable via the zod email contract, but the builder must never
    // emit a syntax-breaking script even if a caller bypasses validation.
    const script = buildMailRulesScript({ mailboxType: 'mailbox', forwardingAddresses: ['a"b\\c@example.test'] });
    expect(script).toContain('redirect :copy "a\\"b\\\\c@example.test";');
  });

  it('marks the script as platform-managed', () => {
    const script = buildMailRulesScript({ mailboxType: 'send_only', forwardingAddresses: [] });
    expect(script).toContain('Managed by the hosting platform');
  });

  it('reserved script name matches the backup tooling', () => {
    // images/tenant-backup-tools/jmap-aux-restore.py RESERVED_SIEVE_NAMES
    // must contain this exact name — change both together.
    expect(PLATFORM_SIEVE_SCRIPT_NAME).toBe('platform-mail-rules');
  });
});

describe('buildMailRulesScript — vacation auto-reply', () => {
  it('auto-reply only → vacation block with subject and multi-line body', () => {
    const script = buildMailRulesScript({
      mailboxType: 'mailbox',
      forwardingAddresses: [],
      autoReply: { subject: 'Out of office', body: 'I am away.\nBack Monday.' },
    });
    expect(script).toContain('require ["vacation"];');
    expect(script).toContain('vacation :subject "Out of office" text:\r\nI am away.\r\nBack Monday.\r\n.\r\n;');
    expect(script).not.toContain('redirect');
  });

  it('omits :subject when the subject is empty (server default applies)', () => {
    const script = buildMailRulesScript({
      mailboxType: 'mailbox',
      forwardingAddresses: [],
      autoReply: { subject: '  ', body: 'Away.' },
    });
    expect(script).toContain('vacation text:\r\nAway.\r\n.\r\n;');
    expect(script).not.toContain(':subject');
  });

  it('dot-stuffs body lines starting with "." so they cannot terminate the literal', () => {
    const script = buildMailRulesScript({
      mailboxType: 'mailbox',
      forwardingAddresses: [],
      autoReply: { subject: null, body: 'line one\n.\n.hidden' },
    });
    expect(script).toContain('line one\r\n..\r\n..hidden\r\n.\r\n;');
  });

  it('escapes quotes/backslashes in the subject', () => {
    const script = buildMailRulesScript({
      mailboxType: 'mailbox',
      forwardingAddresses: [],
      autoReply: { subject: 'A "b" \\ c', body: 'x' },
    });
    expect(script).toContain('vacation :subject "A \\"b\\" \\\\ c" text:');
  });

  it('forwarding + auto-reply combine: vacation BEFORE redirect :copy, both required', () => {
    const script = buildMailRulesScript({
      mailboxType: 'mailbox',
      forwardingAddresses: ['dest@example.net'],
      autoReply: { subject: 'OOO', body: 'Away.' },
    });
    expect(script).toContain('require ["copy", "vacation"];');
    const vacIdx = script!.indexOf('vacation ');
    const redirIdx = script!.indexOf('redirect :copy');
    expect(vacIdx).toBeGreaterThan(-1);
    expect(redirIdx).toBeGreaterThan(vacIdx);
  });

  it('empty/whitespace body means auto-reply OFF (no script for a plain mailbox)', () => {
    expect(buildMailRulesScript({
      mailboxType: 'mailbox',
      forwardingAddresses: [],
      autoReply: { subject: 'x', body: '   ' },
    })).toBeNull();
  });

  it('send-only never gets a vacation block (service rejects it upstream)', () => {
    const script = buildMailRulesScript({
      mailboxType: 'send_only',
      forwardingAddresses: [],
      autoReply: { subject: 'x', body: 'y' },
    });
    expect(script).toContain('ereject');
    expect(script).not.toContain('vacation');
  });
  it('collapses CR/LF and control characters in the subject (no Sieve/header injection)', () => {
    const script = buildMailRulesScript({
      mailboxType: 'mailbox',
      forwardingAddresses: [],
      autoReply: { subject: 'Hi\r\nBcc: x@evil.test\tz', body: 'x' },
    });
    expect(script).toContain('vacation :subject "Hi Bcc: x@evil.test z" text:');
  });
});

describe('buildMailRulesScript — suspension (2026-08-26 full mail shutdown)', () => {
  it('suspended overrides everything with an ereject-only script', () => {
    for (const mailboxType of ['mailbox', 'send_only'] as const) {
      const script = buildMailRulesScript({
        mailboxType,
        suspended: true,
        forwardingAddresses: ['keep@example.test'],
        autoReply: { subject: 'away', body: 'body' },
      });
      expect(script).toContain('require ["ereject"];');
      expect(script).toContain('ereject "This address is currently unavailable.";');
      expect(script).not.toContain('redirect');
      expect(script).not.toContain('vacation');
    }
  });

  it('suspended:false keeps the normal derivation', () => {
    const script = buildMailRulesScript({
      mailboxType: 'mailbox',
      suspended: false,
      forwardingAddresses: ['t@example.test'],
    });
    expect(script).toContain('redirect :copy "t@example.test";');
    expect(script).not.toContain('unavailable');
  });
});

describe('buildAccountPermissions', () => {
  it('active mailbox: authenticate force-enabled, nothing disabled', () => {
    expect(buildAccountPermissions({ mailboxType: 'mailbox', suspended: false })).toEqual({
      '@type': 'Merge',
      enabledPermissions: { authenticate: true },
      disabledPermissions: {},
    });
  });

  it('active send-only: profile disables imap/pop3/sieve only', () => {
    expect(buildAccountPermissions({ mailboxType: 'send_only', suspended: false })).toEqual({
      '@type': 'Merge',
      enabledPermissions: { authenticate: true },
      disabledPermissions: { imapAuthenticate: true, pop3Authenticate: true, sieveAuthenticate: true },
    });
  });

  it('suspended composes authenticate-off WITH the send-only profile (patches clobber — full set every write)', () => {
    expect(buildAccountPermissions({ mailboxType: 'send_only', suspended: true })).toEqual({
      '@type': 'Merge',
      enabledPermissions: {},
      disabledPermissions: {
        authenticate: true,
        imapAuthenticate: true,
        pop3Authenticate: true,
        sieveAuthenticate: true,
      },
    });
    expect(buildAccountPermissions({ mailboxType: 'mailbox', suspended: true })).toEqual({
      '@type': 'Merge',
      enabledPermissions: {},
      disabledPermissions: { authenticate: true },
    });
  });
});
