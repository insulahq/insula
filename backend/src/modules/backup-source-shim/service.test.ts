import { describe, expect, it, vi } from 'vitest';
import { idleSourceShims, jobFinishedAt, jobStillRunning, needsSourceShim, sourceShimJobLabels, sweepIdleSourceShims, SOURCE_SHIM_IDLE_MS } from './service.js';

describe('needsSourceShim', () => {
  it('reads a bundle on the bound target, or naming none, through the real shim', () => {
    expect(needsSourceShim('t-bound', 't-bound')).toBe(false);
    expect(needsSourceShim(null, 't-bound')).toBe(false);
    expect(needsSourceShim(null, null)).toBe(false);
  });
  it('reads a bundle on any other target through its source shim', () => {
    expect(needsSourceShim('t-old', 't-bound')).toBe(true);
    // Tenant backups bound nowhere now: every stamped bundle is elsewhere.
    expect(needsSourceShim('t-old', null)).toBe(true);
  });
});

describe('sourceShimJobLabels', () => {
  it('labels a Job only when it reads through a source shim', () => {
    expect(sourceShimJobLabels({ sourceShim: null })).toEqual({});
    expect(sourceShimJobLabels({ sourceShim: 'ab12cd34' })).toEqual({ 'insula.host/source-shim': 'ab12cd34' });
  });
});

describe('jobStillRunning', () => {
  it('is false for a Job that completed or failed, by either signal', () => {
    expect(jobStillRunning({ status: { completionTime: '2026-10-27T10:00:00Z' } })).toBe(false);
    expect(jobStillRunning({ status: { conditions: [{ type: 'Complete', status: 'True' }] } })).toBe(false);
    expect(jobStillRunning({ status: { conditions: [{ type: 'Failed', status: 'True' }] } })).toBe(false);
  });
  it('is true for a Job that has not said it finished', () => {
    expect(jobStillRunning({ status: { active: 1 } })).toBe(true);
    expect(jobStillRunning({})).toBe(true);
    expect(jobStillRunning({ status: { conditions: [{ type: 'Failed', status: 'False' }] } })).toBe(true);
  });
});

describe('idleSourceShims', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it('removes a shim idle past the grace with no running reader', () => {
    const out = idleSourceShims([{ id: 'a', name: 'backup-source-a', lastUsedAt: ago(SOURCE_SHIM_IDLE_MS) }], new Set(), now);
    expect(out.map((s) => s.id)).toEqual(['a']);
  });
  it('keeps a shim a running Job reads through, however long ago it was asked for', () => {
    expect(idleSourceShims([{ id: 'a', name: 'n', lastUsedAt: ago(10 * SOURCE_SHIM_IDLE_MS) }], new Set(['a']), now)).toEqual([]);
  });
  it('keeps a shim asked for within the grace', () => {
    expect(idleSourceShims([{ id: 'a', name: 'n', lastUsedAt: ago(SOURCE_SHIM_IDLE_MS - 1000) }], new Set(), now)).toEqual([]);
  });
  it('keeps a shim whose last-used stamp is unreadable', () => {
    expect(idleSourceShims([{ id: 'a', name: 'n', lastUsedAt: null }], new Set(), now)).toEqual([]);
  });
});

describe('jobFinishedAt', () => {
  it('reads the completion time, or the time a Job was marked finished', () => {
    expect(jobFinishedAt({ status: { completionTime: '2026-10-27T10:00:00Z' } })?.toISOString()).toBe('2026-10-27T10:00:00.000Z');
    expect(jobFinishedAt({ status: { conditions: [{ type: 'Failed', status: 'True', lastTransitionTime: '2026-10-27T11:00:00Z' }] } })?.toISOString()).toBe('2026-10-27T11:00:00.000Z');
    expect(jobFinishedAt({ status: { active: 1 } })).toBeNull();
  });
});

describe('sweepIdleSourceShims', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
  const shim = (id: string, lastUsed: string, rv = '7') => ({
    metadata: { name: `backup-source-${id}`, resourceVersion: rv, labels: { 'insula.host/source-shim': id }, annotations: { 'insula.host/last-used': lastUsed } },
  });
  const log = { info: () => undefined, warn: () => undefined } as never;
  function k8s(deployments: unknown[], jobs: unknown[], del = vi.fn(async () => undefined)) {
    return {
      apps: { listNamespacedDeployment: async () => ({ items: deployments }), deleteNamespacedDeployment: del },
      batch: { listJobForAllNamespaces: async () => ({ items: jobs }) },
    } as never;
  }

  it('deletes only the Deployment of an idle shim, against the resourceVersion it read', async () => {
    const del = vi.fn(async () => undefined);
    const r = await sweepIdleSourceShims(k8s([shim('aa', minutesAgo(45), '42')], [], del), log, now);
    expect(r.removed).toEqual(['backup-source-aa']);
    expect(del).toHaveBeenCalledWith(expect.objectContaining({
      name: 'backup-source-aa', namespace: 'platform',
      body: { propagationPolicy: 'Background', preconditions: { resourceVersion: '42' } },
    }));
  });

  it('keeps a shim a restore asked for since it was read (the delete is refused)', async () => {
    const del = vi.fn(async () => { throw Object.assign(new Error('conflict'), { statusCode: 409 }); });
    const r = await sweepIdleSourceShims(k8s([shim('aa', minutesAgo(45))], [], del), log, now);
    expect(r.removed).toEqual([]);
  });

  it('counts the grace from the end of the last Job that read through it', async () => {
    const del = vi.fn(async () => undefined);
    const jobs = [{ metadata: { labels: { 'insula.host/source-shim': 'aa' } }, status: { completionTime: minutesAgo(5) } }];
    const r = await sweepIdleSourceShims(k8s([shim('aa', minutesAgo(300))], jobs, del), log, now);
    expect(r.removed).toEqual([]);
    expect(del).not.toHaveBeenCalled();
  });

  it('keeps a shim a running Job reads through', async () => {
    const jobs = [{ metadata: { labels: { 'insula.host/source-shim': 'aa' } }, status: { active: 1 } }];
    const r = await sweepIdleSourceShims(k8s([shim('aa', minutesAgo(300))], jobs), log, now);
    expect(r.removed).toEqual([]);
  });
});
