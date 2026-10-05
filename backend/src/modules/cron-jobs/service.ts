import { eq, and, desc, lt, sql, ilike, or } from 'drizzle-orm';
import { cronJobs, tenants } from '../../db/schema.js';
import { getTenantById } from '../tenants/service.js';
import { ApiError, tenantNotFound } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import type { Database } from '../../db/index.js';
import { runAndRecord, type CronSchedulerDeps } from './scheduler.js';
import type { CreateCronJobInput, UpdateCronJobInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';
import {
  CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY,
  failureEmailRecipientMissing,
  type BulkIdResult,
  type CronFailureEmailInfo,
} from '@insula/api-contracts';

export async function createCronJob(db: Database, tenantId: string, input: CreateCronJobInput) {
  await getTenantById(db, tenantId);

  const id = crypto.randomUUID();
  await db.insert(cronJobs).values({
    id,
    tenantId,
    name: input.name,
    type: input.type,
    schedule: input.schedule,
    command: input.command ?? null,
    url: input.url ?? null,
    httpMethod: input.http_method ?? 'GET',
    deploymentId: input.deployment_id ?? null,
    timeoutSeconds: input.timeout_seconds ?? null,
    timezone: input.timezone ?? null,
    enabled: input.enabled ? 1 : 0,
    notifyOnFailure: input.notify_on_failure ?? false,
    notifyTenantEmail: input.notify_tenant_email ?? true,
    notifyEmail: input.notify_email?.trim() || null,
  });

  const [created] = await db.select().from(cronJobs).where(eq(cronJobs.id, id));
  return created;
}

export async function getCronJobById(db: Database, tenantId: string, cronJobId: string) {
  const [job] = await db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.id, cronJobId), eq(cronJobs.tenantId, tenantId)));
  if (!job) {
    throw new ApiError('CRON_JOB_NOT_FOUND', `Cron job '${cronJobId}' not found`, 404, { cron_job_id: cronJobId });
  }
  return job;
}

export type AdminCronJobRow = typeof cronJobs.$inferSelect & { tenantName: string | null };

