import { describe, it, expect } from 'vitest';
import { createdByLabel } from '@/lib/created-by-label';

describe('createdByLabel — Created By as a person', () => {
  it('shows the resolved name (the API already fell back to the email)', () => {
    expect(createdByLabel('u-1', 'Ada Lovelace')).toBe('Ada Lovelace');
    expect(createdByLabel('u-1', 'ops@example.test')).toBe('ops@example.test');
  });

  it('says System when a platform process created the tenant', () => {
    expect(createdByLabel(null, null)).toBe('System');
    expect(createdByLabel('system', null)).toBe('System');
  });

  it('says Unknown when the creating user no longer exists — never the raw id', () => {
    expect(createdByLabel('5f0c1d2e-0000-4000-8000-000000000000', null)).toBe('Unknown');
    expect(createdByLabel('u-1', '   ')).toBe('Unknown');
  });
});
