/**
 * The posture card lists certificates whose renewal is overdue by the renewal
 * policy — not every certificate under 30 days, which listed healthy ones in
 * the hours before cert-manager renewed them.
 */
import { describe, it, expect, vi } from 'vitest';
import { fetchExpiringCerts } from './phase2-cards.js';

const NOW = new Date('2026-10-31T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const item = (name: string, lifetimeDays: number, leftDays: number) => {
  const notAfter = new Date(NOW.getTime() + leftDays * DAY);
  return {
    metadata: { name, namespace: 'tenant-a' },
    status: {
      notBefore: new Date(notAfter.getTime() - lifetimeDays * DAY).toISOString(),
      notAfter: notAfter.toISOString(),
      conditions: [{ type: 'Ready', status: 'True' }],
    },
  };
};

describe('fetchExpiringCerts', () => {
  it('lists overdue and expired certificates only, judged by each one\'s lifetime', async () => {
    const custom = {
      listClusterCustomObject: vi.fn(async () => ({
        items: [
          item('renewing-now', 89, 21),   // inside its renewal window: fine
          item('fresh', 89, 80),
          item('overdue', 90, 10),
          item('short-ok', 45, 9),
          item('short-overdue', 45, 6),
          item('expired', 90, -1),
        ],
      })),
    };
    const out = await fetchExpiringCerts(custom as never, () => NOW);
    expect(out.map((c) => c.name)).toEqual(['expired', 'short-overdue', 'overdue']);
  });
});
