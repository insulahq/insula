/**
 * Deployment configuration keys that belong to the platform, not the tenant.
 *
 * A catalog database's administrator account (MariaDB/MySQL root, the
 * PostgreSQL superuser, MongoDB root) is how the platform itself reaches the
 * database: the SQL Manager, backups, restores and migrations all run through
 * it. Were it the tenant's too — returned by a deployment read or the
 * credentials view, or overwritable by a configuration save — it would drift:
 * the database reads that value only on first start, so a root password
 * changed on either side (in SQL by anyone holding it, or in the stored
 * configuration) leaves the platform's copy wrong without anyone noticing.
 *
 * Only on a standalone database instance (catalog type `database`): in an app
 * stack the same keys are the app's own database login, which the tenant
 * keeps (db-admin-access.ts leaves a stack's root as it is), and other
 * services (MinIO's MINIO_ROOT_PASSWORD) are simply the tenant's.
 *
 * There these keys never leave the platform and never come in from a tenant:
 *   - every deployment response drops them (stripPlatformOnlyConfig);
 *   - a configuration save keeps the stored values and ignores the incoming
 *     ones (withStoredPlatformOnlyConfig);
 *   - a create ignores them in the tenant's input (withoutPlatformOnlyConfig),
 *     which also blocks the images' "empty or random root password" switches.
 * The tenant gets its own administrator account instead (tenant-admin.ts).
 */

/** Exact keys: the admin login of each engine, and the images' root-host / root-password switches. */
const EXACT_KEYS: ReadonlySet<string> = new Set([
  'MARIADB_ROOT_PASSWORD',
  'MYSQL_ROOT_PASSWORD',
  'POSTGRES_PASSWORD',
  'MONGO_INITDB_ROOT_PASSWORD',
  'MONGO_INITDB_ROOT_USERNAME',
  'MARIADB_ROOT_HOST',
  'MYSQL_ROOT_HOST',
  'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD',
  'MYSQL_ALLOW_EMPTY_PASSWORD',
  'MARIADB_RANDOM_ROOT_PASSWORD',
  'MYSQL_RANDOM_ROOT_PASSWORD',
  'MARIADB_ROOT_PASSWORD_HASH',
  'POSTGRES_HOST_AUTH_METHOD',
]);

/** One of the keys above, or its `_FILE` form. */
export function isPlatformOnlyConfigKey(key: string): boolean {
  return EXACT_KEYS.has(key) || (key.endsWith('_FILE') && EXACT_KEYS.has(key.slice(0, -5)));
}

/** A copy without the platform's keys — what a tenant (or an agent) may see. */
export function stripPlatformOnlyConfig(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (!isPlatformOnlyConfigKey(k)) out[k] = v;
  }
  return out;
}

/** The tenant's input minus anything it may not set. */
export function withoutPlatformOnlyConfig(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return stripPlatformOnlyConfig(input);
}

/**
 * A configuration save: the tenant's keys from `incoming`, the platform's keys
 * from `stored`. A save from a panel that never saw the platform's keys
 * therefore keeps them, and one that sends its own values cannot change them.
 */
export function withStoredPlatformOnlyConfig(
  stored: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out = stripPlatformOnlyConfig(incoming);
  for (const [k, v] of Object.entries(stored)) {
    if (isPlatformOnlyConfigKey(k) || FROZEN_AFTER_CREATE.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Keys the tenant sees but cannot change once the instance exists: the
 * PostgreSQL superuser's name is set at the first start, and every platform
 * command logs in under it — renamed in the configuration, it would name a
 * role the data directory does not have.
 */
const FROZEN_AFTER_CREATE: ReadonlySet<string> = new Set(['POSTGRES_USER']);

/** Every `catalogEntryId` next to a `configuration` in a payload — what stripPlatformOnlyConfigDeep asks about. */
export function catalogEntryIdsIn(payload: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(payload)) {
    for (const v of payload) catalogEntryIdsIn(v, out);
  } else if (payload !== null && typeof payload === 'object' && !(payload instanceof Date) && !Buffer.isBuffer(payload)) {
    const o = payload as Record<string, unknown>;
    const id = o.catalogEntryId ?? o.catalog_entry_id;
    if ('configuration' in o && typeof id === 'string') out.add(id);
    for (const v of Object.values(o)) catalogEntryIdsIn(v, out);
  }
  return out;
}

/** Decides, for the object holding a `configuration`, whether its keys are the platform's. */
export type PlatformOnlyOwner = (owner: Readonly<Record<string, unknown>>) => boolean;

/**
 * Strip the platform's keys from every `configuration` object in a response
 * payload (a deployment, a list of them, or the `{ data, pagination }`
 * envelope around either) whose owner `applies` says is a standalone database
 * instance — every one, when not told. Pure; returns `payload` itself when
 * nothing changed.
 */
export function stripPlatformOnlyConfigDeep(payload: unknown, applies: PlatformOnlyOwner = () => true): unknown {
  if (Array.isArray(payload)) {
    let changed = false;
    const out = payload.map((v) => {
      const s = stripPlatformOnlyConfigDeep(v, applies);
      if (s !== v) changed = true;
      return s;
    });
    return changed ? out : payload;
  }
  if (payload === null || typeof payload !== 'object' || payload instanceof Date || Buffer.isBuffer(payload)) {
    return payload;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  const owner = payload as Record<string, unknown>;
  const strip = applies(owner);
  for (const [k, v] of Object.entries(owner)) {
    let next: unknown = v;
    if (k === 'configuration' && !strip) {
      next = v;
    } else if (k === 'configuration' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      next = stripPlatformOnlyConfig(v as Record<string, unknown>);
      if (Object.keys(next as object).length !== Object.keys(v as object).length) changed = true;
    } else if (k === 'configuration' && typeof v === 'string') {
      // Some rows carry configuration as JSON text.
      try {
        const parsed = JSON.parse(v) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const stripped = stripPlatformOnlyConfig(parsed as Record<string, unknown>);
          if (Object.keys(stripped).length !== Object.keys(parsed as object).length) {
            next = JSON.stringify(stripped);
            changed = true;
          }
        }
      } catch {
        // not JSON — leave it
      }
    } else {
      next = stripPlatformOnlyConfigDeep(v, applies);
      if (next !== v) changed = true;
    }
    out[k] = next;
  }
  return changed ? out : payload;
}
