/**
 * The WAL half of the archive has to be measurable.
 *
 * Operators could see "3 backups, 6 GB" for the platform database and nothing
 * at all about the write-ahead log — which on an active database is a
 * comparable share of the storage bill and is the part that makes a
 * point-in-time restore possible (operator request 2026-09-11). These pin the
 * fold that produces the summary, against the shapes S3 actually returns.
 */

import { describe, it, expect } from 'vitest';
import { accumulateWalObjects } from './service.js';

const seg = (bytes: number, iso: string) => ({ Size: bytes, LastModified: new Date(iso) });

describe('accumulateWalObjects', () => {
  it('counts segments, sums bytes and brackets the time range', () => {
    const r = accumulateWalObjects([
      seg(16_777_216, '2026-09-10T03:00:00Z'),
      seg(16_777_216, '2026-09-11T20:14:31Z'),
      seg(4_194_304, '2026-08-24T19:30:00Z'),
    ]);
    expect(r.segmentCount).toBe(3);
    expect(r.totalBytes).toBe(37_748_736);
    expect(new Date(r.oldest!).toISOString()).toBe('2026-08-24T19:30:00.000Z');
    expect(new Date(r.newest!).toISOString()).toBe('2026-09-11T20:14:31.000Z');
  });

  it('accumulates across pages — a paginated LIST must not reset the totals', () => {
    const acc = accumulateWalObjects([seg(100, '2026-09-01T00:00:00Z')]);
    accumulateWalObjects([seg(200, '2026-09-02T00:00:00Z')], acc);
    accumulateWalObjects([seg(300, '2026-09-03T00:00:00Z')], acc);
    expect(acc.segmentCount).toBe(3);
    expect(acc.totalBytes).toBe(600);
    expect(new Date(acc.newest!).toISOString()).toBe('2026-09-03T00:00:00.000Z');
  });

  it('survives entries with no Size or no LastModified', () => {
    // S3-compatible gateways (the shim included) may omit either field.
    const r = accumulateWalObjects([
      { Size: undefined, LastModified: new Date('2026-09-01T00:00:00Z') },
      { Size: 512, LastModified: undefined },
    ]);
    expect(r.segmentCount).toBe(2);
    expect(r.totalBytes).toBe(512);
    expect(new Date(r.oldest!).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('reports nothing rather than zeros for an empty page', () => {
    const r = accumulateWalObjects([]);
    expect(r.segmentCount).toBe(0);
    expect(r.totalBytes).toBe(0);
    expect(r.oldest).toBeNull();
    expect(r.newest).toBeNull();
  });
});
