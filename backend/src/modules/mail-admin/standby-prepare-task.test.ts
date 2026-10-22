import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import { systemSettings, tasks } from '../../db/schema.js';

const taskService = vi.hoisted(() => ({
  start: vi.fn(async (_db: unknown, _args: Record<string, unknown>) => ({ id: '11111111-1111-4111-8111-111111111111', idempotent: false })),
  progress: vi.fn(async (_db: unknown, _id: string, _args: Record<string, unknown>) => undefined),
  finish: vi.fn(async (_db: unknown, _id: string, _args: Record<string, unknown>) => undefined),
}));
vi.mock('../tasks/service.js', () => taskService);

import {
  STANDBY_PREPARE_KIND,
  advanceStandbyPrepareTasks,
  copyingVerdict,
  enrollStandbyPrepareTasks,
  finishStandbyPrepareOnReport,
  judgeStandbyPrepare,
  recordStandbyCopyProgress,
  standbyPrepareRefId,
  standbyPrepareTasksFor,
  type StandbyPrepareInput,
} from './standby-prepare-task.js';
import { copierStateByNode } from './standby-since.js';

/**
 * A node that becomes a mail standby copies the whole store before it reports.
 * Its task follows that copy and must say what the standby check says:
 * preparing while the copier runs, failed once it does not, done on the
 * first complete report.
 */
const SINCE = '2026-01-01T10:00:00.000Z';
const at = (min: number) => Date.parse(SINCE) + min * 60_000;
const base: StandbyPrepareInput = {
  node: 'n2', since: SINCE, now: at(3), stillStandby: true, activeNode: 'n1',
  report: null, copier: { running: true, reason: null }, nodeReady: true, expectedBytes: 44e9,
};

