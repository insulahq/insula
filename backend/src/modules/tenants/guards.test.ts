import { describe, it, expect } from 'vitest';
import { assertTenantActive } from './guards.js';
import { ApiError } from '../../shared/errors.js';

describe('assertTenantActive', () => {
  it('is a no-op for an active tenant', () => {
    expect(() => assertTenantActive({ id: 'c1', status: 'active' }, 'deploy workloads')).not.toThrow();
  });

  it.each(['pending', 'suspended', 'archived'] as const)(
    'throws TENANT_NOT_ACTIVE (409) for a %s tenant',
    (status) => {
      try {
        assertTenantActive({ id: 'c1', status }, 'deploy workloads');
        throw new Error('expected assertTenantActive to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const e = err as ApiError;
        expect(e.code).toBe('TENANT_NOT_ACTIVE');
        expect(e.status).toBe(409);
        // operatorError envelope is rendered by <ErrorPanel>
        const details = e.details as { operatorError?: { code?: string; remediation?: string[] } };
        expect(details.operatorError?.code).toBe('TENANT_NOT_ACTIVE');
        expect(Array.isArray(details.operatorError?.remediation)).toBe(true);
      }
    },
  );

  it('pending remediation points at provisioning', () => {
    try {
      assertTenantActive({ id: 'c1', status: 'pending' }, 'create mailboxes');
      throw new Error('expected throw');
    } catch (err) {
      const e = err as ApiError;
      const details = e.details as { operatorError?: { remediation?: string[] } };
      expect((details.operatorError?.remediation ?? []).join(' ')).toMatch(/provision/i);
    }
  });

  it('throws for a null/undefined row (tenant not found upstream)', () => {
    expect(() => assertTenantActive(null, 'configure domains')).toThrow(ApiError);
    expect(() => assertTenantActive(undefined, 'configure domains')).toThrow(ApiError);
  });

  it('includes the action in the message', () => {
    try {
      assertTenantActive({ id: 'c1', status: 'pending' }, 'enable email for a domain');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ApiError).message).toContain('enable email for a domain');
    }
  });
});
