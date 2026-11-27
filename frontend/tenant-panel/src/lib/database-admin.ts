/**
 * What the panel says about a database instance's accounts, per engine.
 *
 * The instance's root / superuser login is the platform's (the SQL Manager,
 * backups and restores run through it) and is never shown. The tenant gets
 * its own administrator account — full rights on every one of its databases,
 * no right to create users — and adds users under Database Users.
 */
import type { DeploymentConnectionInfo, DatabaseAdminAccount } from '@insula/api-contracts';

export type ManagedDbEngine = 'mariadb' | 'mysql' | 'postgresql' | 'mongodb';

const ENGINES: ReadonlySet<string> = new Set<ManagedDbEngine>(['mariadb', 'mysql', 'postgresql', 'mongodb']);

/**
 * The engine a catalog entry's database component declares, or null when it
 * has none — such an entry gets no administrator account, so the panel must
 * not wait for one.
 */
export function managedDbEngineOf(
  entry: { readonly components?: ReadonlyArray<{ readonly database?: string }> | null } | null | undefined,
): ManagedDbEngine | null {
  const declared = entry?.components?.find((c) => typeof c.database === 'string' && ENGINES.has(c.database))?.database;
  return (declared as ManagedDbEngine | undefined) ?? null;
}

/** One line on what the administrator account may do. */
export function adminAccountScope(engine: ManagedDbEngine | null): string {
  switch (engine) {
    case 'mariadb':
    case 'mysql':
      return 'Full rights on all your databases. In SQL it can create new databases whose name starts with db_. It cannot create users — add them under Database Users.';
    case 'postgresql':
      return 'Owns all your databases and can create new ones in SQL. It cannot create users — add them under Database Users.';
    case 'mongodb':
      return 'Reads, writes and administers all your databases. It cannot create users — add them under Database Users.';
    default:
      return 'Full rights on all your databases. It cannot create users — add them under Database Users.';
  }
}

/** The "All databases" choice when creating a database user. */
export function allDatabasesOptionLabel(engine: ManagedDbEngine | null): string {
  switch (engine) {
    case 'mariadb':
    case 'mysql':
    case 'mongodb':
      return 'All databases (including ones created later)';
    case 'postgresql':
      return 'All databases that exist now';
    default:
      return 'All databases';
  }
}

/** What "All databases" grants, said under the choice. */
export function allDatabasesHint(engine: ManagedDbEngine | null): string {
  switch (engine) {
    case 'mariadb':
    case 'mysql':
      return 'Full rights on every database here, and on databases added later — in the panel, or in SQL as db_…. No user or server administration.';
    case 'postgresql':
      return 'Full rights on every database that exists now. A database created later must be granted to the user separately.';
    case 'mongodb':
      return 'Reads and writes every database here, including ones created later. No user administration.';
    default:
      return 'Access to every database of this instance.';
  }
}

const PROTOCOL: Readonly<Record<ManagedDbEngine, string>> = {
  mariadb: 'mysql',
  mysql: 'mysql',
  postgresql: 'postgresql',
  mongodb: 'mongodb',
};

function protocolFor(engine: ManagedDbEngine | null, port: number): string | null {
  if (engine) return PROTOCOL[engine];
  if (port === 3306) return 'mysql';
  if (port === 5432) return 'postgresql';
  if (port === 27017) return 'mongodb';
  if (port === 6379) return 'redis';
  return null;
}

/**
 * A connection URL with the password masked. The user is the application user
 * created at deploy time when there is one, else the tenant's administrator —
 * never root. MongoDB's administrator authenticates against `admin`.
 */
export function buildConnectionUrl(
  info: DeploymentConnectionInfo,
  engine: ManagedDbEngine | null,
  adminAccount: DatabaseAdminAccount | null,
): string | null {
  if (!info.host || info.port == null) return null;
  const protocol = protocolFor(engine, info.port);
  if (!protocol) return null;
  const asAdmin = info.username === null && adminAccount !== null;
  const user = asAdmin ? adminAccount.username : info.username;
  const userPart = user ? `${encodeURIComponent(user)}:***@` : '';
  const dbPart = info.database ? `/${encodeURIComponent(info.database)}` : '';
  const query = engine === 'mongodb' && asAdmin ? `${dbPart ? '' : '/'}?authSource=admin` : '';
  return `${protocol}://${userPart}${info.host}:${info.port}${dbPart}${query}`;
}
