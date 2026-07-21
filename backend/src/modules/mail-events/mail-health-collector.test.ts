import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queuedMessageCount, setUp, setDepth } = vi.hoisted(() => ({
  queuedMessageCount: vi.fn(),
  setUp: vi.fn(),
  setDepth: vi.fn(),
}));

vi.mock('../stalwart-jmap/client.js', () => ({ queuedMessageCount }));
vi.mock('../../shared/metrics.js', () => ({
  mailServerUp: { set: setUp },
  mailOutboundQueueDepth: { set: setDepth },
}));

import { collectMailHealthOnce } from './mail-health-collector.js';

// Minimal db stub: mailIsExpected() runs one COUNT(*) via db.execute.
function dbWithDomainCount(n: number): { execute: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn().mockResolvedValue({ rows: [{ n }] }) };
}
const log = { warn: vi.fn() };

beforeEach(() => {
  queuedMessageCount.mockReset();
  setUp.mockReset();
  setDepth.mockReset();
  log.warn.mockReset();
});

describe('collectMailHealthOnce', () => {
  it('publishes up=1 + real depth when mail is expected and reachable', async () => {
    queuedMessageCount.mockResolvedValue(42);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await collectMailHealthOnce(dbWithDomainCount(1) as any, log);
    expect(setUp).toHaveBeenCalledWith(1);
    expect(setDepth).toHaveBeenCalledWith(42);
  });

  it('publishes up=0 + depth=-1 when expected but the probe fails (real outage keeps firing)', async () => {
    queuedMessageCount.mockRejectedValue(new Error('ECONNREFUSED'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await collectMailHealthOnce(dbWithDomainCount(1) as any, log);
    expect(setUp).toHaveBeenCalledWith(0);
    expect(setDepth).toHaveBeenCalledWith(-1);
  });

  it('publishes -1 (unknown, never 0/down) and does not probe when mail is not deployed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await collectMailHealthOnce(dbWithDomainCount(0) as any, log);
    expect(setUp).toHaveBeenCalledWith(-1);
    expect(setDepth).toHaveBeenCalledWith(-1);
    expect(queuedMessageCount).not.toHaveBeenCalled();
  });

  it('leaves gauges untouched on a presence-gate DB error (no false down)', async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error('db down')) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await collectMailHealthOnce(db as any, log);
    expect(setUp).not.toHaveBeenCalled();
    expect(setDepth).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
