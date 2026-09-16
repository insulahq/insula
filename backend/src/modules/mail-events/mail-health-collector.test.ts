import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  queuedMessageCount, queuedMessageList, setUp, setDepth, setPlatformDepth, setDriftAge,
} = vi.hoisted(() => ({
  queuedMessageCount: vi.fn(),
  queuedMessageList: vi.fn(),
  setUp: vi.fn(),
  setDepth: vi.fn(),
  setPlatformDepth: vi.fn(),
  setDriftAge: vi.fn(),
}));

vi.mock('../stalwart-jmap/client.js', () => ({ queuedMessageCount, queuedMessageList }));
vi.mock('../../shared/metrics.js', () => ({
  mailServerUp: { set: setUp },
  mailOutboundQueueDepth: { set: setDepth },
  mailPlatformOriginQueueDepth: { set: setPlatformDepth },
  mailDriftOldestUnresolvedHours: { set: setDriftAge },
}));

import { collectMailHealthOnce } from './mail-health-collector.js';

// db stub. The collector now issues three reads through db.execute:
//   1. presence gate   — COUNT(*) of enabled email domains
//   2. drift age       — MIN(first_detected_at) of unresolved mail_drift_items
//   3. platform domains — only when the queue is above the scan floor
// Serialising the query node is the reliable way to tell them apart: drizzle's
// `sql` chunks are objects, so joining them yields "[object Object]".
function dbWithDomainCount(n: number): { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn().mockImplementation((q: unknown) => {
      let text = '';
      try { text = JSON.stringify(q) ?? ''; } catch { text = String(q); }
      if (text.includes('mail_drift_items')) return Promise.resolve({ rows: [{ hours: null }] });
      if (text.includes('is_system')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ n }] });
    }),
  };
}
const log = { warn: vi.fn() };

beforeEach(() => {
  queuedMessageCount.mockReset();
  queuedMessageList.mockReset().mockResolvedValue([]);
  setUp.mockReset();
  setDepth.mockReset();
  setPlatformDepth.mockReset();
  setDriftAge.mockReset();
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
    // The origin split is unknown too — never 0, which would read as "no
    // platform mail queued" when we simply could not ask.
    expect(setPlatformDepth).toHaveBeenCalledWith(-1);
  });

  it('publishes -1 (unknown, never 0/down) and does not probe when mail is not deployed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await collectMailHealthOnce(dbWithDomainCount(0) as any, log);
    expect(setUp).toHaveBeenCalledWith(-1);
    expect(setDepth).toHaveBeenCalledWith(-1);
    expect(setPlatformDepth).toHaveBeenCalledWith(-1);
    expect(queuedMessageCount).not.toHaveBeenCalled();
  });

  it('leaves gauges untouched on a presence-gate DB error (no false down)', async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error('db down')) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await collectMailHealthOnce(db as any, log);
    expect(setUp).not.toHaveBeenCalled();
    expect(setDepth).not.toHaveBeenCalled();
    expect(setPlatformDepth).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
