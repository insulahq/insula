/**
 * Password-reset init container builder.
 *
 * When re-deploying into a pre-existing PVC folder (a restore, a recreated
 * deployment, a repair), the data directory's own grant tables decide who can
 * log in — whatever they were when it was copied. This module builds an init
 * container that restores the platform's administrator login before the main
 * container starts: root by socket only (MariaDB/MySQL), the superuser by
 * local trust with no password (PostgreSQL), a pod-local root with the
 * platform's password (MongoDB). See db-admin-access.ts.
 */

interface PasswordResetInput {
  readonly catalogCode: string;
  readonly image: string;
  readonly storagePath: string;
  readonly volumeMountName: string;
  readonly passwordEnvVar: string;
  readonly passwordEnvVarUser?: string;
  /**
   * CPU/memory request of the container this init container runs in front of.
   * Both are mirrored onto the init container — see initResources() below.
   */
  readonly cpuRequest: string;
  readonly memoryRequest: string;
}

interface InitContainer {
  readonly name: string;
  readonly image: string;
  readonly command: readonly string[];
  readonly volumeMounts: readonly { name: string; mountPath: string; subPath?: string }[];
  readonly resources: { requests: { cpu: string; memory: string }; limits: { memory: string } };
  readonly securityContext?: Record<string, unknown>;
}

/**
 * Pick the engine ADMIN password key out of a deployment's generated env keys.
 *
 * Deliberately strict. A looser `k.includes('PASSWORD')` also matches
 * MARIADB_PASSWORD — the *application* user — and whichever key happened to come
 * first would then be stamped onto root, leaving the platform permanently unable
 * to authenticate. Both the create and the redeploy path must use this one
 * matcher; they drifted apart once already.
 */
export function findAdminPasswordEnvVar(keys: readonly string[]): string | undefined {
  return keys.find((k) => /_ROOT_PASSWORD$/.test(k) || k === 'POSTGRES_PASSWORD');
}

const DB_ENGINES: Record<string, 'mariadb' | 'mysql' | 'postgresql' | 'mongodb'> = {
  mariadb: 'mariadb',
  mysql: 'mysql',
  postgresql: 'postgresql',
  'mongodb-7': 'mongodb',
  mongodb: 'mongodb',
};

// Asymmetric QoS (ADR-037): CPU request only, memory request==limit.
//
// Mirror the fronted container's own request rather than pick a number.
// Kubernetes charges a pod `max(sum(containers), max(initContainers))` for its
// WHOLE lifetime, so any init container asking for more than the workload it
// precedes silently inflates the tenant's quota footprint — and neither the
// panel nor the deploy gate could see it (both summed `spec.containers`).
//
// A flat constant here is silently wrong in one direction only, which is what
// makes it hard to see: while the constant exceeds the database's own request,
// shrinking the database frees nothing and the quota error comes back
// byte-identical, because the charge is pinned to the constant.
//
// Mirroring is also the safe bound, not merely the cheap one: this container
// boots the SAME engine binary from the SAME datadir as the container behind
// it, with --skip-networking and no client load, so it is strictly the lighter
// of the two. A datadir that cannot be reset inside the request is a datadir
// whose database could not have started either.
function initResources(cpuRequest: string, memoryRequest: string) {
  return {
    requests: { cpu: cpuRequest, memory: memoryRequest },
    limits: { memory: memoryRequest },
  };
}

// Every reset script is BEST-EFFORT and always exits 0.
//
// These run as an init container in front of the tenant's database, so a
// non-zero exit crash-loops the pod and takes the database down. That trade is
// never worth it: failing to re-stamp the password degrades to "the platform
// cannot manage this database" (which the panel now surfaces as an error),
// while exiting non-zero degrades to "the tenant's site is down". Each script
// therefore probes the datadir first, guards every statement, and reports a
// loud WARNING instead of failing.


/**
 * The temporary server only runs a few statements, inside the database
 * container's own memory limit — which the catalog sizes for a server started
 * with its lean options (performance schema off, small buffers). Started with
 * the engine's defaults instead, MySQL 8 needs more than a 300Mi instance has
 * and the reset container is OOM-killed on every start, so the database never
 * comes back after a restart. These hold it well inside the limit; PostgreSQL
 * and MongoDB get the same treatment below (PG_LEAN_SERVER_OPTIONS, a small
 * WiredTiger cache), so no engine's reset needs more than its own server.
 */
