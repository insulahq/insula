/**
 * Plesk migration source registry (R1 PR 1).
 *
 * CRUD for operator-registered Plesk source servers. The SSH private
 * key is encrypted at rest with PLATFORM_ENCRYPTION_KEY (AES-256-GCM,
 * oidc/crypto.ts) and NEVER returned to clients — only decrypted
 * in-process when a discovery Job needs it.
 */

import { randomUUID } from 'node:crypto';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { pleskSources, pleskDiscoveries } from '../../db/schema.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type {
  CreatePleskSourceInput,
  UpdatePleskSourceInput,
  PleskSourceResponse,
} from '@insula/api-contracts';

function encryptionKey(): string {
  // Dev-only fallback — production requires PLATFORM_ENCRYPTION_KEY (same
  // convention as smtp-relay / email-outbound encrypt-at-rest).
  return process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64);
}

type SourceRow = typeof pleskSources.$inferSelect;

/** Strip the encrypted key — responses never carry it. */
export function toSourceResponse(row: SourceRow): PleskSourceResponse {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    sshPort: row.sshPort,
    sshUser: row.sshUser,
    pleskVersion: row.pleskVersion,
    passwordStorage: row.passwordStorage,
    lastDiscoveredAt: row.lastDiscoveredAt,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export async function createSource(
  db: Database,
  input: CreatePleskSourceInput,
  createdBy: string | null,
): Promise<PleskSourceResponse> {
  const id = randomUUID();
  await db.insert(pleskSources).values({
    id,
    name: input.name,
    hostname: input.hostname,
    sshPort: input.ssh_port ?? 22,
    sshUser: input.ssh_user ?? 'root',
    sshKeyEncrypted: encrypt(input.ssh_private_key, encryptionKey()),
    createdBy,
  });
  const [row] = await db.select().from(pleskSources).where(eq(pleskSources.id, id));
  return toSourceResponse(row);
}

export async function listSources(db: Database): Promise<PleskSourceResponse[]> {
  const rows = await db.select().from(pleskSources).orderBy(desc(pleskSources.createdAt));
  return rows.map(toSourceResponse);
}

export async function getSourceRow(db: Database, id: string): Promise<SourceRow> {
  const [row] = await db.select().from(pleskSources).where(eq(pleskSources.id, id));
  if (!row) throw new ApiError('PLESK_SOURCE_NOT_FOUND', `Plesk source '${id}' not found`, 404);
  return row;
}

/** In-process only — decrypt the SSH key for a discovery/sync Job. */
export function decryptSourceKey(row: SourceRow): string {
  return decrypt(row.sshKeyEncrypted, encryptionKey());
}

export async function updateSource(
  db: Database,
  id: string,
  input: UpdatePleskSourceInput,
): Promise<PleskSourceResponse> {
  await getSourceRow(db, id);
  const values: Record<string, unknown> = {};
  if (input.name !== undefined) values.name = input.name;
  if (input.hostname !== undefined) values.hostname = input.hostname;
  if (input.ssh_port !== undefined) values.sshPort = input.ssh_port;
  if (input.ssh_user !== undefined) values.sshUser = input.ssh_user;
  if (input.ssh_private_key !== undefined) {
    values.sshKeyEncrypted = encrypt(input.ssh_private_key, encryptionKey());
  }
  if (Object.keys(values).length > 0) {
    await db.update(pleskSources).set(values).where(eq(pleskSources.id, id));
  }
  const [row] = await db.select().from(pleskSources).where(eq(pleskSources.id, id));
  return toSourceResponse(row);
}

export async function deleteSource(db: Database, id: string): Promise<void> {
  await getSourceRow(db, id);
  await db.delete(pleskSources).where(eq(pleskSources.id, id)); // cascades discoveries
}

export async function listDiscoveries(db: Database, sourceId: string) {
  return db
    .select()
    .from(pleskDiscoveries)
    .where(eq(pleskDiscoveries.sourceId, sourceId))
    .orderBy(desc(pleskDiscoveries.startedAt));
}

export async function hasActiveDiscovery(db: Database, sourceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: pleskDiscoveries.id })
    .from(pleskDiscoveries)
    .where(and(eq(pleskDiscoveries.sourceId, sourceId), inArray(pleskDiscoveries.status, ['pending', 'running'])))
    .limit(1);
  return rows.length > 0;
}

export async function getDiscovery(db: Database, id: string) {
  const [row] = await db.select().from(pleskDiscoveries).where(eq(pleskDiscoveries.id, id));
  if (!row) throw new ApiError('PLESK_DISCOVERY_NOT_FOUND', `Discovery '${id}' not found`, 404);
  return row;
}
