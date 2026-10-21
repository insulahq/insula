import { describe, expect, it, vi } from 'vitest';

const notifyAdminOperationalEvent = vi.fn();
vi.mock('../notifications/events.js', () => ({
  notifyAdminOperationalEvent: (...args: unknown[]) => notifyAdminOperationalEvent(...args),
}));

import { explainingOutage, notifyOperatorOfPlatformFault, outageFromNodes } from './platform-fault.js';
import type { CronJobRow } from './executor.js';
import type { Database } from '../../db/index.js';

const NOW = new Date('2026-10-20T21:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const ESTABLISHED = '2026-01-01T00:00:00Z';
const node = (name: string, status: string, readySince: string, created = ESTABLISHED) => ({
  metadata: { name, creationTimestamp: created },
  status: { conditions: [{ type: 'Ready', status, lastTransitionTime: readySince }], addresses: [] },
});
const healthy = node('node-a', 'True', ESTABLISHED);

describe('outageFromNodes', () => {
  it('names a node that went down in the last 15 minutes', () => {
    expect(outageFromNodes([healthy, node('node-b', 'Unknown', minutesAgo(4))], NOW)).toBe('node-b went down at 20:56 UTC');
  });

  // A node left off for days must not silence these notices while it stays off:
  // the Service dropped its API server long ago, so a fault now has another cause.
  it('does not let a node that has been down for hours explain a fault now', () => {
    expect(outageFromNodes([healthy, node('node-b', 'Unknown', minutesAgo(180))], NOW)).toBeNull();
  });

  it('names a node back inside its settle window, and one still joining', () => {
    expect(outageFromNodes([healthy, node('node-b', 'True', minutesAgo(3))], NOW)).toBe('node-b came back at 20:57 UTC and is still settling');
    expect(outageFromNodes([healthy, node('node-c', 'True', minutesAgo(20), minutesAgo(20))], NOW)).toBe('node-c is joining the cluster');
  });

  it('is null for a healthy cluster — that is when the operator must hear of it', () => {
    expect(outageFromNodes([healthy, node('node-b', 'True', minutesAgo(600))], NOW)).toBeNull();
  });
});

describe('explainingOutage', () => {
  /** select().from().where().limit() → the rows the detectors recorded down recently. */
  const dbWithDown = (rows: Array<{ nodeName: string; downSince: Date }>) => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  }) as unknown as Database;

  it('trusts the cluster\'s Node list when it answers — the database is not asked', async () => {
    const db = { select: vi.fn() } as unknown as Database;
    expect(await explainingOutage(db, async () => [healthy], NOW)).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  // The cluster API is what could not be reached: it may not answer this either.
  it('falls back to what the node-health detectors last recorded when the cluster cannot be asked', async () => {
    const db = dbWithDown([{ nodeName: 'node-b', downSince: new Date(minutesAgo(5)) }]);
    expect(await explainingOutage(db, async () => null, NOW)).toBe('node-b went down at 20:55 UTC (as last recorded)');
    expect(await explainingOutage(dbWithDown([]), async () => null, NOW)).toBeNull();
  });
});

describe('notifyOperatorOfPlatformFault', () => {
  it('never throws — the run is already recorded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const job = { id: 'job-1', tenantId: 't-1', name: 'Moodle' } as CronJobRow;
    await expect(notifyOperatorOfPlatformFault({} as Database, job, 'could not reach the cluster API', async () => {
      throw new Error('list failed');
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not tell the operator'), 'list failed');
    warn.mockRestore();
  });
});
