import { describe, it, expect } from 'vitest';
import { shouldNotifyTenant, shouldNotifyAdmins } from './notification-policy.js';

describe('shouldNotifyTenant', () => {
  it('never notifies the tenant about a SCHEDULED backup', () => {
    // The reported behaviour: "Scheduled tenant backup completed" arriving in
    // the tenant panel nightly. Neither outcome should reach them.
    expect(shouldNotifyTenant('system')).toBe(false);
  });

  it('never notifies the tenant about a CLUSTER-wide automated run either', () => {
    // orchestrator.ts groups 'cluster' with 'system' as cron-triggered with no
    // triggering user; routes.ts pairs them too. Same reasoning applies.
    expect(shouldNotifyTenant('cluster')).toBe(false);
  });

  it('notifies the tenant about their own on-demand backup', () => {
    expect(shouldNotifyTenant('tenant')).toBe(true);
  });

  it('notifies the tenant about an operator-triggered backup', () => {
    // Someone acted on their account outside the schedule — that is worth
    // telling them about, and it is rare enough not to be noise.
    expect(shouldNotifyTenant('admin')).toBe(true);
  });

  it('notifies when the initiator is unknown rather than swallowing silently', () => {
    // Fail loud: an unlabelled run is a bug, and a missing notification is
    // harder to notice than a surplus one.
    expect(shouldNotifyTenant(undefined)).toBe(true);
  });
});

describe('shouldNotifyAdmins', () => {
  it('notifies admins when a scheduled backup FAILS — nobody else is watching', () => {
    expect(shouldNotifyAdmins('system', true)).toBe(true);
  });

  it('stays quiet when a scheduled backup succeeds', () => {
    expect(shouldNotifyAdmins('system', false)).toBe(false);
  });

  it('notifies admins on any failed initiator', () => {
    expect(shouldNotifyAdmins('tenant', true)).toBe(true);
    expect(shouldNotifyAdmins('admin', true)).toBe(true);
    expect(shouldNotifyAdmins('cluster', true)).toBe(true);
  });

  it('never notifies admins about a success', () => {
    expect(shouldNotifyAdmins('tenant', false)).toBe(false);
    expect(shouldNotifyAdmins('admin', false)).toBe(false);
  });
});
