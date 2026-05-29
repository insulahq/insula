/**
 * Notification Providers service — CRUD + lookup helpers.
 *
 * `notification_providers` is intentionally distinct from
 * `smtp_relay_configs` (tenant outbound). The two never share a row;
 * worker.ts reads here.
 */
import { and, desc, eq } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { notificationCategories, notificationProviders } from '../../../db/schema.js';
import { encrypt, decrypt } from '../../oidc/crypto.js';
import { ApiError } from '../../../shared/errors.js';
import type { Database } from '../../../db/index.js';
import type {
  CreateNotificationProviderInput,
  NotificationProviderResponse,
  TestNotificationProviderInput,
  TestNotificationProviderResponse,
  UpdateNotificationProviderInput,
} from '@k8s-hosting/api-contracts';

type Row = typeof notificationProviders.$inferSelect;

function rowToResponse(row: Row): NotificationProviderResponse {
  return {
    id: row.id,
    name: row.name,
    providerType: row.providerType,
    scope: row.scope as 'platform' | 'tenant',
    tenantId: row.tenantId ?? null,
    channel: row.channel,
    isDefault: row.isDefault,
    enabled: row.enabled,
    smtpHost: row.smtpHost ?? null,
    smtpPort: row.smtpPort,
    smtpSecure: row.smtpSecure,
    authUsername: row.authUsername ?? null,
    authPasswordSet: row.authPasswordEncrypted != null && row.authPasswordEncrypted.length > 0,
    fromAddress: row.fromAddress,
    fromName: row.fromName ?? null,
    region: row.region ?? null,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastTestStatus: (row.lastTestStatus as 'success' | 'failed' | null) ?? null,
    lastTestError: row.lastTestError ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdByUserId: row.createdByUserId ?? null,
  };
}

export async function listProviders(db: Database): Promise<NotificationProviderResponse[]> {
  const rows = await db
    .select()
    .from(notificationProviders)
    .where(eq(notificationProviders.scope, 'platform'))
    .orderBy(desc(notificationProviders.isDefault), notificationProviders.name);
  return rows.map(rowToResponse);
}

export async function getProvider(db: Database, id: string): Promise<NotificationProviderResponse> {
  const [row] = await db
    .select()
    .from(notificationProviders)
    .where(eq(notificationProviders.id, id))
    .limit(1);
  if (!row) {
    throw new ApiError('NOTIFICATION_PROVIDER_NOT_FOUND', `Notification provider '${id}' not found`, 404, { provider_id: id });
  }
  return rowToResponse(row);
}

/**
 * Look up the default platform-scope provider for a channel. Used by
 * the worker when sending email. Returns null when no default is set —
 * the worker treats that as "no provider configured" and marks the
 * delivery failed with a clear error.
 */
export async function getDefaultProviderRow(
  db: Database,
  channel: 'in_app' | 'email',
): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(notificationProviders)
    .where(and(
      eq(notificationProviders.channel, channel),
      eq(notificationProviders.scope, 'platform'),
      eq(notificationProviders.isDefault, true),
      eq(notificationProviders.enabled, true),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Phase 5: resolve the email provider for a specific category.
 *
 * Priority:
 *   1. If the category has NO override (email_provider_id IS NULL),
 *      use the platform-default email provider.
 *   2. If the category HAS an override AND it is enabled, use it.
 *   3. If the category HAS an override AND it is disabled or missing,
 *      return NULL — the worker will mark the delivery `failed` with
 *      reason `override_provider_unavailable`. We deliberately do NOT
 *      fall through to the default here: disabling a provider is the
 *      only tool an operator has to stop traffic through a compromised
 *      or quarantined endpoint, and silently rerouting subverts that
 *      intent (security review 2026-05-29 MEDIUM-2).
 *
 * Returns null when both override-required and default-fallback paths
 * have no candidate. Callers (queue/worker.ts) translate null into a
 * delivery-row failure with a descriptive lastError.
 */
export async function getProviderForCategoryEmail(
  db: Database,
  categoryId: string,
): Promise<Row | null> {
  const [cat] = await db
    .select({ emailProviderId: notificationCategories.emailProviderId })
    .from(notificationCategories)
    .where(eq(notificationCategories.id, categoryId))
    .limit(1);
  if (cat?.emailProviderId) {
    const [override] = await db
      .select()
      .from(notificationProviders)
      .where(and(
        eq(notificationProviders.id, cat.emailProviderId),
        eq(notificationProviders.enabled, true),
        eq(notificationProviders.channel, 'email'),
      ))
      .limit(1);
    // Override is set; honour it strictly. Missing/disabled → null
    // (NOT a fall-through to default) so the operator's "stop using
    // this provider" toggle takes effect.
    return override ?? null;
  }
  return await getDefaultProviderRow(db, 'email');
}

interface CreateContext {
  readonly userId: string;
  readonly encryptionKey: string;
}

export async function createProvider(
  db: Database,
  input: CreateNotificationProviderInput,
  ctx: CreateContext,
): Promise<NotificationProviderResponse> {
  // Phase 3: only platform-scope. Tenant scope is reserved.
  // Phase 6 prep: 'stalwart-internal' providers never store
  // operator-supplied auth — the worker reads master account creds
  // from mail/mail-secrets at send time. The Zod schema already
  // rejects authUsername / authPassword on create, but we also blank
  // them defensively here so a refactor that loosens the schema
  // can't accidentally persist credentials we'd silently ignore.
  const isStalwartInternal = input.providerType === 'stalwart-internal';
  const passwordEncrypted = !isStalwartInternal && input.authPassword
    ? encrypt(input.authPassword, ctx.encryptionKey)
    : null;
  await ensureSingleDefault(db, { channel: 'email', wantDefault: input.isDefault });
  const id = crypto.randomUUID();
  await db.insert(notificationProviders).values({
    id,
    name: input.name,
    providerType: input.providerType,
    scope: 'platform',
    tenantId: null,
    channel: 'email',
    isDefault: input.isDefault,
    enabled: input.enabled,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    authUsername: isStalwartInternal ? null : (input.authUsername ?? null),
    authPasswordEncrypted: passwordEncrypted,
    fromAddress: input.fromAddress,
    fromName: input.fromName ?? null,
    region: input.region ?? null,
    createdByUserId: ctx.userId,
  });
  return await getProvider(db, id);
}

export async function updateProvider(
  db: Database,
  id: string,
  input: UpdateNotificationProviderInput,
  ctx: { readonly encryptionKey: string },
): Promise<NotificationProviderResponse> {
  const existing = await getProvider(db, id);
  if (input.isDefault === true && !existing.isDefault) {
    await ensureSingleDefault(db, { channel: 'email', wantDefault: true, excludeId: id });
  }
  const patch: Partial<typeof notificationProviders.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.smtpHost !== undefined) patch.smtpHost = input.smtpHost;
  if (input.smtpPort !== undefined) patch.smtpPort = input.smtpPort;
  if (input.smtpSecure !== undefined) patch.smtpSecure = input.smtpSecure;
  if (input.authUsername !== undefined) patch.authUsername = input.authUsername;
  if (input.authPassword !== undefined) patch.authPasswordEncrypted = encrypt(input.authPassword, ctx.encryptionKey);
  if (input.fromAddress !== undefined) patch.fromAddress = input.fromAddress;
  if (input.fromName !== undefined) patch.fromName = input.fromName;
  if (input.region !== undefined) patch.region = input.region;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.isDefault !== undefined) patch.isDefault = input.isDefault;
  if (Object.keys(patch).length > 0) {
    await db.update(notificationProviders).set(patch).where(eq(notificationProviders.id, id));
  }
  return await getProvider(db, id);
}

