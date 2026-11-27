/**
 * What a tenant could have left on a MongoDB instance while it held root, and
 * the root password it knew.
 *
 *   - Other users holding root-like roles (root, userAdmin[AnyDatabase],
 *     dbOwner on admin, __system, a custom role defined in admin, …): any of
 *     them can make itself root again. They keep what they could do to data —
 *     readWriteAnyDatabase + dbAdminAnyDatabase in place of the admin roles —
 *     and lose the rest.
 *   - Root's own password: the tenant had it, and root may still log in from
 *     inside the pod (db-admin-access.ts), where a tenant's console query runs.
 *     So it is replaced, once, by one only the platform knows (rotateRoot;
 *     the reconciler keeps the new one before it is set, so a failure in
 *     between never leaves the platform without it).
 */

import { classifyBackupLogin } from './backup-login.js';
import { fromHex, MONGO_OK_JS, mongoResult, mongoRoot, outputLines, sh, tryRun, type Exec } from './db-exec.js';

/** Roles from the admin database a tenant account may hold: data, not accounts. */
const SAFE_ADMIN_ROLES: ReadonlySet<string> = new Set(['read', 'readWrite', 'readAnyDatabase', 'readWriteAnyDatabase', 'dbAdminAnyDatabase', 'clusterMonitor']);

/** What a demoted root-like user keeps. */
const DATA_ROLES = [{ role: 'readWriteAnyDatabase', db: 'admin' }, { role: 'dbAdminAnyDatabase', db: 'admin' }];

interface MongoUser { readonly user: string; readonly db: string; readonly roles: ReadonlyArray<{ role: string; db: string }> }

/** One line per user: hex(JSON) — names may hold anything. */
const LIST_USERS_JS = 'db.getSiblingDB("admin").getCollection("system.users").find({}, {user: 1, db: 1, roles: 1}).toArray()'
  + '.map(u => Buffer.from(JSON.stringify({user: u.user, db: u.db, roles: u.roles.map(r => ({role: r.role, db: r.db}))})).toString("hex")).join("\\n")';

/** The user's admin-database roles it may not keep. Pure. */
export function unsafeRoles(u: MongoUser): Array<{ role: string; db: string }> {
  return u.roles.filter((r) => (r.db === 'admin' && !SAFE_ADMIN_ROLES.has(r.role)) || r.db === 'config' || (r.db === 'local' && r.role !== 'read'));
}

/** Demote every user but root and `keep` (the tenant administrator). Returns what changed. */
export async function demotePrivilegedUsers(x: Exec, keep: ReadonlySet<string>): Promise<string[]> {
  const { ctx } = x;
  const out = await sh(x, mongoRoot(ctx, LIST_USERS_JS));
  const changed: string[] = [];
  const now = Date.now();
  for (const line of outputLines(out)) {
    if (!/^[0-9a-f]+$/i.test(line)) continue;
    const u = JSON.parse(fromHex(line)) as MongoUser;
    if (u.db === 'admin' && (u.user === ctx.rootUsername || keep.has(u.user))) continue;
    // A backup run's login (backup-login.ts) holds `backup` for its dump: a
    // fresh one is left alone, one left behind is dropped.
    const kind = u.db === 'admin' ? classifyBackupLogin(u.user, now) : 'other';
    if (kind === 'fresh') continue;
    if (kind === 'stale') {
      const dropped = await tryRun(x, mongoRoot(ctx, `db.getSiblingDB("admin").dropUser(${JSON.stringify(u.user)}); "ok"`));
      if (dropped.ok) {
        changed.push(`dropped ${u.user}, a backup login left behind`);
        continue;
      }
    }
    const remove = unsafeRoles(u);
    if (remove.length === 0) continue;
    const js = `const d = db.getSiblingDB(${JSON.stringify(u.db)});`
      + ` d.grantRolesToUser(${JSON.stringify(u.user)}, ${JSON.stringify(DATA_ROLES)});`
      + ` d.revokeRolesFromUser(${JSON.stringify(u.user)}, ${JSON.stringify(remove)}); "ok"`;
    await sh(x, mongoRoot(ctx, js));
    changed.push(`${u.user}@${u.db} no longer holds ${remove.map((r) => r.role).join(', ')} (it keeps read/write on every database)`);
  }
  return changed;
}

/**
 * Set root's password to `next`, given it now has ctx.rootPassword. Both go on
 * stdin (passwordPrompt() reads the second line). Returns whether `next` logs
 * in afterwards.
 */
export async function rotateRoot(x: Exec, next: string): Promise<boolean> {
  const { ctx } = x;
  const user = JSON.stringify(ctx.rootUsername);
  await sh(x, mongoRoot(ctx, `db.getSiblingDB("admin").updateUser(${user}, {pwd: passwordPrompt()}); "rotated"`, `${next}\n`));
  const proof = await tryRun(x, mongoRoot({ ...ctx, rootPassword: next }, MONGO_OK_JS));
  return proof.ok && mongoResult(proof.stdout) === 'ok';
}

/** Whether root logs in with this password (the reconciler's fallback after a rotation). */
export async function rootLogsInWith(x: Exec, password: string): Promise<boolean> {
  const r = await tryRun(x, mongoRoot({ ...x.ctx, rootPassword: password }, MONGO_OK_JS));
  return r.ok && mongoResult(r.stdout) === 'ok';
}
