/**
 * Tests for the tenant-restore-policy module.
 *
 * The policy gates what tenant-initiated restore operations are
 * allowed:
 *   - Which restoreItem types tenants can submit at all
 *   - Which tables in config-tables restores are denied wholesale
 *     (billing, platform-config, infra)
 *   - Which columns inside otherwise-allowed tables are redacted
 *     (e.g. tenants.plan_id, tenants.is_system)
 *
 * The browse endpoints hide denied items; the execute endpoints
 * re-validate (defence-in-depth against forged item payloads).
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TENANT_RESTORE_POLICY,
  isItemTypeAllowedForTenant,
  isTableAllowedForTenant,
  redactRowForTenant,
  validateRestoreItemForTenant,
  filterConfigTableNames,
} from './tenant-restore-policy.js';

describe('isItemTypeAllowedForTenant', () => {
  it('allows files-paths for tenants', () => {
    expect(isItemTypeAllowedForTenant('files-paths', DEFAULT_TENANT_RESTORE_POLICY)).toBe(true);
  });

  it('allows mailboxes-by-address for tenants', () => {
    expect(isItemTypeAllowedForTenant('mailboxes-by-address', DEFAULT_TENANT_RESTORE_POLICY)).toBe(true);
  });

  it('allows deployments-by-id for tenants', () => {
    expect(isItemTypeAllowedForTenant('deployments-by-id', DEFAULT_TENANT_RESTORE_POLICY)).toBe(true);
  });

  it('allows domains-by-id for tenants', () => {
    expect(isItemTypeAllowedForTenant('domains-by-id', DEFAULT_TENANT_RESTORE_POLICY)).toBe(true);
  });

  it('allows config-tables for tenants', () => {
    // Per user direction: tenants can restore all content but the
    // policy redacts denied tables/columns. Item-type itself is
    // allowed.
    expect(isItemTypeAllowedForTenant('config-tables', DEFAULT_TENANT_RESTORE_POLICY)).toBe(true);
  });
});

describe('isTableAllowedForTenant', () => {
  it('denies hosting_plans (billing)', () => {
    expect(isTableAllowedForTenant('hosting_plans', DEFAULT_TENANT_RESTORE_POLICY)).toBe(false);
  });

  it('denies backup_targets (infra)', () => {
    expect(isTableAllowedForTenant('backup_targets', DEFAULT_TENANT_RESTORE_POLICY)).toBe(false);
  });

  it('denies platform_settings (platform-level config)', () => {
    expect(isTableAllowedForTenant('platform_settings', DEFAULT_TENANT_RESTORE_POLICY)).toBe(false);
  });

  it('allows tenants table (with column redaction handled separately)', () => {
    expect(isTableAllowedForTenant('tenants', DEFAULT_TENANT_RESTORE_POLICY)).toBe(true);
  });

  it('allows domains table', () => {
    expect(isTableAllowedForTenant('domains', DEFAULT_TENANT_RESTORE_POLICY)).toBe(true);
  });

  it('allows mailboxes table', () => {
    expect(isTableAllowedForTenant('mailboxes', DEFAULT_TENANT_RESTORE_POLICY)).toBe(true);
  });
});

describe('redactRowForTenant', () => {
  it('strips plan_id from a tenants row (billing field)', () => {
    const row = {
      id: 'abc',
      name: 'Test Tenant',
      status: 'active',
      plan_id: 'expensive-plan',
    };
    const redacted = redactRowForTenant('tenants', row, DEFAULT_TENANT_RESTORE_POLICY);
    expect(redacted).not.toHaveProperty('plan_id');
    expect(redacted.id).toBe('abc');
    expect(redacted.name).toBe('Test Tenant');
  });

  it('strips storage_limit_override and other operator quotas from tenants row', () => {
    const row = {
      id: 'abc',
      storage_limit_override: 99999999,
      cpu_limit_override: 16,
      max_mailboxes_override: 5000,
      name: 'Tenant',
    };
    const redacted = redactRowForTenant('tenants', row, DEFAULT_TENANT_RESTORE_POLICY);
    expect(redacted).not.toHaveProperty('storage_limit_override');
    expect(redacted).not.toHaveProperty('cpu_limit_override');
    expect(redacted).not.toHaveProperty('max_mailboxes_override');
    expect(redacted.name).toBe('Tenant');
  });

  it('strips is_system flag (cannot escalate to SYSTEM)', () => {
    const row = { id: 'abc', name: 'X', is_system: true };
    const redacted = redactRowForTenant('tenants', row, DEFAULT_TENANT_RESTORE_POLICY);
    expect(redacted).not.toHaveProperty('is_system');
  });

  it('does not modify rows of tables with no column policy', () => {
    const row = { id: 'd1', name: 'mydomain.com', tenant_id: 'abc' };
    const redacted = redactRowForTenant('domains', row, DEFAULT_TENANT_RESTORE_POLICY);
    expect(redacted).toEqual(row);
  });

  it('does not mutate the input row', () => {
    const row = { id: 'abc', plan_id: 'p', name: 'X' };
    const before = JSON.stringify(row);
    redactRowForTenant('tenants', row, DEFAULT_TENANT_RESTORE_POLICY);
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe('filterConfigTableNames', () => {
  it('filters out denied tables from a list', () => {
    const all = ['tenants', 'hosting_plans', 'domains', 'platform_settings', 'mailboxes'];
    const filtered = filterConfigTableNames(all, DEFAULT_TENANT_RESTORE_POLICY);
    expect(filtered).toContain('tenants');
    expect(filtered).toContain('domains');
    expect(filtered).toContain('mailboxes');
    expect(filtered).not.toContain('hosting_plans');
    expect(filtered).not.toContain('platform_settings');
  });

  it('returns empty array when input is empty', () => {
    expect(filterConfigTableNames([], DEFAULT_TENANT_RESTORE_POLICY)).toEqual([]);
  });
});

describe('validateRestoreItemForTenant', () => {
  it('accepts a files-paths "full" restore', () => {
    const result = validateRestoreItemForTenant(
      { type: 'files-paths', selector: { kind: 'full' } },
      DEFAULT_TENANT_RESTORE_POLICY,
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts a config-tables restore against allowed tables', () => {
    const result = validateRestoreItemForTenant(
      { type: 'config-tables', selector: { kind: 'tables', tables: ['domains', 'mailboxes'] } },
      DEFAULT_TENANT_RESTORE_POLICY,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects a config-tables restore that includes a denied table', () => {
    const result = validateRestoreItemForTenant(
      { type: 'config-tables', selector: { kind: 'tables', tables: ['domains', 'hosting_plans'] } },
      DEFAULT_TENANT_RESTORE_POLICY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/hosting_plans/);
      expect(result.code).toBe('TABLE_DENIED');
    }
  });

  it('rejects a config-tables "all" restore (would silently restore denied tables)', () => {
    // "all" means restore every config table. Since the bundle may
    // include denied tables, we force the tenant to explicitly list
    // tables (which can then be filtered against the policy).
    const result = validateRestoreItemForTenant(
      { type: 'config-tables', selector: { kind: 'all' } },
      DEFAULT_TENANT_RESTORE_POLICY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SELECTOR_TOO_BROAD');
    }
  });
});