describe('judgeStandbyPrepare', () => {
  it('copying: the copier runs, no percentage it cannot know, the expected size', () => {
    const v = judgeStandbyPrepare(base);
    expect(v).toMatchObject({ status: 'running', pct: null });
    expect(v.text).toBe('Copying the mail store to n2: 3 min so far, about 44.0 GB in all');
    expect(v.steps.map((s) => s.state)).toEqual(['done', 'done', 'running']);
  });

  it('a report from before it became a standby again is not its first copy', () => {
    const v = judgeStandbyPrepare({ ...base, report: { sizeBytes: 1, fileCount: 1, durationSeconds: 1, reportedAt: '2026-01-01T09:00:00.000Z' } });
    expect(v.status).toBe('running');
  });

  it('done on the first report after it became a standby', () => {
    const v = judgeStandbyPrepare({ ...base, report: { sizeBytes: 44_100_000_000, fileCount: 123456, durationSeconds: 590, reportedAt: '2026-01-01T10:10:00.000Z' } });
    expect(v).toMatchObject({ status: 'succeeded' });
    expect(v.text).toContain('44.1 GB, 123,456 files');
    expect(v.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(v.steps[2].note).toBe('Took 10 min');
  });

  it('waiting for the copier to start, with Kubernetes\' reason', () => {
    const v = judgeStandbyPrepare({ ...base, copier: { running: false, reason: 'ContainerCreating' } });
    expect(v).toMatchObject({ status: 'running', pct: 10, text: 'Waiting for the standby copier on n2 to start' });
    expect(v.steps[1]).toMatchObject({ state: 'running', note: 'ContainerCreating — given 10 min to start' });
  });

  it('fails at once when the copier is not running past its start window, saying why', () => {
    const v = judgeStandbyPrepare({ ...base, now: at(11), copier: { running: false, reason: 'ImagePullBackOff: back-off pulling image' } });
    expect(v).toMatchObject({ status: 'failed', text: 'The standby copier did not start' });
    expect(v.status === 'failed' && v.error).toBe('The standby copier on n2 is not running 11 min after the node became a standby: ImagePullBackOff: back-off pulling image.');
    expect(v.steps.map((s) => s.state)).toEqual(['done', 'failed', 'pending']);
  });

  it('a node that is down is named as the reason', () => {
    const v = judgeStandbyPrepare({ ...base, now: at(11), nodeReady: false, copier: { running: false, reason: 'pod Pending' } });
    expect(v.status === 'failed' && v.error).toContain(': the node is not ready.');
  });

  it('fails a first copy still running after the grace', () => {
    const v = judgeStandbyPrepare({ ...base, now: at(6 * 60 + 1) });
    expect(v).toMatchObject({ status: 'failed', text: 'First copy not finished in time' });
    expect(v.status === 'failed' && v.error).toContain('has not finished 6 h after it became a standby.');
  });

  it('an unreadable copier is no claim either way', () => {
    const v = judgeStandbyPrepare({ ...base, now: at(30), copier: null });
    expect(v).toMatchObject({ status: 'running', text: 'Preparing the standby on n2' });
  });

  it('mail moved onto the node ("Move now" labels the new primary first): cancelled and cleared', () => {
    expect(judgeStandbyPrepare({ ...base, stillStandby: false, activeNode: 'n2' }))
      .toMatchObject({ status: 'cancelled', clear: true, text: 'Not needed: mail now runs on n2' });
  });

  it('de-elected before its copy finished: cancelled, left in view', () => {
    expect(judgeStandbyPrepare({ ...base, stillStandby: false }))
      .toMatchObject({ status: 'cancelled', clear: false, text: 'n2 is no longer a mail standby' });
  });
});

describe('standbyPrepareRefId', () => {
  it('fits ref_id (varchar 64) for any node name, and is one per standby stint', () => {
    const long = `${'a'.repeat(60)}.cluster.example.test`;
    expect(standbyPrepareRefId(long, SINCE)).toHaveLength(64);
    expect(standbyPrepareRefId('n2', SINCE)).toBe(standbyPrepareRefId('n2', SINCE));
    expect(standbyPrepareRefId('n2', SINCE)).not.toBe(standbyPrepareRefId('n2', '2026-01-02T10:00:00.000Z'));
  });
});

describe('copierStateByNode', () => {
  it('finds an unscheduled DaemonSet pod by its node field selector, and why it waits', () => {
    const states = copierStateByNode([
      {
        spec: { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', values: ['n3'] }] }],
        } } } },
        status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/3 nodes are available' }] },
      },
      { spec: { nodeName: 'n2' }, status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] } },
      { spec: { nodeName: 'n1' }, status: { phase: 'Running', containerStatuses: [{ state: { running: {} } }] } },
    ]);
    expect(states.get('n3')).toEqual({ running: false, reason: 'Unschedulable: 0/3 nodes are available' });
    expect(states.get('n2')).toEqual({ running: false, reason: 'ImagePullBackOff' });
    expect(states.get('n1')).toEqual({ running: true, reason: null });
  });
});

describe('enrollStandbyPrepareTasks', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("an operator's save goes in their chip; a start-up or DR one is a system task", async () => {
    const db = {} as Database;
    const out = await enrollStandbyPrepareTasks(db, [{ node: 'n2', since: SINCE }], { userId: 'u1' });
    expect(out).toEqual([{ node: 'n2', taskId: '11111111-1111-4111-8111-111111111111' }]);
    expect(taskService.start).toHaveBeenCalledWith(db, expect.objectContaining({
      kind: STANDBY_PREPARE_KIND,
      refId: standbyPrepareRefId('n2', SINCE),
      scope: 'admin',
      userId: 'u1',
      label: 'Prepare the mail standby on n2',
      target: { type: 'modal', modal: 'mail-operation', modalProps: { node: 'n2' } },
      details: expect.objectContaining({ node: 'n2', since: SINCE }),
    }));
    await enrollStandbyPrepareTasks(db, [{ node: 'n3', since: SINCE }], { userId: null });
    expect(taskService.start.mock.calls[1][1]).toMatchObject({ scope: 'system', userId: null });
  });

  it('a task that cannot be written does not fail the save', async () => {
    taskService.start.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.fn();
    await expect(enrollStandbyPrepareTasks({} as Database, [{ node: 'n2', since: SINCE }], { userId: 'u1' }, { warn }))
      .resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ node: 'n2' }), expect.stringContaining('could not record'));
  });
});

