import { describe, it, expect, vi } from 'vitest';
import { getCronJobById, updateCronJob, deleteCronJob, createCronJob, getFailureEmailInfo } from './service.js';
import { CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY } from '@insula/api-contracts';
import { ApiError } from '../../shared/errors.js';

vi.mock('../tenants/service.js', () => ({
  getTenantById: vi.fn().mockResolvedValue({ id: 'c1', name: 'Acme' }),
}));

function createMockDb(selectResult: unknown[] = []) {
  const whereFn = vi.fn().mockResolvedValue(selectResult);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
  } as unknown as Parameters<typeof getCronJobById>[0];
}

describe('getCronJobById', () => {
  it('should return cron job when found', async () => {
    const job = { id: 'j1', tenantId: 'c1', name: 'cleanup' };
    const db = createMockDb([job]);

    const result = await getCronJobById(db, 'c1', 'j1');
    expect(result).toEqual(job);
  });

  it('should throw CRON_JOB_NOT_FOUND when not found', async () => {
    const db = createMockDb([]);

    await expect(getCronJobById(db, 'c1', 'missing')).rejects.toThrow(ApiError);
    await expect(getCronJobById(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'CRON_JOB_NOT_FOUND',
      status: 404,
    });
  });
});

describe('updateCronJob', () => {
  it('should update and return cron job', async () => {
    const job = { id: 'j1', tenantId: 'c1', name: 'cleanup' };

    const whereFn = vi.fn().mockResolvedValue([job]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateCronJob>[0];

    const result = await updateCronJob(db, 'c1', 'j1', { name: 'new-name' });
    expect(result).toEqual(job);
    expect(updateFn).toHaveBeenCalled();
  });

  it('should convert enabled boolean to number', async () => {
    const job = { id: 'j1', tenantId: 'c1', name: 'cleanup' };

    const whereFn = vi.fn().mockResolvedValue([job]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateCronJob>[0];

    await updateCronJob(db, 'c1', 'j1', { enabled: false });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ enabled: 0 }));

    await updateCronJob(db, 'c1', 'j1', { enabled: true });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ enabled: 1 }));
  });

  it('should skip update when no fields provided', async () => {
    const job = { id: 'j1', tenantId: 'c1', name: 'cleanup' };

    const whereFn = vi.fn().mockResolvedValue([job]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const updateFn = vi.fn();

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateCronJob>[0];

    const result = await updateCronJob(db, 'c1', 'j1', {});
    expect(result).toEqual(job);
    expect(updateFn).not.toHaveBeenCalled();
  });
});

describe('deleteCronJob', () => {
  it('should delete when cron job exists', async () => {
    const job = { id: 'j1', tenantId: 'c1' };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const whereFn = vi.fn().mockResolvedValue([job]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
      delete: deleteFn,
    } as unknown as Parameters<typeof deleteCronJob>[0];

    await deleteCronJob(db, 'c1', 'j1');
    expect(deleteFn).toHaveBeenCalled();
  });

  it('should throw CRON_JOB_NOT_FOUND when cron job does not exist', async () => {
    const db = createMockDb([]);

    await expect(deleteCronJob(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'CRON_JOB_NOT_FOUND',
    });
  });
});

/** A db whose select() always yields `row`, recording every update().set(). */
function recordingDb(row: Record<string, unknown>) {
  const sets: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const where = vi.fn().mockImplementation(() => Object.assign(Promise.resolve([row]), {
    limit: vi.fn().mockResolvedValue([row]),
  }));
  const db = {
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where }) }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        sets.push(v);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        inserts.push(v);
        return Promise.resolve(undefined);
      }),
    }),
  } as unknown as Parameters<typeof updateCronJob>[0];
  return { db, sets, inserts };
}

describe('failure email settings', () => {
  const stored = {
    id: 'j1', tenantId: 'c1', name: 'cleanup',
    notifyOnFailure: false, notifyTenantEmail: true, notifyEmail: null,
  };

  it('stores the opt-in on create, with a blank extra address as none', async () => {
    const { db, inserts } = recordingDb(stored);
    await createCronJob(db, 'c1', {
      name: 'n', type: 'webcron', schedule: '0 * * * *', url: 'https://example.test/c',
      http_method: 'GET', enabled: true,
      notify_on_failure: true, notify_tenant_email: false, notify_email: 'ops@example.test',
    });
    expect(inserts[0]).toMatchObject({ notifyOnFailure: true, notifyTenantEmail: false, notifyEmail: 'ops@example.test' });

    await createCronJob(db, 'c1', {
      name: 'n', type: 'webcron', schedule: '0 * * * *', url: 'https://example.test/c',
      http_method: 'GET', enabled: true, notify_on_failure: false, notify_tenant_email: true,
    });
    expect(inserts[1]).toMatchObject({ notifyOnFailure: false, notifyTenantEmail: true, notifyEmail: null });
  });

  it('switching it on with the stored defaults mails the tenant email', async () => {
    const { db, sets } = recordingDb(stored);
    await updateCronJob(db, 'c1', 'j1', { notify_on_failure: true });
    expect(sets[0]).toEqual({ notifyOnFailure: true });
  });

  it('clears the extra address with null', async () => {
    const { db, sets } = recordingDb({ ...stored, notifyEmail: 'ops@example.test' });
    await updateCronJob(db, 'c1', 'j1', { notify_email: null });
    expect(sets[0]).toEqual({ notifyEmail: null });
  });

  it('refuses an edit that leaves a switched-on job with nobody to mail', async () => {
    // Judged on the MERGED row: this PATCH only unticks the tenant email, and
    // the stored job has no extra address.
    const { db, sets } = recordingDb({ ...stored, notifyOnFailure: true });
    await expect(updateCronJob(db, 'c1', 'j1', { notify_tenant_email: false })).rejects.toMatchObject({
      code: 'INVALID_FIELD_VALUE',
      status: 400,
      details: { field: 'notify_email' },
    });
    expect(sets).toHaveLength(0);
  });

  it('allows the same edit when the stored job has an extra address', async () => {
    const { db, sets } = recordingDb({ ...stored, notifyOnFailure: true, notifyEmail: 'ops@example.test' });
    await updateCronJob(db, 'c1', 'j1', { notify_tenant_email: false });
    expect(sets[0]).toEqual({ notifyTenantEmail: false });
  });

  it('getFailureEmailInfo returns the tenant email the scheduler will use, and the cap', async () => {
    const { db } = recordingDb({ primaryEmail: 'owner@example.test' });
    await expect(getFailureEmailInfo(db, 'c1')).resolves.toEqual({
      tenantEmail: 'owner@example.test',
      maxEmailsPerTenantPerDay: CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY,
    });
  });
});
