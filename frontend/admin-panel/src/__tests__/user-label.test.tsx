import { describe, it, expect } from 'vitest';
import { formatUserLabel } from '@/components/ui/UserLabel';

const USERS = [
  { id: 'u-1', email: 'ops@example.test', fullName: 'Ada Lovelace' },
  { id: 'u-2', email: 'noname@example.test', fullName: '' },
];

/**
 * Audit trails, WAF allowlists, rule exclusions, step-up events and the
 * secrets-coverage table all showed WHO acted as a raw UUID — a value the
 * operator had to look up elsewhere, so nobody did.
 *
 * The fallbacks matter as much as the happy path: an id that resolves to
 * nobody is still the only record of who acted, and a deleted admin is exactly
 * when that record counts.
 */
describe('formatUserLabel', () => {
  it('shows name and email for a known user', () => {
    expect(formatUserLabel('u-1', USERS).text).toBe('Ada Lovelace (ops@example.test)');
  });

  it('falls back to the email when there is no name', () => {
    expect(formatUserLabel('u-2', USERS).text).toBe('noname@example.test');
  });

  // Never blank, never just "unknown" — the id IS the audit record.
  it('keeps a shortened id for an unknown or deleted user, full id in the tooltip', () => {
    const r = formatUserLabel('0a513024-247c-45f5-b363-b131ff3350bd', USERS);
    expect(r.text).toBe('0a513024…');
    expect(r.title).toBe('0a513024-247c-45f5-b363-b131ff3350bd');
    expect(r.known).toBe(false);
  });

  it('passes through the non-user actors the platform writes', () => {
    expect(formatUserLabel('anonymous', USERS).text).toBe('anonymous');
    expect(formatUserLabel('system', USERS).text).toBe('system');
  });

  it('renders a dash for null/empty rather than throwing', () => {
    expect(formatUserLabel(null, USERS).text).toBe('—');
    expect(formatUserLabel(undefined, USERS).text).toBe('—');
    expect(formatUserLabel('', USERS).text).toBe('—');
  });

  // The users list arrives asynchronously; every consumer renders before it
  // resolves, so an empty list must degrade to the id, not crash.
  it('degrades to the id while the user list is still loading', () => {
    expect(formatUserLabel('u-1', []).text).toBe('u-1');
  });

  it('puts the id in the tooltip for a known user too, so it stays traceable', () => {
    expect(formatUserLabel('u-1', USERS).title).toContain('u-1');
  });
});