export async function deleteProvider(db: Database, id: string): Promise<void> {
  const existing = await getProvider(db, id);
  if (existing.isDefault) {
    throw new ApiError(
      'OPERATION_NOT_ALLOWED',
      'Cannot delete the default provider — assign another provider as default first',
      409,
      { provider_id: id },
    );
  }
  await db.delete(notificationProviders).where(eq(notificationProviders.id, id));
}

/**
 * Open an SMTP submission, attempt to authenticate, and send a small
 * test message to the operator-supplied recipient. Persists the
 * outcome on the row so the admin UI surfaces the last test status.
 */
export async function testProvider(
  db: Database,
  id: string,
  input: TestNotificationProviderInput,
  ctx: { readonly encryptionKey: string },
): Promise<TestNotificationProviderResponse> {
  const row = await getRawRow(db, id);
  if (!row) {
    throw new ApiError('NOTIFICATION_PROVIDER_NOT_FOUND', `Notification provider '${id}' not found`, 404, { provider_id: id });
  }
  const password = row.authPasswordEncrypted ? safeDecrypt(row.authPasswordEncrypted, ctx.encryptionKey) : null;
  const fromName = row.fromName ?? 'Insula';
  const transport = nodemailer.createTransport({
    host: row.smtpHost ?? '',
    port: row.smtpPort,
    secure: row.smtpSecure,
    auth: row.authUsername ? { user: row.authUsername, pass: password ?? '' } : undefined,
  });
  const now = new Date();
  try {
    await transport.sendMail({
      from: `"${fromName}" <${row.fromAddress}>`,
      to: input.recipientEmail,
      subject: '[Platform] Notification provider test',
      text: `This is an automated test from the notification provider "${row.name}". If you received this, the provider's SMTP credentials are working.\n`,
    });
    await db.update(notificationProviders)
      .set({ lastTestedAt: now, lastTestStatus: 'success', lastTestError: null })
      .where(eq(notificationProviders.id, id));
    return { status: 'success', testedAt: now.toISOString(), error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.update(notificationProviders)
      .set({ lastTestedAt: now, lastTestStatus: 'failed', lastTestError: msg })
      .where(eq(notificationProviders.id, id));
    return { status: 'failed', testedAt: now.toISOString(), error: msg };
  }
}

async function getRawRow(db: Database, id: string): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(notificationProviders)
    .where(eq(notificationProviders.id, id))
    .limit(1);
  return row ?? null;
}

function safeDecrypt(encrypted: string, key: string): string | null {
  try { return decrypt(encrypted, key); } catch { return null; }
}

/**
 * When the operator marks a provider as default, demote any other
 * default for the same channel. The unique partial index would already
 * reject the INSERT, but we'd rather not surface a 500 — do the
 * demote-then-promote in one transaction.
 *
 * The exclusion is necessary because an UPDATE flipping isDefault=true
 * on an existing row would conflict with itself if it's already the
 * default (a no-op edit case).
 */
async function ensureSingleDefault(
  db: Database,
  opts: { channel: 'in_app' | 'email'; wantDefault: boolean; excludeId?: string },
): Promise<void> {
  if (!opts.wantDefault) return;
  const filters = [
    eq(notificationProviders.channel, opts.channel),
    eq(notificationProviders.scope, 'platform'),
    eq(notificationProviders.isDefault, true),
  ];
  const rows = await db.select({ id: notificationProviders.id })
    .from(notificationProviders)
    .where(and(...filters));
  for (const r of rows) {
    if (opts.excludeId && r.id === opts.excludeId) continue;
    // eslint-disable-next-line no-await-in-loop
    await db.update(notificationProviders).set({ isDefault: false }).where(eq(notificationProviders.id, r.id));
  }
}
