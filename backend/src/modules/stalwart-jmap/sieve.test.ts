import { describe, it, expect } from 'vitest';
import { buildMailRulesScript, PLATFORM_SIEVE_SCRIPT_NAME } from './sieve.js';

describe('buildMailRulesScript', () => {
  it('returns null for a normal mailbox without forwarding (no script needed)', () => {
    expect(buildMailRulesScript('mailbox', [])).toBeNull();
    expect(buildMailRulesScript('mailbox', ['  '])).toBeNull();
  });

  it('normal mailbox + forwarding → redirect :copy per target (local copy kept)', () => {
    const script = buildMailRulesScript('mailbox', ['a@example.test', 'b@example.test']);
    expect(script).toContain('require ["copy"];');
    expect(script).toContain('redirect :copy "a@example.test";');
    expect(script).toContain('redirect :copy "b@example.test";');
    expect(script).not.toContain('ereject');
  });

  it('send-only + forwarding → plain redirect (implicit keep cancelled, not stored)', () => {
    const script = buildMailRulesScript('send_only', ['a@example.test']);
    expect(script).toContain('redirect "a@example.test";');
    expect(script).not.toContain(':copy');
    expect(script).not.toContain('ereject');
  });

  it('send-only without forwarding → ereject bounce', () => {
    const script = buildMailRulesScript('send_only', []);
    expect(script).toContain('require ["ereject"];');
    expect(script).toContain('ereject "This address does not accept incoming mail.";');
    expect(script).not.toContain('redirect');
  });

  it('escapes quotes and backslashes in addresses (Sieve string safety)', () => {
    // Not creatable via the zod email contract, but the builder must never
    // emit a syntax-breaking script even if a caller bypasses validation.
    const script = buildMailRulesScript('mailbox', ['a"b\\c@example.test']);
    expect(script).toContain('redirect :copy "a\\"b\\\\c@example.test";');
  });

  it('marks the script as platform-managed', () => {
    const script = buildMailRulesScript('send_only', []);
    expect(script).toContain('Managed by the hosting platform');
  });

  it('reserved script name matches the backup tooling', () => {
    // images/tenant-backup-tools/jmap-aux-restore.py RESERVED_SIEVE_NAMES
    // must contain this exact name — change both together.
    expect(PLATFORM_SIEVE_SCRIPT_NAME).toBe('platform-mail-rules');
  });
});
