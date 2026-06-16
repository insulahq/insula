import { describe, it, expect, vi } from 'vitest';
import {
  readJobToleratingEarlyAbsence,
  JOB_VISIBILITY_GRACE_MS,
  type JobReader,
  type JobStatusLite,
} from './k8s-job-wait.js';

function notFound(): Error {
  // v1 @kubernetes/client-node shape: ApiException with `.code`.
  return Object.assign(new Error('HTTP-Code: 404'), { code: 404 });
}

function reader(impl: () => Promise<JobStatusLite>): JobReader {
  return { readNamespacedJob: vi.fn(impl) };
}

describe('readJobToleratingEarlyAbsence', () => {
  it('returns the Job when the read succeeds', async () => {
    const job: JobStatusLite = { status: { succeeded: 1 } };
    const r = reader(async () => job);
    await expect(readJobToleratingEarlyAbsence(r, 'snap-x', 'ns', 1_000, () => 2_000))
      .resolves.toBe(job);
  });

  it('returns null on a 404 within the grace window (propagation race)', async () => {
    const r = reader(async () => { throw notFound(); });
    const createdAt = 10_000;
    const now = () => createdAt + JOB_VISIBILITY_GRACE_MS - 1; // still inside grace
    await expect(readJobToleratingEarlyAbsence(r, 'snap-x', 'ns', createdAt, now))
      .resolves.toBeNull();
  });

  it('throws a clear error on a 404 after the grace window elapses', async () => {
    const r = reader(async () => { throw notFound(); });
    const createdAt = 10_000;
    const now = () => createdAt + JOB_VISIBILITY_GRACE_MS + 5_000; // past grace
    await expect(readJobToleratingEarlyAbsence(r, 'snap-x', 'ns', createdAt, now))
      .rejects.toThrow(/not found .* after creation/);
  });

  it('re-throws non-404 read errors immediately, even within grace', async () => {
    const boom = Object.assign(new Error('HTTP-Code: 500'), { code: 500 });
    const r = reader(async () => { throw boom; });
    await expect(readJobToleratingEarlyAbsence(r, 'snap-x', 'ns', 0, () => 1))
      .rejects.toBe(boom);
  });

  it('treats the v0 SDK statusCode shape as 404 too', async () => {
    const r = reader(async () => { throw Object.assign(new Error('not found'), { statusCode: 404 }); });
    await expect(readJobToleratingEarlyAbsence(r, 'snap-x', 'ns', 0, () => JOB_VISIBILITY_GRACE_MS - 1))
      .resolves.toBeNull();
  });
});
