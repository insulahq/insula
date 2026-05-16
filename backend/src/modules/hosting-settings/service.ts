import { eq, and } from 'drizzle-orm';
import { hostingSettings, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { UpdateHostingSettingsInput } from './schema.js';

async function verifyDomainOwnership(db: Database, tenantId: string, domainId: string) {
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.tenantId, tenantId)));

  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found for tenant`, 404);
  }
  return domain;
}

function settingsToResponse(s: typeof hostingSettings.$inferSelect) {
  return {
    ...s,
    redirectWww: Boolean(s.redirectWww),
    redirectHttps: Boolean(s.redirectHttps),
    hostingEnabled: Boolean(s.hostingEnabled),
  };
}

export async function getHostingSettings(db: Database, tenantId: string, domainId: string) {
  await verifyDomainOwnership(db, tenantId, domainId);

  const [settings] = await db
    .select()
    .from(hostingSettings)
    .where(eq(hostingSettings.domainId, domainId));

  if (!settings) {
    // Create default settings on first access
    const id = crypto.randomUUID();
    await db.insert(hostingSettings).values({
      id,
      domainId,
    });
    const [created] = await db.select().from(hostingSettings).where(eq(hostingSettings.id, id));
    return settingsToResponse(created);
  }

  return settingsToResponse(settings);
}

export async function updateHostingSettings(
  db: Database,
  tenantId: string,
  domainId: string,
  input: UpdateHostingSettingsInput,
) {
  await verifyDomainOwnership(db, tenantId, domainId);

  // Ensure settings exist
  await getHostingSettings(db, tenantId, domainId);

  const updateValues: Record<string, unknown> = {};
  if (input.redirect_www !== undefined) updateValues.redirectWww = input.redirect_www ? 1 : 0;
  if (input.redirect_https !== undefined) updateValues.redirectHttps = input.redirect_https ? 1 : 0;
  if (input.forward_external !== undefined) updateValues.forwardExternal = input.forward_external;
  if (input.webroot_path !== undefined) updateValues.webrootPath = input.webroot_path;
  if (input.hosting_enabled !== undefined) updateValues.hostingEnabled = input.hosting_enabled ? 1 : 0;

  if (Object.keys(updateValues).length > 0) {
    await db
      .update(hostingSettings)
      .set(updateValues)
      .where(eq(hostingSettings.domainId, domainId));
  }

  return getHostingSettings(db, tenantId, domainId);
}