/** A database answering the three reads the watch makes: running tasks, the reports, the active node. */
function fakeDb(state: {
  readonly running: Array<{ id: string; status?: string; userId?: string | null; details: Record<string, unknown>; progressText: string | null }>;
  readonly reports?: Record<string, unknown>;
  readonly active?: string | null;
  readonly refs?: Array<{ id: string; refId: string; details?: Record<string, unknown> }>;
}): Database {
  return {
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => {
        const rows = table === tasks
          ? ('refId' in fields ? state.refs ?? [] : state.running.map((r) => ({ status: 'running', userId: 'u1', ...r })))
          : table === systemSettings && 'reports' in fields
            ? [{ reports: state.reports ?? {} }]
            : [{ active: state.active ?? null }];
        const where = vi.fn(() => Object.assign(Promise.resolve(rows), { limit: vi.fn(async () => rows) }));
        return { where };
      }),
    })),
  } as unknown as Database;
}

const node = (name: string, opts: { standby?: boolean; since?: string; ready?: boolean } = {}) => ({
  metadata: {
    name,
    labels: opts.standby === false ? {} : { 'insula.host/mail-standby': 'true' },
    annotations: { 'insula.host/mail-standby-since': opts.since ?? SINCE },
  },
  status: { conditions: [{ type: 'Ready', status: opts.ready === false ? 'False' : 'True' }] },
});
const runningPod = (name: string) => ({ spec: { nodeName: name }, status: { phase: 'Running', containerStatuses: [{ state: { running: {} } }] } });

