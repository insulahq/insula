import { describe, it, expect, vi } from 'vitest';
import { runWalArchiveTick, failedFor, type WalArchiveTickPorts } from './scheduler.js';
import type { WalArchiveSnapshot } from './health.js';
import { UNTRIPPED } from './breaker.js';
import type { Database } from '../../db/index.js';

const GiB = 1024 ** 3;
const db = {} as Database;
const log = { warn: vi.fn(), error: vi.fn() };

function snap(over: Partial<WalArchiveSnapshot> = {}): WalArchiveSnapshot {
  return { clusterName: 'system-db', barmanPluginPresent: true, continuousArchivingHealthy: true, continuousArchivingConfirmed: true, failingSince: null, walBytes: GiB, volumeBytes: 20 * GiB, ...over };
}

type FakePorts = WalArchiveTickPorts & {
  notifyFailing: ReturnType<typeof vi.fn>; notifyDisabled: ReturnType<typeof vi.fn>;
  notifyRecovered: ReturnType<typeof vi.fn>; recordAlerted: ReturnType<typeof vi.fn>;
  clearAlerted: ReturnType<typeof vi.fn>;
  tripBreaker: ReturnType<typeof vi.fn>; disableArchiving: ReturnType<typeof vi.fn>;
};

function ports(over: Partial<WalArchiveTickPorts> = {}): FakePorts {
  return {
    readBreaker: vi.fn(async () => UNTRIPPED),
    readSnapshot: vi.fn(async () => snap()),
    notifyFailing: vi.fn(async () => true),
    notifyDisabled: vi.fn(async () => {}),
    notifyRecovered: vi.fn(async () => {}),
    readAlerted: vi.fn(async () => null),
    recordAlerted: vi.fn(async () => {}),
    clearAlerted: vi.fn(async () => {}),
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
    // No start from CNPG and none on record: the failure starts now.
    expect(dedupe).toBe('wal-failing:system-db:2026-06-02T00:00:00.000Z');
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

describe('runWalArchiveTick: one alert per failure, and its end', () => {
  const NOW = '2026-11-03T16:55:47.000Z';
  const failingFor = (since: string, over: Partial<WalArchiveSnapshot> = {}) =>
    vi.fn(async () => snap({ continuousArchivingHealthy: false, continuousArchivingConfirmed: false, failingSince: since, walBytes: 2 * GiB, ...over }));
  const onRecord = (since: string) => vi.fn(async () => ({ clusterName: 'system-db', failingSince: since, alertedAt: since }));

  it('does not alert for a failover upload that failed 2 seconds ago', async () => {
    const p = ports({ nowIso: () => '2026-11-03T16:30:47.000Z', readSnapshot: failingFor('2026-11-03T16:30:45Z') });
    await runWalArchiveTick(db, log, p);
    expect(p.notifyFailing).not.toHaveBeenCalled();
    expect(p.recordAlerted).not.toHaveBeenCalled();
  });

  it('alerts once it has failed 10 minutes, keyed by the failure, and records it', async () => {
    const p = ports({ nowIso: () => NOW, readSnapshot: failingFor('2026-11-03T16:30:45Z') });
    await runWalArchiveTick(db, log, p);
    expect(p.notifyFailing).toHaveBeenCalledTimes(1);
    expect(p.notifyFailing.mock.calls[0][2]).toBe('wal-failing:system-db:2026-11-03T16:30:45Z');
    expect(p.recordAlerted).toHaveBeenCalledWith(db, { clusterName: 'system-db', failingSince: '2026-11-03T16:30:45Z', alertedAt: NOW });
  });

  it('gives a later failure its own key, so the 30-day dedupe cannot swallow it', async () => {
    const first = ports({ nowIso: () => NOW, readSnapshot: failingFor('2026-11-03T16:30:45Z') });
    await runWalArchiveTick(db, log, first);
    const later = ports({ nowIso: () => '2026-11-10T09:15:00.000Z', readSnapshot: failingFor('2026-11-10T09:00:00Z') });
    await runWalArchiveTick(db, log, later);
    expect(later.notifyFailing.mock.calls[0][2]).toBe('wal-failing:system-db:2026-11-10T09:00:00Z');
    expect(later.notifyFailing.mock.calls[0][2]).not.toBe(first.notifyFailing.mock.calls[0][2]);
  });

  it('records nothing when the alert reached no one (rate limit, mutes)', async () => {
    const p = ports({ nowIso: () => NOW, readSnapshot: failingFor('2026-11-03T16:30:45Z'), notifyFailing: vi.fn(async () => false) });
    await runWalArchiveTick(db, log, p);
    expect(p.notifyFailing).toHaveBeenCalledTimes(1);
    expect(p.recordAlerted).not.toHaveBeenCalled();
  });

  it('does not rewrite the record on later ticks of the same failure', async () => {
    const p = ports({ nowIso: () => NOW, readSnapshot: failingFor('2026-11-03T16:30:45Z'), readAlerted: onRecord('2026-11-03T16:30:45Z') });
    await runWalArchiveTick(db, log, p);
    expect(p.recordAlerted).not.toHaveBeenCalled();
  });

  it('keys a failure with no start from CNPG by the one already on record', async () => {
    const p = ports({ nowIso: () => NOW, readSnapshot: vi.fn(async () => snap({ continuousArchivingHealthy: false, walBytes: 2 * GiB })), readAlerted: onRecord('2026-11-03T16:40:00.000Z') });
    await runWalArchiveTick(db, log, p);
    expect(p.notifyFailing.mock.calls[0][2]).toBe('wal-failing:system-db:2026-11-03T16:40:00.000Z');
    expect(p.recordAlerted).not.toHaveBeenCalled();
  });

  it('says "working again" once archiving recovers after an alert, then clears the record', async () => {
    const p = ports({ nowIso: () => NOW, readAlerted: onRecord('2026-11-03T16:30:45Z') });
    await runWalArchiveTick(db, log, p);
    expect(p.notifyRecovered).toHaveBeenCalledTimes(1);
    const [, payload, dedupe] = p.notifyRecovered.mock.calls[0];
    expect(payload).toEqual({ clusterName: 'system-db', failedFor: '25 minutes' });
    expect(dedupe).toBe('wal-recovered:system-db:2026-11-03T16:30:45Z');
    expect(p.clearAlerted).toHaveBeenCalledTimes(1);
  });

  it('waits, keeping the record, while the condition is absent or Unknown (a restart)', async () => {
    const p = ports({ nowIso: () => NOW, readAlerted: onRecord('2026-11-03T16:30:45Z'),
      readSnapshot: vi.fn(async () => snap({ continuousArchivingHealthy: true, continuousArchivingConfirmed: false })) });
    await runWalArchiveTick(db, log, p);
    expect(p.notifyRecovered).not.toHaveBeenCalled();
    expect(p.clearAlerted).not.toHaveBeenCalled();
  });

  it('keeps the record through a breaker trip, for the notice once an operator resets it', async () => {
    const p = ports({ nowIso: () => NOW, readAlerted: onRecord('2026-11-03T16:30:45Z'),
      readBreaker: vi.fn(async () => ({ tripped: true, reason: 'x', trippedAt: 't', clusterName: 'system-db' })) });
    await runWalArchiveTick(db, log, p);
    expect(p.notifyRecovered).not.toHaveBeenCalled();
    expect(p.clearAlerted).not.toHaveBeenCalled();
  });

  it('still alerts when the record cannot be read', async () => {
    const p = ports({ nowIso: () => NOW, readSnapshot: failingFor('2026-11-03T16:30:45Z'),
      readAlerted: vi.fn(async () => { throw new Error('db down'); }) });
    await runWalArchiveTick(db, log, p);
    expect(p.notifyFailing).toHaveBeenCalledTimes(1);
    expect(p.recordAlerted).toHaveBeenCalledTimes(1);
  });

  it('sends no "working again" for a failure that never alerted', async () => {
    const p = ports({ nowIso: () => NOW });
    await runWalArchiveTick(db, log, p);
    expect(p.notifyRecovered).not.toHaveBeenCalled();
    expect(p.clearAlerted).not.toHaveBeenCalled();
  });

  it('drops the record without a notice when archiving was switched off instead', async () => {
    const p = ports({ nowIso: () => NOW, readAlerted: onRecord('2026-11-03T16:30:45Z'),
      readSnapshot: vi.fn(async () => snap({ barmanPluginPresent: false })) });
    await runWalArchiveTick(db, log, p);
    expect(p.notifyRecovered).not.toHaveBeenCalled();
    expect(p.clearAlerted).toHaveBeenCalledTimes(1);
  });

  it('logs, and does not throw, when the record cannot be cleared', async () => {
    const error = vi.fn();
    const p = ports({ nowIso: () => NOW, readAlerted: onRecord('2026-11-03T16:30:45Z'),
      clearAlerted: vi.fn(async () => { throw new Error('db down'); }) });
    await expect(runWalArchiveTick(db, { warn: vi.fn(), error }, p)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});

describe('failedFor', () => {
  it('reads as the sentence does', () => {
    expect(failedFor('2026-11-03T16:30:45Z', '2026-11-03T16:31:00Z')).toBe('1 minute');
    expect(failedFor('2026-11-03T16:30:45Z', '2026-11-03T16:55:45Z')).toBe('25 minutes');
    expect(failedFor('2026-11-03T16:00:00Z', '2026-11-03T18:00:00Z')).toBe('2 hours');
    expect(failedFor('2026-11-03T16:00:00Z', '2026-11-03T19:05:00Z')).toBe('3 hours 5 minutes');
    expect(failedFor('not-a-time', '2026-11-03T19:05:00Z')).toBe('1 minute');
  });
});
