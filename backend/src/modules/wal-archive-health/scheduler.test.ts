import { describe, it, expect, vi } from 'vitest';
import { runWalArchiveTick, type WalArchiveTickPorts } from './scheduler.js';
import type { WalArchiveSnapshot } from './health.js';
import { UNTRIPPED } from './breaker.js';
import type { Database } from '../../db/index.js';

const GiB = 1024 ** 3;
const db = {} as Database;
const log = { warn: vi.fn(), error: vi.fn() };

function snap(over: Partial<WalArchiveSnapshot> = {}): WalArchiveSnapshot {
  return { clusterName: 'system-db', barmanPluginPresent: true, continuousArchivingHealthy: true, walBytes: GiB, volumeBytes: 20 * GiB, ...over };
}

type FakePorts = WalArchiveTickPorts & {
  notifyFailing: ReturnType<typeof vi.fn>; notifyDisabled: ReturnType<typeof vi.fn>;
  tripBreaker: ReturnType<typeof vi.fn>; disableArchiving: ReturnType<typeof vi.fn>;
};

function ports(over: Partial<WalArchiveTickPorts> = {}): FakePorts {
  return {
    readBreaker: vi.fn(async () => UNTRIPPED),
    readSnapshot: vi.fn(async () => snap()),
    notifyFailing: vi.fn(async () => {}),
    notifyDisabled: vi.fn(async () => {}),
    tripBreaker: vi.fn(async () => {}),
    disableArchiving: vi.fn(async () => {}),
    nowIso: () => '2026-06-02T00:00:00.000Z',
    ...over,
  } as FakePorts;
}

describe('runWalArchiveTick', () => {
  it('does nothing when archiving is healthy', async () => {
    const p = ports();
    await runWalArchiveTick(db, log, p);
    expect(p.notifyFailing).not.toHaveBeenCalled();
    expect(p.notifyDisabled).not.toHaveBeenCalled();
    expect(p.tripBreaker).not.toHaveBeenCalled();
    expect(p.disableArchiving).not.toHaveBeenCalled();
  });

  it('short-circuits when the breaker is already tripped (no reads of snapshot)', async () => {
    const readSnapshot = vi.fn(async () => snap({ continuousArchivingHealthy: false, walBytes: 18 * GiB }));
    const p = ports({ readBreaker: vi.fn(async () => ({ tripped: true, reason: 'x', trippedAt: 't', clusterName: 'system-db' })), readSnapshot });
    await runWalArchiveTick(db, log, p);
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(p.disableArchiving).not.toHaveBeenCalled();
  });

  it('skips the tick when the snapshot is null (cluster not present)', async () => {
    const p = ports({ readSnapshot: vi.fn(async () => null) });
    await runWalArchiveTick(db, log, p);
    expect(p.notifyFailing).not.toHaveBeenCalled();
    expect(p.tripBreaker).not.toHaveBeenCalled();
  });

  it('ALERTS (no disable) when archiving fails at low pressure', async () => {
    const p = ports({ readSnapshot: vi.fn(async () => snap({ continuousArchivingHealthy: false, walBytes: 2 * GiB })) }); // 10%
    await runWalArchiveTick(db, log, p);
    expect(p.notifyFailing).toHaveBeenCalledTimes(1);
    const [, payload, dedupe] = p.notifyFailing.mock.calls[0];
    expect(payload).toMatchObject({ clusterName: 'system-db', pressurePercent: '10' });
    expect(dedupe).toBe('wal-failing:system-db');
    expect(p.disableArchiving).not.toHaveBeenCalled();
    expect(p.tripBreaker).not.toHaveBeenCalled();
    expect(p.notifyDisabled).not.toHaveBeenCalled();
  });

  it('TRIPS: disables archiving + persists breaker + critical alert at high pressure', async () => {
    const p = ports({ readSnapshot: vi.fn(async () => snap({ continuousArchivingHealthy: false, walBytes: 16 * GiB })) }); // 80%
    await runWalArchiveTick(db, log, p);
    expect(p.disableArchiving).toHaveBeenCalledTimes(1);
    expect(p.tripBreaker).toHaveBeenCalledTimes(1);
    const [, tripOpts] = p.tripBreaker.mock.calls[0];
    expect(tripOpts).toMatchObject({ clusterName: 'system-db', nowIso: '2026-06-02T00:00:00.000Z' });
    expect(p.notifyDisabled).toHaveBeenCalledTimes(1);
    expect(p.notifyFailing).not.toHaveBeenCalled(); // critical path doesn't also send the failing alert
  });

  it('still trips the breaker + alerts when the immediate disable throws', async () => {
    const p = ports({
      readSnapshot: vi.fn(async () => snap({ continuousArchivingHealthy: false, walBytes: 18 * GiB })),
      disableArchiving: vi.fn(async () => { throw new Error('k8s down'); }),
    });
    await runWalArchiveTick(db, log, p);
    expect(p.tripBreaker).toHaveBeenCalledTimes(1); // durable mechanism still engaged
    expect(p.notifyDisabled).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalled();
  });

  it('does NOT trip when no barman plugin even at high pressure (archiving off)', async () => {
    const p = ports({ readSnapshot: vi.fn(async () => snap({ barmanPluginPresent: false, continuousArchivingHealthy: false, walBytes: 19 * GiB })) });
    await runWalArchiveTick(db, log, p);
    expect(p.disableArchiving).not.toHaveBeenCalled();
    expect(p.notifyFailing).not.toHaveBeenCalled();
  });
});
