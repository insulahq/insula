import { describe, it, expect } from 'vitest';
import { permissionsMatch } from './mail-rules-reconcile.js';
import { buildAccountPermissions } from '../stalwart-jmap/sieve.js';

describe('permissionsMatch (reconcile permission diff)', () => {
  it('an account with NO stored permissions equals "nothing disabled"', () => {
    const desired = buildAccountPermissions({ mailboxType: 'mailbox', suspended: false });
    expect(permissionsMatch(undefined, desired)).toBe(true);
  });

  it('a virgin account does NOT match a suspended desired state', () => {
    const desired = buildAccountPermissions({ mailboxType: 'mailbox', suspended: true });
    expect(permissionsMatch(undefined, desired)).toBe(false);
  });

  it('matches on the disabled set irrespective of order / enabled flips', () => {
    const desired = buildAccountPermissions({ mailboxType: 'send_only', suspended: true });
    expect(permissionsMatch({
      enabledPermissions: {},
      disabledPermissions: {
        sieveAuthenticate: true, authenticate: true, pop3Authenticate: true, imapAuthenticate: true,
      },
    }, desired)).toBe(true);
  });

  it('detects a leftover suspension disable on an active mailbox', () => {
    const desired = buildAccountPermissions({ mailboxType: 'mailbox', suspended: false });
    expect(permissionsMatch({
      enabledPermissions: {},
      disabledPermissions: { authenticate: true },
    }, desired)).toBe(false);
  });

  it('ignores false-valued entries in the stored disabled map', () => {
    const desired = buildAccountPermissions({ mailboxType: 'mailbox', suspended: false });
    expect(permissionsMatch({
      enabledPermissions: { authenticate: true },
      disabledPermissions: { authenticate: false },
    }, desired)).toBe(true);
  });
});