describe('advanceStandbyPrepareTasks', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const task = (progressText: string | null = null, steps?: unknown) => ({
    id: 't1', details: { node: 'n2', since: SINCE, ...(steps ? { steps } : {}) }, progressText,
  });

  it('no running task: reads nothing from the cluster', async () => {
    const listNodes = vi.fn(async () => []);
    expect(await advanceStandbyPrepareTasks(fakeDb({ running: [] }), { listNodes, listCopierPods: async () => [] }, at(3))).toBe(0);
    expect(listNodes).not.toHaveBeenCalled();
  });

  it('a report under the hostname (as the health view reads it) finishes the task too', async () => {
    const n = node('n2');
    const withHost = { ...n, metadata: { ...n.metadata, labels: { ...n.metadata.labels, 'kubernetes.io/hostname': 'n2.example.test' } } };
    await advanceStandbyPrepareTasks(fakeDb({
      running: [task()],
      reports: { 'n2.example.test': { sizeBytes: 44e9, fileCount: 1, durationSeconds: 600, reportedAt: '2026-01-01T10:10:00.000Z' } },
    }), { listNodes: async () => [withHost], listCopierPods: async () => [runningPod('n2')] }, at(12));
    expect(taskService.finish).toHaveBeenCalledWith(expect.anything(), 't1', expect.objectContaining({ status: 'succeeded' }));
  });

  // The check recomputes every time; the task must not stay red beside a green check.
  it('a failed task whose copier runs again is re-opened, keeping its id and owner', async () => {
    await advanceStandbyPrepareTasks(fakeDb({ running: [{ ...task(), status: 'failed', userId: 'u7' }] }),
      { listNodes: async () => [node('n2')], listCopierPods: async () => [runningPod('n2')] }, at(30));
    expect(taskService.start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      refId: standbyPrepareRefId('n2', SINCE), scope: 'admin', userId: 'u7',
    }));
    expect(taskService.progress).toHaveBeenCalledWith(expect.anything(), 't1', expect.objectContaining({ expectStatus: ['running'] }));
  });

  it('a failed task whose copier still does not run is left as it is', async () => {
    await advanceStandbyPrepareTasks(fakeDb({ running: [{ ...task(), status: 'failed' }] }),
      { listNodes: async () => [node('n2')], listCopierPods: async () => [] }, at(30));
    expect(taskService.start).not.toHaveBeenCalled();
    expect(taskService.progress).not.toHaveBeenCalled();
    expect(taskService.finish).not.toHaveBeenCalled();
  });

  it('writes progress once — the same state read back (JSONB reorders keys) is not written again', async () => {
    const cluster = { listNodes: async () => [node('n2')], listCopierPods: async () => [runningPod('n2')] };
    await advanceStandbyPrepareTasks(fakeDb({ running: [task()], reports: { n1: { sizeBytes: 44e9, fileCount: 1, durationSeconds: 1, reportedAt: '2026-01-01T09:58:00.000Z' } } }), cluster, at(3));
    expect(taskService.progress).toHaveBeenCalledTimes(1);
    const written = taskService.progress.mock.calls[0][2] as { text: string; expectStatus: string[]; detailsPatch: { steps: Array<Record<string, unknown>> } };
    // Guarded: a task the report route finished meanwhile is not set back to "Copying…".
    expect(written.expectStatus).toEqual(['queued', 'running']);
    expect(written.text).toBe('Copying the mail store to n2: 3 min so far, about 44.0 GB in all');
    // Read back with the keys in JSONB's order (shorter keys first).
    const reordered = written.detailsPatch.steps.map(({ name, state, note }) => ({ ...(note ? { note } : {}), name, state }));
    await advanceStandbyPrepareTasks(fakeDb({ running: [task(written.text, reordered)], reports: { n1: { sizeBytes: 44e9, fileCount: 1, durationSeconds: 1, reportedAt: '2026-01-01T09:58:00.000Z' } } }), cluster, at(3));
    expect(taskService.progress).toHaveBeenCalledTimes(1);
  });

  it('a node whose copier has no pod fails past the start window, naming that', async () => {
    await advanceStandbyPrepareTasks(fakeDb({ running: [task()] }), { listNodes: async () => [node('n2')], listCopierPods: async () => [] }, at(12));
    expect(taskService.finish).toHaveBeenCalledWith(expect.anything(), 't1', expect.objectContaining({
      status: 'failed', error: expect.stringContaining('no copier pod on the node yet'),
    }));
  });

  it('a node that lost the label — or was labelled again since — is no longer this stint', async () => {
    await advanceStandbyPrepareTasks(fakeDb({ running: [task()], active: 'n1' }), {
      listNodes: async () => [node('n2', { since: '2026-01-01T11:00:00.000Z' })], listCopierPods: async () => [],
    }, at(3));
    expect(taskService.finish).toHaveBeenCalledWith(expect.anything(), 't1', expect.objectContaining({ status: 'cancelled', clearImmediately: false }));
  });

  it('without the node list it claims nothing', async () => {
    await expect(advanceStandbyPrepareTasks(fakeDb({ running: [task()] }), {
      listNodes: async () => { throw new Error('forbidden'); }, listCopierPods: async () => [],
    }, at(3))).rejects.toThrow('forbidden');
    expect(taskService.finish).not.toHaveBeenCalled();
    expect(taskService.progress).not.toHaveBeenCalled();
  });
});

describe('finishStandbyPrepareOnReport', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("the node's first complete report finishes its task at once", async () => {
    const db = fakeDb({ running: [{ id: 't1', details: { node: 'n2', since: SINCE }, progressText: null }] });
    await finishStandbyPrepareOnReport(db, 'n2', { sizeBytes: 44e9, fileCount: 10, durationSeconds: 600, reportedAt: '2026-01-01T10:10:00.000Z' });
    expect(taskService.finish).toHaveBeenCalledWith(db, 't1', expect.objectContaining({ status: 'succeeded' }));
  });

  it('a task that failed (the copier started late) is finished as done when the copy arrives after all', async () => {
    const db = fakeDb({ running: [{ id: 't1', status: 'failed', details: { node: 'n2', since: SINCE }, progressText: null }] });
    await finishStandbyPrepareOnReport(db, 'n2', { sizeBytes: 44e9, fileCount: 10, durationSeconds: 600, reportedAt: '2026-01-01T11:00:00.000Z' });
    expect(taskService.finish).toHaveBeenCalledWith(db, 't1', expect.objectContaining({ status: 'succeeded', expectStatus: ['failed'] }));
  });
});