const LEAN_SERVER_FLAGS = '--performance-schema=OFF --innodb-buffer-pool-size=32M --innodb-log-buffer-size=4M --max-connections=10';
const PG_LEAN_SERVER_OPTIONS = '-c shared_buffers=16MB -c max_connections=10 -c work_mem=1MB -c maintenance_work_mem=16MB -c shared_preload_libraries= -c archive_mode=off';
function buildMysqlFamilyResetScript(
  bin: {
    readonly server: string; readonly client: string; readonly admin: string; readonly socket: string;
    /** 'unix_socket' (MariaDB) or 'auth_socket' (MySQL, a plugin to install first). */
    readonly socketPlugin: 'unix_socket' | 'auth_socket';
    /** Engine-only options for the temporary server's memory (see LEAN_SERVER_FLAGS). */
    readonly leanFlags?: string;
  },
): string {
  const sock = bin.socket;
  const via = bin.socketPlugin === 'unix_socket' ? 'IDENTIFIED VIA unix_socket' : 'IDENTIFIED WITH auth_socket';
  // MySQL ships auth_socket as a plugin. --skip-grant-tables does not load the
  // plugins mysql.plugin lists, so this temporary server loads it by option,
  // and the row in mysql.plugin — what the real server loads at start — is
  // written directly (INSERT IGNORE: a second run finds it there; INSTALL
  // PLUGIN refuses a plugin the option already loaded).
  const loadPlugin = bin.socketPlugin === 'auth_socket' ? ' --plugin-load-add=auth_socket.so' : '';
  const install = bin.socketPlugin === 'auth_socket' ? "INSERT IGNORE INTO mysql.plugin (name, dl) VALUES ('auth_socket', 'auth_socket.so'); " : '';
  return [
    'DATADIR=/var/lib/mysql',
    'if [ ! -d "$DATADIR/mysql" ]; then echo "No existing data, skipping the administrator reset"; exit 0; fi',
    'echo "Existing datadir detected — restoring the platform\'s administrator login (root by socket only)"',
    '# The entrypoint normally creates the socket dir; we bypass it, so make it ourselves.',
    `mkdir -p "$(dirname ${sock})" 2>/dev/null || true`,
    `chown mysql:mysql "$(dirname ${sock})" 2>/dev/null || true`,
    '# Start with --skip-grant-tables so we can connect whatever root\'s login is now',
    `${bin.server} --user=mysql --datadir="$DATADIR" --skip-networking --skip-grant-tables${loadPlugin} ${LEAN_SERVER_FLAGS}${bin.leanFlags ? ` ${bin.leanFlags}` : ''} &`,
    'PID=$!',
    'READY=0',
    `for i in $(seq 1 60); do if ${bin.client} -u root --socket=${sock} -e "SELECT 1" >/dev/null 2>&1; then READY=1; break; fi; sleep 1; done`,
    'if [ "$READY" = "1" ]; then',
    // FLUSH PRIVILEGES re-enables the grant system for NEW connections while this
    // one keeps full rights. root@localhost logs in by the OS user of a process
    // in the pod (db-admin-access.ts): no password, nothing to go stale. Every
    // other root account goes, so root cannot be reached over the network.
    `  ${bin.client} -u root --socket=${sock} --force -e "${install}FLUSH PRIVILEGES; CREATE USER IF NOT EXISTS 'root'@'localhost' ${via}; ALTER USER 'root'@'localhost' ${via}; GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION;" 2>&1 | grep -v -i "already exists" || true`,
    `  for H in $(${bin.client} -u root --socket=${sock} -N -B -e "SELECT Host FROM mysql.user WHERE User = 'root' AND Host <> 'localhost'" 2>/dev/null); do`,
    `    ${bin.client} -u root --socket=${sock} -e "DROP USER IF EXISTS 'root'@'$H'" 2>/dev/null && echo "Dropped root@$H"`,
    '  done',
    `  if ${bin.client} -u root --socket=${sock} -N -B -e "SELECT 1" >/dev/null 2>&1; then`,
    '    echo "Administrator login restored (root by socket)"',
    '  else',
    '    echo "WARNING: root could not be set to the socket login — the platform may not be able to manage this database"',
    '  fi',
    'else',
    '  echo "WARNING: temporary server did not become ready — skipping the administrator reset"',
    'fi',
    `${bin.admin} -u root --socket=${sock} shutdown >/dev/null 2>&1 || kill $PID 2>/dev/null || true`,
    'wait $PID 2>/dev/null || true',
    'exit 0',
  ].join('\n');
}

