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

/**
 * OpenSSH rejects a private key that lacks a trailing newline with a
 * cryptic `error in libcrypto` → `Permission denied (publickey)`, which
 * surfaces to the operator only as an empty/failed discovery. Operators
 * pasting a key into the UI textarea — and shells that strip the final
 * newline — routinely drop it. Normalize on store: CRLF→LF and exactly
 * one trailing newline, so every delivered key parses.
 */
export function normalizePrivateKey(pem: string): string {
  const body = pem.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return body.length > 0 ? `${body}\n` : body;
}

type SourceRow = typeof pleskSources.$inferSelect;

/** 'key' | 'password' — which credential the source authenticates with. */
export function sourceAuthMethod(row: SourceRow): 'key' | 'password' {
  return row.authMethod === 'password' ? 'password' : 'key';
}

/** Strip the encrypted credentials — responses never carry them. */
export function toSourceResponse(row: SourceRow): PleskSourceResponse {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    sshPort: row.sshPort,
    sshUser: row.sshUser,
    authMethod: sourceAuthMethod(row),
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
  // The contract guarantees exactly one of key/password is present.
  const usePassword = !!input.ssh_password;
  await db.insert(pleskSources).values({
    id,
    name: input.name,
    hostname: input.hostname,
    sshPort: input.ssh_port ?? 22,
    sshUser: input.ssh_user ?? 'root',
    authMethod: usePassword ? 'password' : 'key',
    sshKeyEncrypted: usePassword ? null : encrypt(normalizePrivateKey(input.ssh_private_key as string), encryptionKey()),
    sshPasswordEncrypted: usePassword ? encrypt(input.ssh_password as string, encryptionKey()) : null,
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
  if (!row.sshKeyEncrypted) throw new ApiError('PLESK_SOURCE_NO_KEY', `Plesk source '${row.id}' has no SSH key (password auth?)`, 500);
  return decrypt(row.sshKeyEncrypted, encryptionKey());
}

/** In-process only — decrypt the SSH password for a discovery/sync Job. */
export function decryptSourcePassword(row: SourceRow): string {
  if (!row.sshPasswordEncrypted) throw new ApiError('PLESK_SOURCE_NO_PASSWORD', `Plesk source '${row.id}' has no SSH password (key auth?)`, 500);
  return decrypt(row.sshPasswordEncrypted, encryptionKey());
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
  // Supplying either credential switches the source's auth method and
  // replaces the stored secret (the contract rejects supplying both).
  if (input.ssh_private_key !== undefined) {
    values.authMethod = 'key';
    values.sshKeyEncrypted = encrypt(normalizePrivateKey(input.ssh_private_key), encryptionKey());
    values.sshPasswordEncrypted = null;
  } else if (input.ssh_password !== undefined) {
    values.authMethod = 'password';
    values.sshPasswordEncrypted = encrypt(input.ssh_password, encryptionKey());
    values.sshKeyEncrypted = null;
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