describe('standbyPrepareTasksFor', () => {
  it('maps each preparing standby to its task, and how far its copy is', async () => {
    const db = fakeDb({ running: [], refs: [
      { id: 't9', refId: standbyPrepareRefId('n2', SINCE), details: { copy: { bytes: 2e10, percent: 47.6, at: SINCE, startedAt: SINCE } } },
      { id: 't8', refId: standbyPrepareRefId('n3', SINCE), details: {} },
    ] as never });
    const ids = await standbyPrepareTasksFor(db, [{ node: 'n2', since: SINCE }, { node: 'n3', since: SINCE }, { node: 'n4', since: SINCE }]);
    expect([...ids]).toEqual([['n2', { taskId: 't9', copyPercent: 47 }], ['n3', { taskId: 't8' }]]);
  });
});

// The copier posts its overall progress every 15 s during a first copy
// (standby-replicate.sh): the task shows the percentage and the time left.
describe('copy progress', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const copy = (percent: number, bytes: number, startedMin: number, atMin: number) => ({
    bytes, percent, startedAt: new Date(at(startedMin)).toISOString(), at: new Date(at(atMin)).toISOString(),
  });

  it('the percentage, what has been copied, and the time left at the rate so far', () => {
    const v = copyingVerdict('n2', copy(40, 17.6e9, 2, 10), at(10));
    expect(v).toMatchObject({ status: 'running', pct: 40 });
    // 8 min for 40% → 12 min for the other 60%.
    expect(v.text).toBe('Copying the mail store to n2: 40%, 17.6 GB so far, about 12 min left');
  });

  it('no time left until there is a rate to go by', () => {
    expect(copyingVerdict('n2', copy(1, 0.4e9, 2, 4), at(4)).text).toBe('Copying the mail store to n2: 1%, 400 MB so far');
    expect(copyingVerdict('n2', copy(30, 9e9, 2, 2.5), at(2.5)).text).toBe('Copying the mail store to n2: 30%, 9.0 GB so far');
  });

  it('copied is not done: 99% until the copy is promoted and reported', () => {
    expect(copyingVerdict('n2', copy(100, 44e9, 2, 12), at(12))).toMatchObject({ pct: 99, text: 'Finishing the first copy on n2: 44.0 GB copied' });
  });

  it('says so when progress stops coming', () => {
    expect(copyingVerdict('n2', copy(40, 17.6e9, 2, 10), at(15)).text).toMatch(/ — no progress reported for 5 min$/);
  });

  it('the watch keeps the reported progress (and writes nothing between posts)', () => {
    const c = copy(40, 17.6e9, 2, 10);
    const v = judgeStandbyPrepare({ ...base, now: at(10.2), copy: c });
    expect(v).toMatchObject({ status: 'running', pct: 40, text: 'Copying the mail store to n2: 40%, 17.6 GB so far, about 12 min left' });
    expect(judgeStandbyPrepare({ ...base, now: at(11), copy: c }).text).toBe(v.text);
  });

  it('fresh progress is the copier running — whatever a pod list read at another moment says', () => {
    expect(judgeStandbyPrepare({ ...base, now: at(10.5), copier: null, copy: copy(40, 1e9, 2, 10) })).toMatchObject({ pct: 40 });
    expect(judgeStandbyPrepare({ ...base, now: at(11.5), copier: { running: false, reason: 'no copier pod on the node yet' }, copy: copy(40, 1e9, 2, 10) }))
      .toMatchObject({ status: 'running', pct: 40 });
  });

  it('stale progress is no claim: an unreadable copier is preparing, a stopped one fails', () => {
    expect(judgeStandbyPrepare({ ...base, now: at(30), copier: null, copy: copy(40, 1e9, 2, 10) }).text).toBe('Preparing the standby on n2');
    expect(judgeStandbyPrepare({ ...base, now: at(30), copier: { running: false, reason: 'CrashLoopBackOff' }, copy: copy(40, 1e9, 2, 10) }).status).toBe('failed');
  });

  it('a post goes into the running task at once, keeping when the copy started', async () => {
    const db = fakeDb({ running: [{ id: 't1', details: { node: 'n2', since: SINCE, copy: copy(38, 16.7e9, 2, 9.75) }, progressText: null }] });
    expect(await recordStandbyCopyProgress(db, 'n2', { bytes: 17.6e9, percent: 40 }, at(10))).toBe(1);
    expect(taskService.progress).toHaveBeenCalledWith(db, 't1', expect.objectContaining({
      pct: 40,
      text: 'Copying the mail store to n2: 40%, 17.6 GB so far, about 12 min left',
      expectStatus: ['queued', 'running'],
      detailsPatch: expect.objectContaining({ copy: { bytes: 17.6e9, percent: 40, at: new Date(at(10)).toISOString(), startedAt: new Date(at(2)).toISOString() } }),
    }));
  });

  it('a copy that went quiet or started over is timed afresh', async () => {
    const quiet = fakeDb({ running: [{ id: 't1', details: { node: 'n2', since: SINCE, copy: copy(30, 4e9, 2, 4) }, progressText: null }] });
    await recordStandbyCopyProgress(quiet, 'n2', { bytes: 5e9, percent: 35 }, at(20));
    const restarted = fakeDb({ running: [{ id: 't1', details: { node: 'n2', since: SINCE, copy: copy(60, 4e9, 2, 10) }, progressText: null }] });
    await recordStandbyCopyProgress(restarted, 'n2', { bytes: 1e9, percent: 12 }, at(10.2));
    for (const call of taskService.progress.mock.calls) {
      const c = (call[2] as { detailsPatch: { copy: { startedAt: string; at: string } } }).detailsPatch.copy;
      expect(c.startedAt).toBe(c.at);
    }
  });

  it('while posts keep coming the watch leaves the copying text to them', async () => {
    const cluster = { listNodes: async () => [node('n2')], listCopierPods: async () => [runningPod('n2')] };
    await advanceStandbyPrepareTasks(fakeDb({ running: [{ id: 't1', details: { node: 'n2', since: SINCE, copy: copy(40, 4e9, 2, 10) }, progressText: 'older' }] }), cluster, at(10.3));
    expect(taskService.progress).not.toHaveBeenCalled();
    // Gone quiet: the watch says so.
    await advanceStandbyPrepareTasks(fakeDb({ running: [{ id: 't1', details: { node: 'n2', since: SINCE, copy: copy(40, 4e9, 2, 10) }, progressText: 'older' }] }), cluster, at(15));
    expect((taskService.progress.mock.calls[0][2] as { text: string }).text).toMatch(/no progress reported for 5 min/);
  });

  it('the first post starts the clock; a failed task is left for the watch', async () => {
    const db = fakeDb({ running: [
      { id: 't1', details: { node: 'n2', since: SINCE }, progressText: null },
      { id: 't2', status: 'failed', details: { node: 'n2', since: SINCE }, progressText: null },
    ] });
    expect(await recordStandbyCopyProgress(db, 'n2', { bytes: 0, percent: 0 }, at(3))).toBe(1);
    const patch = (taskService.progress.mock.calls[0][2] as { detailsPatch: { copy: { startedAt: string; at: string } } }).detailsPatch.copy;
    expect(patch.startedAt).toBe(patch.at);
  });
});