function buildMariadbResetScript(): string {
  return buildMysqlFamilyResetScript({
    server: 'mariadbd',
    client: 'mariadb',
    admin: 'mariadb-admin',
    socket: '/run/mysqld/mysqld.sock',
    socketPlugin: 'unix_socket',
    // MariaDB-only buffers (the Aria page cache and MyISAM key cache default to 128 MB each).
    leanFlags: '--aria-pagecache-buffer-size=8M --key-buffer-size=8M',
  });
}

function buildMysqlResetScript(): string {
  return buildMysqlFamilyResetScript({
    server: 'mysqld',
    client: 'mysql',
    admin: 'mysqladmin',
    socket: '/var/run/mysqld/mysqld.sock',
    socketPlugin: 'auth_socket',
    leanFlags: '--temptable-max-ram=16M',
  });
}

function buildPostgresqlResetScript(): string {
  // PostgreSQL 18 uses /var/lib/postgresql/<major>/docker as PGDATA.
  // We detect the actual PGDATA by finding PG_VERSION in any subdirectory.
  return [
    'MOUNT=/var/lib/postgresql',
    '# Find PGDATA — could be /var/lib/postgresql/data (17) or /var/lib/postgresql/18/docker (18+)',
    'PGDATA=""',
    'for candidate in "$MOUNT"/*/docker "$MOUNT/data"; do',
    '  if [ -s "$candidate/PG_VERSION" ]; then PGDATA="$candidate"; break; fi',
    'done',
    'if [ -z "$PGDATA" ]; then echo "No existing data (PG_VERSION not found), skipping password reset"; exit 0; fi',
    'export PGDATA',
    'echo "Detected PGDATA=$PGDATA"',
    '# Backup pg_hba.conf. The trap is load-bearing: this script rewrites pg_hba',
    '# to trust-auth, so ANY early exit between here and the restore would hand the',
    '# main container a database that trusts every local connection. Restore first,',
    '# report second, and never exit non-zero (a crash-looping init container would',
    '# take the tenant database down).',
    '# The file comes back with the platform\'s local rules first (the image\'s own',
    '# defaults): rules a tenant wrote below them cannot refuse the platform\'s login,',
    '# so a repair of a pg_hba.conf lockout stays repaired. Written into the same file,',
    '# which keeps its owner.',
    'LOCAL_RULES="# platform: administrator login (local), before every rule below"',
    'restore_hba() {',
    '  if [ -f "$PGDATA/pg_hba.conf.bak" ]; then',
    '    { grep -qxF "$LOCAL_RULES" "$PGDATA/pg_hba.conf.bak" || printf "%s\\nlocal all all trust\\nhost all all 127.0.0.1/32 trust\\nhost all all ::1/128 trust\\n" "$LOCAL_RULES"; cat "$PGDATA/pg_hba.conf.bak"; } > "$PGDATA/pg_hba.conf" && rm -f "$PGDATA/pg_hba.conf.bak"',
    '  fi',
    '}',
    'trap \'pg_ctl -D "$PGDATA" -m immediate -w stop >/dev/null 2>&1 || true; restore_hba\' EXIT INT TERM',
    'cp "$PGDATA/pg_hba.conf" "$PGDATA/pg_hba.conf.bak"',
    '# Temporarily allow trust auth for local connections',
    'printf "local all all trust\\nhost all all 127.0.0.1/32 trust\\nhost all all ::1/128 trust\\n" > "$PGDATA/pg_hba.conf"',
    '# Start postgres locally',
    // The temporary server runs inside the database container's memory limit
    // (see LEAN_SERVER_FLAGS) with small buffers, and loads no library and
    // archives nothing while the platform's login is put back.
    `if pg_ctl -D "$PGDATA" -o "-c listen_addresses='' ${PG_LEAN_SERVER_OPTIONS}" -w start; then`,
    // The superuser the image was initialised with, by the local trust the
    // platform uses (db-admin-access.ts); its password goes, so it cannot be
    // reached over the network. A standalone instance's — the only kind this
    // reset is armed for.
    '  SU="${POSTGRES_USER:-postgres}"',
    '  if psql -U "$SU" -d postgres -c "ALTER ROLE CURRENT_USER PASSWORD NULL;"; then',
    '    echo "Administrator login restored ($SU by local trust only)"',
    '  else',
    '    echo "WARNING: the superuser reset failed — the platform may not be able to manage this database"',
    '  fi',
    '  pg_ctl -D "$PGDATA" -m fast -w stop || true',
    'else',
    '  echo "WARNING: temporary server did not start — skipping postgres password reset"',
    'fi',
    '# trap restores pg_hba.conf on the way out',
    'exit 0',
  ].join('\n');
}

