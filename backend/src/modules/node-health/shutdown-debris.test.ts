import { describe, it, expect } from 'vitest';
import {
  selectShutdownDebris,
  DEBRIS_GRACE_MS,
  type DebrisPod,
} from './shutdown-debris.js';

const NOW = Date.parse('2026-09-11T14:00:00Z');
const OLD = '2026-09-11T12:00:00Z'; // 2h — past the grace window
const FRESH = '2026-09-11T13:50:00Z'; // 10m — inside it

function pod(o: Partial<{
  name: string; ns: string; phase: string; reason: string;
  created: string; owned: boolean; labels: Record<string, string>;
  deletionTimestamp: string;
}> = {}): DebrisPod {
  return {
    metadata: {
      name: o.name ?? 'tigera-operator-6945c48d88-297q2',
      namespace: o.ns ?? 'tigera-operator',
      creationTimestamp: o.created ?? OLD,
      ...(o.deletionTimestamp ? { deletionTimestamp: o.deletionTimestamp } : {}),
      ownerReferences: (o.owned ?? true) ? [{ controller: true }] : [],
      ...(o.labels ? { labels: o.labels } : {}),
    },
    status: {
      phase: o.phase ?? 'Failed',
      // 'reason' in o — so a test can assert on a pod with NO reason at all;
      // `?? 'NodeShutdown'` would silently substitute the default.
      reason: 'reason' in o ? o.reason : 'NodeShutdown',
    },
  };
}

describe('selectShutdownDebris', () => {
  // ── what it MUST reap ──

  it('reaps a pod rejected because the node was shutting down', () => {
    // "Pod was rejected as the node is shutting down." Never ran a container.
    expect(selectShutdownDebris([pod()], NOW)).toEqual([
      { namespace: 'tigera-operator', name: 'tigera-operator-6945c48d88-297q2' },
    ]);
  });

  it('reaps a pod terminated by the node shutdown', () => {
    // "Pod was terminated in response to imminent node shutdown."
    const out = selectShutdownDebris([pod({ reason: 'Terminated' })], NOW);
    expect(out).toHaveLength(1);
  });

  it('reaps debris in a TENANT namespace', () => {
    // Deliberately wider than recovery.ts's operator action: these records are
    // what poisoned the per-tenant OOM alerts, and the Deployment has already
    // replaced them.
    const out = selectShutdownDebris(
      [pod({ ns: 'tenant-acme-1234', name: 'app-579c57db7b-6xjnz', reason: 'Terminated' })],
      NOW,
    );
    expect(out).toEqual([{ namespace: 'tenant-acme-1234', name: 'app-579c57db7b-6xjnz' }]);
  });

  it('reaps the whole flood from one reboot', () => {
    const flood = Array.from({ length: 20 }, (_, i) => pod({ name: `tigera-operator-x-${i}` }));
    expect(selectShutdownDebris(flood, NOW)).toHaveLength(20);
  });

  // ── what it must NEVER touch ──

  it('never touches a Running pod', () => {
    expect(selectShutdownDebris([pod({ phase: 'Running' })], NOW)).toEqual([]);
  });

  it('never touches a Succeeded pod', () => {
    expect(selectShutdownDebris([pod({ phase: 'Succeeded', reason: 'Completed' })], NOW)).toEqual([]);
  });

  it('never touches a Failed pod that is NOT shutdown debris', () => {
    // An Evicted pod or a crashed Job is a real signal — left to the operator.
    expect(selectShutdownDebris([pod({ reason: 'Evicted' })], NOW)).toEqual([]);
    expect(selectShutdownDebris([pod({ reason: undefined })], NOW)).toEqual([]);
  });

  it('never touches a bare (uncontrolled) pod — nothing would replace it', () => {
    expect(selectShutdownDebris([pod({ owned: false })], NOW)).toEqual([]);
  });

  it('never touches a CNPG Postgres instance pod', () => {
    const out = selectShutdownDebris(
      [pod({ ns: 'platform', name: 'system-db-1', labels: { 'cnpg.io/instanceName': 'system-db-1' } })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('never touches a pod already being deleted', () => {
    expect(selectShutdownDebris([pod({ deletionTimestamp: OLD })], NOW)).toEqual([]);
  });

  // ── the age guard ──

  it('leaves fresh debris alone so a post-reboot look still shows it', () => {
    expect(selectShutdownDebris([pod({ created: FRESH })], NOW)).toEqual([]);
  });

  it('reaps it once the grace window has passed', () => {
    const justOver = NOW - DEBRIS_GRACE_MS - 1000;
    const out = selectShutdownDebris(
      [pod({ created: new Date(justOver).toISOString() })],
      NOW,
    );
    expect(out).toHaveLength(1);
  });

  it('ignores a pod with an unparseable creation timestamp', () => {
    expect(selectShutdownDebris([pod({ created: 'not-a-date' })], NOW)).toEqual([]);
  });
});
