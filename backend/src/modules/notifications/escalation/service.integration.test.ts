/**
 * The unread-reminder query against a real Postgres: which notifications it
 * chases, and that it can say whose they are.
 *
 * Production's reminder said "Email sending at 88% of the hour limit" and
 * nothing else — no tenant, no mailbox — about a tenant's notification the
 * operator could not see anywhere, for a sending window that had closed two
 * days earlier.
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
  const tenantUser2 = crypto.randomUUID();
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
      { id: tenantUser2, email: `t2-${uid}@example.test`, passwordHash: 'x', fullName: 'T2', roleName: 'tenant_admin', panel: 'tenant', status: 'active', tenantId },
      { id: adminA, email: `a-${uid}@example.test`, passwordHash: 'x', fullName: 'A', roleName: 'admin', panel: 'admin', status: 'active' },
      { id: adminB, email: `b-${uid}@example.test`, passwordHash: 'x', fullName: 'B', roleName: 'admin', panel: 'admin', status: 'active' },
    ]);
  });

  afterAll(async () => {
    if (ids.length > 0) await db.delete(notifications).where(inArray(notifications.id, ids));
    await db.delete(notifications).where(inArray(notifications.userId, [tenantUser, tenantUser2, adminA, adminB]));
    await db.delete(users).where(inArray(users.id, [tenantUser, tenantUser2, adminA, adminB]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantId]));
    await db.delete(hostingPlans).where(inArray(hostingPlans.id, [planId]));
    await db.delete(regions).where(inArray(regions.id, [regionId]));
  });

  it("names the tenant — from the row, or from its recipient's account when the row has none", async () => {
    const stamped = await notify({
      userId: tenantUser, tenantId, categoryId: 'mailbox.quota_threshold',
      title: `Mailbox box@${uid}.example.test is 99% full`, message: 'Mailbox is at 99% of its 5 GB quota.',
    });
    const unstamped = await notify({ userId: tenantUser, categoryId: 'subscription.expiry_warning', title: 'Subscription expiring soon' });
    const got = await mine();
    expect(got.find((c) => c.id === stamped)?.tenantName).toBe(`Acme ${uid}`);
    expect(got.find((c) => c.id === unstamped)?.tenantName).toBe(`Acme ${uid}`);

    const lines = describeCandidates(got.filter((c) => c.id === stamped));
    expect(lines).toEqual([
      `Tenant Acme ${uid}: Mailbox box@${uid}.example.test is 99% full — unread since ${old.toISOString().slice(0, 10)}. `
      + 'It said: Mailbox is at 99% of its 5 GB quota.',
    ]);
  });

  it('never chases a sending-window warning: its hour is long over at 48 h', async () => {
    const id = await notify({
      userId: tenantUser, tenantId, categoryId: 'tenant.email_quota_warning',
      title: 'Email sending at 88% of the hour limit',
      message: '44 of 50 messages sent this hour. Sending accounts:\n• box@example.test (44 sent)',
    });
    expect((await mine()).map((c) => c.id)).not.toContain(id);
  });

  it('does not chase an event one of its recipients has read', async () => {
    const seen = crypto.randomUUID();
    const readByA = await notify({ userId: adminA, eventId: seen, isRead: 1, categoryId: 'admin.backup_never_run', title: 'Backups never ran' });
    const unreadByB = await notify({ userId: adminB, eventId: seen, categoryId: 'admin.backup_never_run', title: 'Backups never ran' });
    const unseen = crypto.randomUUID();
    const b1 = await notify({ userId: adminA, eventId: unseen, categoryId: 'admin.backup_never_run', title: 'Backups never ran (2)' });
    const b2 = await notify({ userId: adminB, eventId: unseen, categoryId: 'admin.backup_never_run', title: 'Backups never ran (2)' });
    const got = (await mine()).map((c) => c.id);
    expect(got).not.toContain(readByA);
    expect(got).not.toContain(unreadByB);
    expect(got).toEqual(expect.arrayContaining([b1, b2]));
    expect((await mine()).find((c) => c.id === b1)?.tenantName).toBeNull();
  });

  it('chases a row from before the event model, which has no event id', async () => {
    const legacy = await notify({ userId: tenantUser, tenantId, eventId: null, categoryId: 'mailbox.quota_threshold', title: `legacy ${uid}` });
    expect((await mine()).map((c) => c.id)).toContain(legacy);
  });

  it('skips the young, the escalated, and every class but Action', async () => {
    const young = await notify({ userId: tenantUser, tenantId, categoryId: 'mailbox.quota_threshold', title: 'young', createdAt: new Date(now.getTime() - DAY) });
    const done = await notify({ userId: tenantUser, tenantId, categoryId: 'mailbox.quota_threshold', title: 'done', escalatedAt: now });
    const record = await notify({ userId: tenantUser, tenantId, categoryId: 'subscription.renewed', title: 'record' });
    const got = (await mine()).map((c) => c.id);
    expect(got).not.toContain(young);
    expect(got).not.toContain(done);
    expect(got).not.toContain(record);
  });

  it('is not starved by unread rows it will never chase', async () => {
    // Ambient and Record rows are never marked escalated. Filtered after a
    // LIMIT they came back every tick; past the limit, no Action row would
    // ever have been seen again.
    const older = new Date(now.getTime() - 10 * DAY);
    for (let i = 0; i < 30; i += 1) {
      await notify({ userId: adminA, categoryId: 'admin.slo_alert_resolved', title: `noise ${i}`, createdAt: older });
    }
    const action = await notify({ userId: tenantUser, tenantId, categoryId: 'subscription.expiry_warning', title: 'after the noise' });
    const all = await findEscalationCandidates(db, now, 10_000);
    expect(all.map((c) => c.id)).toContain(action);
    expect(all.filter((c) => !isEscalatable(c.categoryId))).toEqual([]);
    // Exactly as many rows as there is work: the older noise must not take any.
    const work = all.filter((c) => isEscalatable(c.categoryId)).length;
    const exact = await findEscalationCandidates(db, now, work);
    expect(exact.map((c) => c.id)).toContain(action);
  });

  it('labels an admin copy about a tenant as the admins\', and never chases a reminder', async () => {
    const aboutTenant = await notify({ userId: adminA, tenantId, categoryId: 'admin.backup_never_run', title: `about ${uid}` });
    const reminder = await notify({ userId: adminA, categoryId: 'admin.notification_escalated', title: 'a reminder' });
    const got = await mine();
    expect(got.map((c) => c.id)).not.toContain(reminder);
    const c = got.find((x) => x.id === aboutTenant);
    expect(c).toMatchObject({ recipientPanel: 'admin', tenantName: `Acme ${uid}`, tenantScoped: true });
    expect(describeCandidates([c!])[0]).toMatch(new RegExp(`^Platform admins, about tenant Acme ${uid}: about ${uid}`));
  });

  it('marks every copy of an event, even one the row limit left out of the batch', async () => {
    const event = crypto.randomUUID();
    const inBatch = await notify({ userId: tenantUser, tenantId, eventId: event, categoryId: 'subscription.expiry_warning', title: `split ${uid}` });
    const leftOut = await notify({ userId: tenantUser2, tenantId, eventId: event, categoryId: 'subscription.expiry_warning', title: `split ${uid}` });
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
        userId: tenantUser, tenantId, eventId: event, categoryId: 'mailbox.quota_threshold',
        title: `Mailbox sweep-${uid}@example.test is 99% full`,
        message: 'Mailbox is at 99%. Largest folders:\n• Inbox (4.1 GB)\n• Sent (0.8 GB)',
      });
      const copy2 = await notify({
        userId: tenantUser2, tenantId, eventId: event, categoryId: 'mailbox.quota_threshold',
        title: `Mailbox sweep-${uid}@example.test is 99% full`,
        message: 'Mailbox is at 99%. Largest folders:\n• Inbox (4.1 GB)\n• Sent (0.8 GB)',
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
      // Two tenant users' copies are ONE notification: no "x2".
      expect(told.message).toContain(
        `• Tenant Acme ${uid}: Mailbox sweep-${uid}@example.test is 99% full — unread since ${old.toISOString().slice(0, 10)}. `
        + 'It said: Mailbox is at 99%. Largest folders: Inbox (4.1 GB), Sent (0.8 GB)',
      );
      expect(told.message).toContain('reading this does not mark theirs read');

      // Reported once: nothing of it is left to chase.
      expect((await mine()).map((c) => c.id)).not.toEqual(expect.arrayContaining([copy1]));
    });
  });
});
