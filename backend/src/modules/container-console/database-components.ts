/**
 * Which of a deployment's components are its database.
 *
 * A shell in a database container runs as that container's OS root, and the
 * OS root is the platform's administrator login there: MariaDB/MySQL root by
 * socket, the PostgreSQL superuser by local trust, a MongoDB root restricted
 * to the pod (deployments/db-admin-access.ts). A tenant terminal into one
 * would hand that login over, so tenants get no terminal there — the SQL
 * Manager is their way in. Platform staff keep it.
 */
import type { catalogEntries } from '../../db/schema.js';

type CatalogEntryRow = Pick<typeof catalogEntries.$inferSelect, 'type' | 'code' | 'components'>;

/** Component names (as the pods' `component` label carries them) that hold a database engine. */
export function databaseComponentNames(entry: CatalogEntryRow | null | undefined): ReadonlySet<string> {
  if (!entry) return new Set();
  let components: Array<{ name?: string; database?: string }> = [];
  try {
    components = (typeof entry.components === 'string' ? JSON.parse(entry.components) : entry.components) as typeof components ?? [];
  } catch {
    components = [];
  }
  const names = new Set(components.filter((c) => typeof c.database === 'string' && c.database).map((c) => c.name ?? ''));
  // A standalone database entry labels its single pod with the entry code.
  if (entry.type === 'database') names.add(entry.code);
  names.delete('');
  return names;
}

/** Roles that may open a terminal in a database container. */
export const DATABASE_TERMINAL_ROLES: ReadonlySet<string> = new Set(['super_admin', 'admin']);
