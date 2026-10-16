/**
 * The unread reminder against a real Postgres: which notifications it chases,
 * and what it says about them.
 *
 * Production's reminder said "Email sending at 88% of the hour limit" and
 * nothing else, about a TENANT's notification the operator could not see,
 * read, or act on, for a sending window that had closed two days earlier.
 * Now only the platform admins' own notifications are chased.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getTestDb, isDbAvailable, runMigrations } from '../../../test-helpers/db.js';
import { hostingPlans, notifications, notificationTemplates, regions, tenants, users } from '../../../db/schema.js';
import { seedCategoriesIfMissing } from '../categories/service.js';
import { seedTemplatesIfMissing } from '../templates/seed-loader.js';
import { runOnce } from './scheduler.js';
import { describeCandidates, findEscalationCandidates, isEscalatable, markEscalated } from './service.js';

const skipIntegration = !await isDbAvailable();
const DAY = 86_400_000;

describe.skipIf(skipIntegration)('unread reminder candidates (integration)', () => {
  const uid = crypto.randomUUID().slice(0, 8);
  const regionId = crypto.randomUUID();
  const planId = crypto.randomUUID();
  const tenantId = crypto.randomUUID();
  const tenantUser = crypto.randomUUID();
  const adminA = crypto.randomUUID();
  const adminB = crypto.randomUUID();
  const ids: string[] = [];
  let db: ReturnType<typeof getTestDb>;

  const now = new Date();
  const old = new Date(now.getTime() - 3 * DAY);

  async function notify(o: {
    userId: string; categoryId: string; title: string; message?: string;
    tenantId?: string | null; eventId?: string | null; isRead?: number; createdAt?: Date; escalatedAt?: Date;
  }): Promise<string> {
    const id = crypto.randomUUID();
    ids.push(id);
    await db.insert(notifications).values({
      id,
      userId: o.userId,
      title: o.title,
      message: o.message ?? '',
      categoryId: o.categoryId,
      tenantId: o.tenantId ?? null,
      eventId: o.eventId === undefined ? crypto.randomUUID() : o.eventId,
      isRead: o.isRead ?? 0,
      createdAt: o.createdAt ?? old,
      escalatedAt: o.escalatedAt ?? null,
    });
    return id;
  }

  const mine = async (limit?: number) => (await findEscalationCandidates(db, now, limit))
    .filter((c) => ids.includes(c.id));

  beforeAll(async () => {
    await runMigrations();
    db = getTestDb();
    await seedCategoriesIfMissing(db);
    await db.insert(regions).values({ id: regionId, code: `${uid}-r`, name: `${uid}-region`, provider: 'test', status: 'active' });
    await db.insert(hostingPlans).values({
      id: planId, code: `${uid}-p`, name: `${uid}-plan`, cpuLimit: '1', memoryLimit: '1',
      storageLimit: '2', monthlyPriceUsd: '10.00',
    });
    await db.insert(tenants).values({
      id: tenantId, name: `Acme ${uid}`, primaryEmail: `${uid}@example.test`,
      kubernetesNamespace: `tenant-${uid}`, planId, regionId, status: 'active',
    });
    await db.insert(users).values([
      { id: tenantUser, email: `t-${uid}@example.test`, passwordHash: 'x', fullName: 'T', roleName: 'tenant_admin', panel: 'tenant', status: 'active', tenantId },
      { id: adminA, email: `a-${uid}@example.test`, passwordHash: 'x', fullName: 'A', roleName: 'admin', panel: 'admin', status: 'active' },
      { id: adminB, email: `b-${uid}@example.test`, passwordHash: 'x', fullName: 'B', roleName: 'admin', panel: 'admin', status: 'active' },
    ]);
  });

  afterAll(async () => {
    if (ids.length > 0) await db.delete(notifications).where(inArray(notifications.id, ids));
    await db.delete(notifications).where(inArray(notifications.userId, [tenantUser, adminA, adminB]));
    await db.delete(users).where(inArray(users.id, [tenantUser, adminA, adminB]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantId]));
    await db.delete(hostingPlans).where(inArray(hostingPlans.id, [planId]));
    await db.delete(regions).where(inArray(regions.id, [regionId]));
  });

  // Operator decision: a tenant's notification is the tenant's.
  // Production's 36 reminders were all about tenants' notifications the
  // operator could not see, read, or act on.
  it("never chases a tenant user's notification", async () => {
    const tenants = await Promise.all(['mailbox.quota_threshold', 'subscription.expiry_warning', 'tasks.scheduled_failure']
      .map((categoryId) => notify({ userId: tenantUser, tenantId, categoryId, title: `tenant ${categoryId}` })));
    const unstamped = await notify({ userId: tenantUser, categoryId: 'mailbox.quota_threshold', title: 'tenant, no tenant_id' });
    const got = (await mine()).map((c) => c.id);
    for (const id of [...tenants, unstamped]) expect(got).not.toContain(id);
  });

  it('names the tenant an admin notification is about, and quotes it', async () => {
    const about = await notify({
      userId: adminA, tenantId, categoryId: 'admin.tenant_pod_oom',
      title: 'Tenant workload OOM-killed', message: 'web was killed at its 512 MiB limit:\n• web-1\n• web-2',
    });
    const c = (await mine()).find((x) => x.id === about);
    expect(c).toMatchObject({ tenantName: `Acme ${uid}`, tenantScoped: true });
    expect(describeCandidates([c!])).toEqual([
      `Tenant workload OOM-killed (tenant Acme ${uid}) — unread since ${old.toISOString().slice(0, 10)}. `
      + 'It said: web was killed at its 512 MiB limit: web-1, web-2',
    ]);
  });

  it('never chases a window that closed before 48 h, or a reminder', async () => {
    const abuse = await notify({ userId: adminA, tenantId, categoryId: 'admin.email_abuse_warning', title: 'Send-limit saturation' });
    const reminder = await notify({ userId: adminA, categoryId: 'admin.notification_escalated', title: 'a reminder' });
    const got = (await mine()).map((c) => c.id);
    expect(got).not.toContain(abuse);
    expect(got).not.toContain(reminder);
  });

  it('does not chase an event another admin has read', async () => {
    const seen = crypto.randomUUID();
    const readByA = await notify({ userId: adminA, eventId: seen, isRead: 1, categoryId: 'admin.backup_never_run', title: 'Backups never ran' });
    const unreadByB = await notify({ userId: adminB, eventId: seen, categoryId: 'admin.backup_never_run', title: 'Backups never ran' });
    const unseen = crypto.randomUUID();
    const b1 = await notify({ userId: adminA, eventId: unseen, categoryId: 'admin.backup_never_run', title: 'Backups never ran (2)' });
    const b2 = await notify({ userId: adminB, eventId: unseen, categoryId: 'admin.backup_never_run', title: 'Backups never ran (2)' });
    const got = await mine();
    expect(got.map((c) => c.id)).not.toContain(readByA);
    expect(got.map((c) => c.id)).not.toContain(unreadByB);
    expect(got.map((c) => c.id)).toEqual(expect.arrayContaining([b1, b2]));
    expect(got.find((c) => c.id === b1)).toMatchObject({ tenantName: null, tenantScoped: false });
  });

  it('chases a row from before the event model, which has no event id', async () => {
    const legacy = await notify({ userId: adminA, eventId: null, categoryId: 'admin.backup_never_run', title: `legacy ${uid}` });
    expect((await mine()).map((c) => c.id)).toContain(legacy);
  });

  it('skips the young, the escalated, and every class but Action', async () => {
    const young = await notify({ userId: adminA, categoryId: 'admin.backup_never_run', title: 'young', createdAt: new Date(now.getTime() - DAY) });
    const done = await notify({ userId: adminA, categoryId: 'admin.backup_never_run', title: 'done', escalatedAt: now });
    const ambient = await notify({ userId: adminA, categoryId: 'admin.slo_alert_resolved', title: 'ambient' });
    const got = (await mine()).map((c) => c.id);
    expect(got).not.toContain(young);
    expect(got).not.toContain(done);
    expect(got).not.toContain(ambient);
  });

  it('is not starved by unread rows it will never chase', async () => {
    // Ambient and Record rows, and tenants' rows, are never marked escalated.
    // Filtered after a LIMIT they came back every tick; past the limit, no
    // Action row would ever have been seen again.
    const older = new Date(now.getTime() - 10 * DAY);
    for (let i = 0; i < 20; i += 1) {
      await notify({ userId: adminA, categoryId: 'admin.slo_alert_resolved', title: `noise ${i}`, createdAt: older });
      await notify({ userId: tenantUser, tenantId, categoryId: 'mailbox.quota_threshold', title: `tenant noise ${i}`, createdAt: older });
    }
    const action = await notify({ userId: adminB, categoryId: 'admin.backup_never_run', title: 'after the noise' });
    const all = await findEscalationCandidates(db, now, 10_000);
    expect(all.map((c) => c.id)).toContain(action);
    expect(all.filter((c) => !isEscalatable(c.categoryId))).toEqual([]);
    // Exactly as many rows as there is work: the older noise must not take any.
    const exact = await findEscalationCandidates(db, now, all.length);
    expect(exact.map((c) => c.id)).toContain(action);
  });

  it('marks every copy of an event, even one the row limit left out of the batch', async () => {
    const event = crypto.randomUUID();
    const inBatch = await notify({ userId: adminA, eventId: event, categoryId: 'admin.backup_never_run', title: `split ${uid}` });
    const leftOut = await notify({ userId: adminB, eventId: event, categoryId: 'admin.backup_never_run', title: `split ${uid}` });
    const batch = (await mine()).filter((c) => c.id === inBatch);
    await markEscalated(db, batch, now);
    expect((await mine()).map((c) => c.id)).not.toContain(leftOut);
  });

  describe('the sweep', () => {
    const KEY = process.env.PLATFORM_ENCRYPTION_KEY;
    beforeAll(async () => {
      process.env.PLATFORM_ENCRYPTION_KEY = 'escalation-integration-salt';
      await seedTemplatesIfMissing(db);
    });
    afterAll(async () => {
      if (KEY === undefined) delete process.env.PLATFORM_ENCRYPTION_KEY;
      else process.env.PLATFORM_ENCRYPTION_KEY = KEY;
      await db.update(notificationTemplates).set({ isActive: true })
        .where(eq(notificationTemplates.categoryId, 'admin.notification_escalated'));
    });

    const escalatedAt = async (id: string) => (await db.select({ at: notifications.escalatedAt })
      .from(notifications).where(eq(notifications.id, id)))[0]?.at ?? null;

    it('marks nothing when the reminder reached nobody, then tells the admins and marks every copy', async () => {
      const event = crypto.randomUUID();
      const copy1 = await notify({
        userId: adminA, tenantId, eventId: event, categoryId: 'admin.tenant_pod_oom',
        title: `Tenant workload OOM-killed ${uid}`,
        message: 'web was killed at its 512 MiB limit:\n• web-1\n• web-2',
      });
      const copy2 = await notify({
        userId: adminB, tenantId, eventId: event, categoryId: 'admin.tenant_pod_oom',
        title: `Tenant workload OOM-killed ${uid}`,
        message: 'web was killed at its 512 MiB limit:\n• web-1\n• web-2',
      });

      // No template: every leg is written `skipped` under the batch's key. That
      // is a delivery row, and it told nobody.
      await db.update(notificationTemplates).set({ isActive: false })
        .where(eq(notificationTemplates.categoryId, 'admin.notification_escalated'));
      expect(await runOnce(db, now)).toBe(0);
      expect(await escalatedAt(copy1)).toBeNull();

      // Retried under the next day's key: the dispatcher treats any row under a
      // key — `skipped` included — as already fired, so the same day's key stays spent.
      await db.update(notificationTemplates).set({ isActive: true })
        .where(eq(notificationTemplates.categoryId, 'admin.notification_escalated'));
      expect(await runOnce(db, new Date(now.getTime() + 60_000))).toBe(0);
      expect(await runOnce(db, new Date(now.getTime() + DAY))).toBeGreaterThan(0);
      expect(await escalatedAt(copy1)).not.toBeNull();
      expect(await escalatedAt(copy2)).not.toBeNull();

      const [told] = await db.select({ title: notifications.title, message: notifications.message })
        .from(notifications)
        .where(and(eq(notifications.userId, adminA), eq(notifications.categoryId, 'admin.notification_escalated')))
        .orderBy(desc(notifications.createdAt))
        .limit(1);
      // Two admins' copies are ONE notification: no "x2".
      expect(told.message).toContain(
        `• Tenant workload OOM-killed ${uid} (tenant Acme ${uid}) — unread since ${old.toISOString().slice(0, 10)}. `
        + 'It said: web was killed at its 512 MiB limit: web-1, web-2',
      );
      expect(told.message).toContain('not read by any platform admin');

      // Reported once: nothing of it is left to chase.
      expect((await mine()).map((c) => c.id)).not.toEqual(expect.arrayContaining([copy1]));
    });
  });
});
