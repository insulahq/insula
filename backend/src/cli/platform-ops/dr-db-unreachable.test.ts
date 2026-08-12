import { describe, it, expect } from 'vitest';
import { isDbUnreachable } from './dr-ops.js';

/**
 * Regression (2026-08-12, 4-node VM cluster): `insula dr restore` run on a node
 * that was not hosting the CNPG primary failed with
 *   "UNEXPECTED — Connection terminated due to connection timeout"
 * which tells an operator mid-incident nothing. Postgres pods are
 * NetworkPolicy-restricted to pod/namespace peers, so a host-sourced connection
 * only succeeds from the primary's own node. These are the messages that must
 * be recognised so the CLI can name that node instead.
 */
describe('isDbUnreachable', () => {
  it('recognises the pg pool timeout seen on a non-primary node', () => {
    expect(isDbUnreachable(new Error('Connection terminated due to connection timeout'))).toBe(true);
  });

  it('recognises the other connection-class failures', () => {
    for (const m of [
      'timeout exceeded when trying to connect',
      'connect ECONNREFUSED 10.43.30.241:5432',
      'connect ETIMEDOUT 10.43.30.241:5432',
      'connect EHOSTUNREACH 10.42.229.27:5432',
      'connect ENETUNREACH 10.42.229.27:5432',
    ]) {
      expect(isDbUnreachable(new Error(m)), m).toBe(true);
    }
  });

  it('is case-insensitive (drivers vary)', () => {
    expect(isDbUnreachable(new Error('Connect ECONNREFUSED'))).toBe(true);
  });

  it('does NOT swallow real DR faults — they must keep their own labels', () => {
    for (const m of [
      'bundle is from an older platform version',
      'age: no identity matched any of the recipients',
      'duplicate key value violates unique constraint',
      'CNPG recovery timed out waiting for promote',
      'permission denied for table backup_configurations',
    ]) {
      expect(isDbUnreachable(new Error(m)), m).toBe(false);
    }
  });

  it('tolerates non-Error throwables', () => {
    expect(isDbUnreachable('Connection terminated due to connection timeout')).toBe(true);
    expect(isDbUnreachable(undefined)).toBe(false);
  });
});