function buildMongodbResetScript(passwordEnvVar: string, userEnvVar: string): string {
  return [
    'DBPATH=/data/db',
    'if [ ! -e "$DBPATH/WiredTiger" ]; then echo "No existing data, skipping password reset"; exit 0; fi',
    'echo "Existing dbpath detected — re-stamping the configured admin credentials"',
    '# Start mongod without auth',
    // The smallest WiredTiger cache mongod accepts (0.25 GB): mongod and mongosh
    // share the container's limit here.
    'if mongod --dbpath "$DBPATH" --bind_ip 127.0.0.1 --port 27017 --logpath /tmp/mongod.log --wiredTigerCacheSizeGB 0.25 --fork; then',
    '  READY=0',
    '  for i in $(seq 1 60); do if mongosh --host 127.0.0.1 --port 27017 --quiet --eval "db.adminCommand(\'ping\')" >/dev/null 2>&1; then READY=1; break; fi; sleep 1; done',
    '  if [ "$READY" = "1" ]; then',
    '    # Drop existing admin users and create new one with env-var credentials',
    `    NEW_USER="\${${userEnvVar}:-root}"`,
    `    NEW_PWD="\${${passwordEnvVar}}"`,
    '    # Write JS file — use env vars substituted by shell before heredoc',
    '    cat > /tmp/reset-mongo.js << ENDOFJS',
    'var adminDb = db.getSiblingDB("admin");',
    'var users = adminDb.getUsers().users;',
    'users.forEach(function(u) { if (u.roles.some(function(r) { return r.role === "root" || r.role === "userAdminAnyDatabase"; })) { adminDb.dropUser(u.user); } });',
    // Root may log in from inside the pod only (db-admin-access.ts).
    'adminDb.createUser({ user: "$NEW_USER", pwd: "$NEW_PWD", roles: ["root"], authenticationRestrictions: [{ clientSource: ["127.0.0.1", "::1"] }] });',
    'print("Created admin user: $NEW_USER");',
    'ENDOFJS',
    '    if mongosh --host 127.0.0.1 --port 27017 --quiet /tmp/reset-mongo.js; then',
    '      echo "MongoDB password reset complete"',
    '    else',
    '      echo "WARNING: mongodb admin reset failed — the platform may not be able to manage this database"',
    '    fi',
    '    rm -f /tmp/reset-mongo.js',
    '  else',
    '    echo "WARNING: temporary server did not become ready — skipping mongodb admin reset"',
    '  fi',
    '  mongod --dbpath "$DBPATH" --shutdown || true',
    'else',
    '  echo "WARNING: temporary server did not start — skipping mongodb admin reset"',
    'fi',
    'exit 0',
  ].join('\n');
}

export function buildPasswordResetInitContainer(input: PasswordResetInput): InitContainer | null {
  const { catalogCode, image, storagePath, volumeMountName, passwordEnvVar, passwordEnvVarUser, cpuRequest, memoryRequest } = input;

  if (!passwordEnvVar) return null;

  const engine = DB_ENGINES[catalogCode];
  if (!engine) return null;

  let script: string;
  let mountPath: string;
  let securityContext: Record<string, unknown> | undefined;

  switch (engine) {
    case 'mariadb':
      script = buildMariadbResetScript();
      mountPath = '/var/lib/mysql';
      break;
    case 'mysql':
      script = buildMysqlResetScript();
      mountPath = '/var/lib/mysql';
      break;
    case 'postgresql':
      script = buildPostgresqlResetScript();
      mountPath = '/var/lib/postgresql';
      // PostgreSQL requires running as the postgres user (UID 999 in official image)
      securityContext = { runAsUser: 999 };
      break;
    case 'mongodb':
      script = buildMongodbResetScript(passwordEnvVar, passwordEnvVarUser ?? 'root');
      mountPath = '/data/db';
      break;
    default:
      return null;
  }

  return {
    name: 'reset-root-password',
    image,
    command: ['sh', '-c', script],
    volumeMounts: [
      { name: volumeMountName, mountPath, subPath: storagePath },
    ],
    resources: initResources(cpuRequest, memoryRequest),
    ...(securityContext ? { securityContext } : {}),
  };
}
