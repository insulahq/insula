import { describe, expect, it } from 'vitest';
import { toRecoveryBundle } from './recovery-info.js';

describe('toRecoveryBundle', () => {
  it('says when it was taken, by what, what it holds and how big — the row itself is only a manifest', () => {
    expect(toRecoveryBundle({
      id: 'bkp-1', created_at: '2026-10-03T01:36:57.662Z', finished_at: null, status: 'completed',
      initiator: 'system', system_trigger: 'scheduled', label: null, expires_at: '2026-11-02T17:00:00.000Z',
      components: [{ component: 'files', sizeBytes: '1288490188' }, { component: 'mailboxes', sizeBytes: 1000 }],
    })).toEqual({
      id: 'bkp-1', createdAt: '2026-10-03T01:36:57.662Z', finishedAt: null, status: 'completed',
      trigger: 'scheduled', label: null, sizeBytes: 1288491188,
      components: [{ component: 'files', sizeBytes: 1288490188 }, { component: 'mailboxes', sizeBytes: 1000 }],
      expiresAt: '2026-11-02T17:00:00.000Z',
    });
  });

  it('an operator-taken bundle with no components is still listed', () => {
    const b = toRecoveryBundle({
      id: 'bkp-2', created_at: new Date('2026-10-01T10:00:00Z'), finished_at: null, status: 'partial',
      initiator: 'admin', system_trigger: null, label: 'before migration', expires_at: null, components: null,
    });
    expect(b).toMatchObject({ trigger: 'admin', label: 'before migration', sizeBytes: 0, components: [], expiresAt: null });
  });
});