export async function listAllCronJobs(
  db: Database,
  params: { limit: number; cursor?: string; search?: string },
): Promise<{ data: AdminCronJobRow[]; pagination: PaginationMeta }> {
  const { limit, cursor, search } = params;

  const filters = [];
  if (search) {
    const pattern = `%${search}%`;
    filters.push(or(ilike(cronJobs.name, pattern), ilike(cronJobs.url, pattern), ilike(tenants.name, pattern)));
  }

  const cursorConds = [];
  if (cursor) {
    const decoded = decodeCursor(cursor);
    cursorConds.push(lt(cronJobs.createdAt, new Date(decoded.sort)));
  }

  const allConds = [...filters, ...cursorConds];
  const where = allConds.length > 0 ? and(...allConds) : undefined;

  const rows = await db
    .select({
      id: cronJobs.id,
      tenantId: cronJobs.tenantId,
      name: cronJobs.name,
      type: cronJobs.type,
      schedule: cronJobs.schedule,
      command: cronJobs.command,
      url: cronJobs.url,
      httpMethod: cronJobs.httpMethod,
      deploymentId: cronJobs.deploymentId,
      timeoutSeconds: cronJobs.timeoutSeconds,
      timezone: cronJobs.timezone,
      enabled: cronJobs.enabled,
      lastRunAt: cronJobs.lastRunAt,
      lastRunStatus: cronJobs.lastRunStatus,
      lastRunDurationMs: cronJobs.lastRunDurationMs,
      lastRunResponseCode: cronJobs.lastRunResponseCode,
      lastRunOutput: cronJobs.lastRunOutput,
      notifyOnFailure: cronJobs.notifyOnFailure,
      notifyTenantEmail: cronJobs.notifyTenantEmail,
      notifyEmail: cronJobs.notifyEmail,
      createdAt: cronJobs.createdAt,
      updatedAt: cronJobs.updatedAt,
      tenantName: tenants.name,
    })
    .from(cronJobs)
    .leftJoin(tenants, eq(cronJobs.tenantId, tenants.id))
    .where(where)
    .orderBy(desc(cronJobs.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit) as AdminCronJobRow[];

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'cron_job',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  // Count uses filters only (no cursor) so total_count reflects the
  // full filtered set, not the remaining-after-cursor slice.
  const countWhere = filters.length > 0 ? and(...filters) : undefined;
  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(cronJobs)
    .leftJoin(tenants, eq(cronJobs.tenantId, tenants.id))
    .where(countWhere);

  return {
    data,
    pagination: {
      cursor: nextCursor,
      has_more: hasMore,
      page_size: data.length,
      total_count: Number(countResult?.count ?? 0),
    },
  };
}

export async function listCronJobs(
  db: Database,
  tenantId: string,
  params: { limit: number; cursor?: string },
): Promise<{ data: typeof cronJobs.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor } = params;

  const conditions = [eq(cronJobs.tenantId, tenantId)];
  if (cursor) {
    const decoded = decodeCursor(cursor);
    conditions.push(lt(cronJobs.createdAt, new Date(decoded.sort)));
  }

  const rows = await db
    .select()
    .from(cronJobs)
    .where(and(...conditions))
    .orderBy(desc(cronJobs.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'cron_job',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(cronJobs)
    .where(eq(cronJobs.tenantId, tenantId));

  return {
    data,
    pagination: {
      cursor: nextCursor,
      has_more: hasMore,
      page_size: data.length,
      total_count: Number(countResult?.count ?? 0),
    },
  };
}

export async function updateCronJob(db: Database, tenantId: string, cronJobId: string, input: UpdateCronJobInput) {
  const existing = await getCronJobById(db, tenantId, cronJobId);

  // A PATCH carries only what changed, so "does this job still name somebody
  // to mail?" is a question about the row AFTER the edit — switching the flag
  // on, or unticking the tenant email, can each be fine or not depending on
  // what is already stored.
  if (failureEmailRecipientMissing({
    notifyOnFailure: input.notify_on_failure ?? existing.notifyOnFailure,
    notifyTenantEmail: input.notify_tenant_email ?? existing.notifyTenantEmail,
    notifyEmail: input.notify_email !== undefined ? input.notify_email : existing.notifyEmail,
  })) {
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      'Failure emails need a recipient — tick the tenant email or enter an address',
      400,
      { field: 'notify_email' },
    );
  }

  const updateValues: Record<string, unknown> = {};
  if (input.name !== undefined) updateValues.name = input.name;
  if (input.schedule !== undefined) updateValues.schedule = input.schedule;
  if (input.command !== undefined) updateValues.command = input.command;
  if (input.url !== undefined) updateValues.url = input.url;
  if (input.http_method !== undefined) updateValues.httpMethod = input.http_method;
  if (input.deployment_id !== undefined) updateValues.deploymentId = input.deployment_id;
  if (input.timeout_seconds !== undefined) updateValues.timeoutSeconds = input.timeout_seconds;
  if (input.timezone !== undefined) updateValues.timezone = input.timezone;
  if (input.enabled !== undefined) updateValues.enabled = input.enabled ? 1 : 0;
  if (input.notify_on_failure !== undefined) updateValues.notifyOnFailure = input.notify_on_failure;
  if (input.notify_tenant_email !== undefined) updateValues.notifyTenantEmail = input.notify_tenant_email;
  if (input.notify_email !== undefined) updateValues.notifyEmail = input.notify_email?.trim() || null;

  if (Object.keys(updateValues).length > 0) {
    await db.update(cronJobs).set(updateValues).where(eq(cronJobs.id, cronJobId));
  }

  return getCronJobById(db, tenantId, cronJobId);
}

/**
 * Who "the tenant email" is, as the scheduler will resolve it when a run
 * fails — so the form can show the actual address instead of a label.
 */
export async function getFailureEmailInfo(db: Database, tenantId: string): Promise<CronFailureEmailInfo> {
  const [row] = await db
    .select({ primaryEmail: tenants.primaryEmail })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw tenantNotFound(tenantId);
  return {
    tenantEmail: row.primaryEmail || null,
    maxEmailsPerTenantPerDay: CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY,
  };
}

export async function runCronJobNow(
  db: Database,
  tenantId: string,
  cronJobId: string,
  deps: CronSchedulerDeps = {},
) {
  const job = await getCronJobById(db, tenantId, cronJobId);

  // One execution path for manual and scheduled runs. This used to be a second
  // copy that handled webcron and, for a deployment job, wrote
  // "not yet implemented" into the output while leaving the status at its
  // initial 'success' — so the UI reported a green run of a command that had
  // never been executed.
  //
  // Notifications stay off here: the operator pressing the button is looking at
  // the result already, and a test run should not page the tenant.
  const updated = await runAndRecord(db, job, deps, { notify: false });
  return updated ?? getCronJobById(db, tenantId, cronJobId);
}

export async function deleteCronJob(db: Database, tenantId: string, cronJobId: string) {
  await getCronJobById(db, tenantId, cronJobId);
  await db.delete(cronJobs).where(eq(cronJobs.id, cronJobId));
}

export type BulkCronJobResult = BulkIdResult;

export async function bulkUpdateCronJobEnabled(
  db: Database,
  cronJobIds: readonly string[],
  enabled: boolean,
): Promise<BulkCronJobResult> {
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const id of cronJobIds) {
    try {
      const [job] = await db.select().from(cronJobs).where(eq(cronJobs.id, id));
      if (!job) {
        failed.push({ id, error: 'Cron job not found' });
        continue;
      }
      await db.update(cronJobs).set({ enabled: enabled ? 1 : 0 }).where(eq(cronJobs.id, id));
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }

  return { succeeded, failed };
}

export async function bulkDeleteCronJobs(
  db: Database,
  cronJobIds: readonly string[],
): Promise<BulkCronJobResult> {
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const id of cronJobIds) {
    try {
      const [job] = await db.select().from(cronJobs).where(eq(cronJobs.id, id));
      if (!job) {
        failed.push({ id, error: 'Cron job not found' });
        continue;
      }
      await db.delete(cronJobs).where(eq(cronJobs.id, id));
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }

  return { succeeded, failed };
}
