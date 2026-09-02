/**
 * Password-reset init container builder.
 *
 * When re-deploying into a pre-existing PVC folder, the database engine
 * ignores MARIADB_ROOT_PASSWORD / MYSQL_ROOT_PASSWORD / POSTGRES_PASSWORD
 * because the data directory already exists. This module builds an init
 * container that resets the root password before the main container starts.
 */

interface PasswordResetInput {
  readonly catalogCode: string;
  readonly image: string;
  readonly storagePath: string;
  readonly volumeMountName: string;
  readonly passwordEnvVar: string;
  readonly passwordEnvVarUser?: string;
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
const INIT_RESOURCES = {
  requests: { cpu: '50m', memory: '512Mi' },
  limits: { memory: '512Mi' },
};

// Every reset script is BEST-EFFORT and always exits 0.
//
// These run as an init container in front of the tenant's database, so a
// non-zero exit crash-loops the pod and takes the database down. That trade is
// never worth it: failing to re-stamp the password degrades to "the platform
// cannot manage this database" (which the panel now surfaces as an error),
// while exiting non-zero degrades to "the tenant's site is down". Each script
// therefore probes the datadir first, guards every statement, and reports a
// loud WARNING instead of failing.

function buildMysqlFamilyResetScript(
  passwordEnvVar: string,
  bin: { readonly server: string; readonly client: string; readonly admin: string; readonly socket: string },
): string {
  const pw = `\${${passwordEnvVar}}`;
  const sock = bin.socket;
  return [
    'DATADIR=/var/lib/mysql',
    'if [ ! -d "$DATADIR/mysql" ]; then echo "No existing data, skipping password reset"; exit 0; fi',
    'echo "Existing datadir detected — re-stamping the configured root password"',
    '# The entrypoint normally creates the socket dir; we bypass it, so make it ourselves.',
    `mkdir -p "$(dirname ${sock})" 2>/dev/null || true`,
    `chown mysql:mysql "$(dirname ${sock})" 2>/dev/null || true`,
    '# Start with --skip-grant-tables so we can connect without the old password',
    `${bin.server} --user=mysql --datadir="$DATADIR" --skip-networking --skip-grant-tables &`,
    'PID=$!',
    'READY=0',
    `for i in $(seq 1 60); do if ${bin.client} -u root --socket=${sock} -e "SELECT 1" >/dev/null 2>&1; then READY=1; break; fi; sleep 1; done`,
    'if [ "$READY" = "1" ]; then',
    // FLUSH PRIVILEGES re-enables the grant system for NEW connections while this
    // one keeps full rights. IF NOT EXISTS / IF EXISTS keep the statement valid on
    // datadirs where root@localhost or root@'%' was dropped — without them a single
    // missing account aborted the whole reset.
    `  if ${bin.client} -u root --socket=${sock} -e "FLUSH PRIVILEGES; CREATE USER IF NOT EXISTS 'root'@'localhost'; ALTER USER 'root'@'localhost' IDENTIFIED BY '${pw}'; GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION; ALTER USER IF EXISTS 'root'@'%' IDENTIFIED BY '${pw}';"; then`,
    `    if ${bin.client} -u root --password="${pw}" --socket=${sock} -e "SELECT 1" >/dev/null 2>&1; then`,
    '      echo "Root password reset complete"',
    '    else',
    '      echo "WARNING: root password was re-stamped but still does not authenticate"',
    '    fi',
    '  else',
    '    echo "WARNING: root password reset failed — the platform may not be able to manage this database"',
    '  fi',
    'else',
    '  echo "WARNING: temporary server did not become ready — skipping root password reset"',
    'fi',
    `${bin.admin} -u root --password="${pw}" --socket=${sock} shutdown >/dev/null 2>&1 || kill $PID 2>/dev/null || true`,
    'wait $PID 2>/dev/null || true',
    'exit 0',
  ].join('\n');
}

function buildMariadbResetScript(passwordEnvVar: string): string {
  return buildMysqlFamilyResetScript(passwordEnvVar, {
    server: 'mariadbd',
    client: 'mariadb',
    admin: 'mariadb-admin',
    socket: '/run/mysqld/mysqld.sock',
  });
}

function buildMysqlResetScript(passwordEnvVar: string): string {
  return buildMysqlFamilyResetScript(passwordEnvVar, {
    server: 'mysqld',
    client: 'mysql',
    admin: 'mysqladmin',
    socket: '/var/run/mysqld/mysqld.sock',
  });
}

function buildPostgresqlResetScript(passwordEnvVar: string): string {
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
    'restore_hba() { if [ -f "$PGDATA/pg_hba.conf.bak" ]; then mv -f "$PGDATA/pg_hba.conf.bak" "$PGDATA/pg_hba.conf"; fi; }',
    'trap \'pg_ctl -D "$PGDATA" -m immediate -w stop >/dev/null 2>&1 || true; restore_hba\' EXIT INT TERM',
    'cp "$PGDATA/pg_hba.conf" "$PGDATA/pg_hba.conf.bak"',
    '# Temporarily allow trust auth for local connections',
    'printf "local all all trust\\nhost all all 127.0.0.1/32 trust\\nhost all all ::1/128 trust\\n" > "$PGDATA/pg_hba.conf"',
    '# Start postgres locally',
    'if pg_ctl -D "$PGDATA" -o "-c listen_addresses=\'\'" -w start; then',
    `  if psql -U postgres -c "ALTER USER postgres PASSWORD '\${${passwordEnvVar}}';"; then`,
    '    echo "Postgres password reset complete"',
    '  else',
    '    echo "WARNING: postgres password reset failed — the platform may not be able to manage this database"',
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
    'if mongod --dbpath "$DBPATH" --bind_ip 127.0.0.1 --port 27017 --logpath /tmp/mongod.log --fork; then',
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
    'adminDb.createUser({ user: "$NEW_USER", pwd: "$NEW_PWD", roles: ["root"] });',
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
  const { catalogCode, image, storagePath, volumeMountName, passwordEnvVar, passwordEnvVarUser } = input;

  if (!passwordEnvVar) return null;

  const engine = DB_ENGINES[catalogCode];
  if (!engine) return null;

  let script: string;
  let mountPath: string;
  let securityContext: Record<string, unknown> | undefined;

  switch (engine) {
    case 'mariadb':
      script = buildMariadbResetScript(passwordEnvVar);
      mountPath = '/var/lib/mysql';
      break;
    case 'mysql':
      script = buildMysqlResetScript(passwordEnvVar);
      mountPath = '/var/lib/mysql';
      break;
    case 'postgresql':
      script = buildPostgresqlResetScript(passwordEnvVar);
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
    resources: INIT_RESOURCES,
    ...(securityContext ? { securityContext } : {}),
  };
}
