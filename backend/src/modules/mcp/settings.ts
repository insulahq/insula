/**
 * The operator's switch for tenant AI agents (platform_settings).
 *
 * Off by default: an installation that upgrades does not open every tenant
 * account to AI agents until its operator decides to. On: tenant users may
 * connect agents to the tenant panel's MCP endpoint. Off: the tenant consent
 * page refuses, and every tenant token stops resolving (tokens.ts) — the
 * switch is read on each token resolve, cached briefly like the tokens.
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { platformSettings } from '../../db/schema.js';

export const TENANT_AGENTS_SETTING_KEY = 'mcp_tenant_agents_enabled';

const CACHE_MS = 30_000;
let cached: { at: number; value: boolean } | null = null;

export function clearAgentSettingsCache(): void {
  cached = null;
}

export async function tenantAgentsEnabled(db: Database, now: number = Date.now()): Promise<boolean> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const [row] = await db.select({ value: platformSettings.value }).from(platformSettings)
    .where(eq(platformSettings.key, TENANT_AGENTS_SETTING_KEY)).limit(1);
  const value = row?.value === 'true';
  cached = { at: now, value };
  return value;
}

export async function setTenantAgentsEnabled(db: Database, enabled: boolean): Promise<void> {
  const value = enabled ? 'true' : 'false';
  await db.insert(platformSettings).values({ key: TENANT_AGENTS_SETTING_KEY, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: sql`now()` } });
  clearAgentSettingsCache();
}
