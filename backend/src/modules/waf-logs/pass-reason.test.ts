import { describe, expect, it, vi } from 'vitest';
import { createAllowlistCache, resolvePassReason } from './pass-reason.js';

const allowlisted = (ip: string) => ip === '203.0.113.7';
const trusted = (ip: string) => ip === '198.51.100.9';

describe('resolvePassReason', () => {
  it('a refused request has no pass reason, whatever list covers its source', () => {
    expect(resolvePassReason({ interrupted: true, sourceIp: '203.0.113.7', scoreExceeded: true }, { allowlisted, trusted })).toBeNull();
  });

  it('an event whose audit record was not read is not given one either', () => {
    expect(resolvePassReason({ sourceIp: '203.0.113.7' }, { allowlisted, trusted })).toBeNull();
  });

  it('names the platform allowlist first, then the route\'s trusted IPs', () => {
    const both = (ip: string) => ip === '203.0.113.7';
    expect(resolvePassReason({ interrupted: false, sourceIp: '203.0.113.7', scoreExceeded: true }, { allowlisted, trusted: both }))
      .toBe('allowlisted_ip');
    expect(resolvePassReason({ interrupted: false, sourceIp: '198.51.100.9', scoreExceeded: true }, { allowlisted, trusted }))
      .toBe('trusted_ip');
  });

  it('without a list: below the threshold, or not enforced when 949110 was reached', () => {
    const none = { allowlisted: null, trusted: null };
    expect(resolvePassReason({ interrupted: false, sourceIp: '192.0.2.1' }, none)).toBe('below_threshold');
    expect(resolvePassReason({ interrupted: false, sourceIp: '192.0.2.1', scoreExceeded: true }, none)).toBe('not_enforced');
  });

  it('an unknown source address matches no list', () => {
    const all = () => true;
    expect(resolvePassReason({ interrupted: false, sourceIp: '0.0.0.0' }, { allowlisted: all, trusted: all })).toBe('below_threshold');
  });
});

describe('createAllowlistCache', () => {
  it('reads cscli at most once a minute', async () => {
    let now = 0;
    const load = vi.fn(async () => ['203.0.113.0/24']);
    const get = createAllowlistCache(load, () => now);
    expect((await get())?.('203.0.113.7')).toBe(true);
    now = 59_000;
    await get();
    expect(load).toHaveBeenCalledTimes(1);
    now = 61_000;
    await get();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a failed read keeps the last list read', async () => {
    let now = 0;
    const load = vi.fn()
      .mockResolvedValueOnce(['203.0.113.7'])
      .mockRejectedValueOnce(new Error('crowdsec pod not found'));
    const get = createAllowlistCache(load, () => now);
    expect((await get())?.('203.0.113.7')).toBe(true);
    now = 120_000;
    expect((await get())?.('203.0.113.7')).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('answers null on a failed first read and retries on the next call', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('crowdsec pod not found'))
      .mockResolvedValueOnce(['203.0.113.7']);
    const get = createAllowlistCache(load, () => 0);
    expect(await get()).toBeNull();
    expect((await get())?.('203.0.113.7')).toBe(true);
  });
});
