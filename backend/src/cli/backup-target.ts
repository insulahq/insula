#!/usr/bin/env node
/**
 * backup-target — in-pod CLI entrypoint for `platform-ops backup target <sub>`.
 *
 * Runs INSIDE the platform-api pod (via `kubectl exec`), where DATABASE_URL +
 * PLATFORM_ENCRYPTION_KEY + the in-cluster shim reconcilers all live. Reuses the
 * backup-config service (ONE tested impl) for the config CRUD; bind/unbind write
 * the `backup_target_assignments` row directly (a class binds exactly ONE
 * target), which the running reconcilers (postgres-objectstore / etcd-cronjob /
 * mail-restic) converge on their next tick. NOTE: CLI bind skips the graceful
 * DRAIN the UI does when SWITCHING a live target's in-flight backups — fine for
 * an initial bind / unbind; use the admin panel to switch a busy live target.
 *
 * Subcommands (each prints ONE JSON line on stdout on success):
 *   list                         configs (creds stripped) + class bindings
 *   add        (JSON on stdin)   create a target (CreateBackupConfigInput)
 *   test       <id>              connectivity probe
 *   delete     <id>              delete a target (refused if active/frozen/bound)
 *   bind       <class> <id>      bind class (system|tenant|mail) → target
 *   unbind     <class>           clear a class binding
 * Exit: 0 ok · 1 runtime/not-found · 2 setup/usage.
 */
import { eq } from 'drizzle-orm';
import { getDb, closeDb } from '../db/index.js';
import { backupConfigurations, backupTargetAssignments } from '../db/schema.js';
import {
  createBackupConfig,
  listBackupConfigs,
  testConnection,
  deleteBackupConfig,
} from '../modules/backup-config/service.js';
import { createBackupConfigSchema, backupShimClassEnum } from '@insula/api-contracts';

function fail(code: number, msg: string): never {
  process.stderr.write(`backup-target: ${msg}\n`);
  process.exit(code);
}
function emit(o: unknown): void {
  process.stdout.write(`${JSON.stringify(o)}\n`);
}
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) fail(2, 'DATABASE_URL is not set in this pod');
  const key = process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64);

  const db = getDb(url);
  try {
    switch (sub) {
      case 'list': {
        const configs = await listBackupConfigs(db);
        const assignments = await db
          .select({
            backupClass: backupTargetAssignments.backupClass,
            targetId: backupTargetAssignments.targetId,
            priority: backupTargetAssignments.priority,
          })
          .from(backupTargetAssignments);
        emit({ ok: true, configs, assignments });
        break;
      }
      case 'add': {
        const raw = (await readStdin()).trim();
        if (!raw) fail(2, 'add: pipe a JSON CreateBackupConfigInput on stdin');
        let input: unknown;
        try {
          input = JSON.parse(raw);
        } catch (e) {
          fail(2, `add: invalid JSON on stdin (${e instanceof Error ? e.message : String(e)})`);
        }
        const parsed = createBackupConfigSchema.safeParse(input);
        if (!parsed.success) {
          fail(2, `add: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        }
        const cfg = await createBackupConfig(db, parsed.data, key);
        emit({ ok: true, id: cfg.id, name: cfg.name, storageType: cfg.storageType });
        break;
      }
      case 'test': {
        const id = rest[0];
        if (!id) fail(2, 'test: <id> is required');
        const r = await testConnection(db, id, key);
        emit({ ok: r.ok, result: r });
        if (!r.ok) process.exitCode = 1;
        break;
      }
      case 'delete': {
        const id = rest[0];
        if (!id) fail(2, 'delete: <id> is required');
        await deleteBackupConfig(db, id); // throws ApiError on active/frozen, FK on still-bound
        emit({ ok: true, id });
        break;
      }
      case 'bind': {
        const cls = backupShimClassEnum.safeParse(rest[0]);
        if (!cls.success) fail(2, `bind: <class> must be system|tenant|mail, got ${rest[0] ? `'${rest[0]}'` : 'none'}`);
        const id = rest[1];
        if (!id) fail(2, 'bind: <id> is required');
        const [t] = await db
          .select({ id: backupConfigurations.id })
          .from(backupConfigurations)
          .where(eq(backupConfigurations.id, id))
          .limit(1);
        if (!t) fail(1, `bind: no backup target with id '${id}'`);
        await db.transaction(async (tx) => {
          await tx.delete(backupTargetAssignments).where(eq(backupTargetAssignments.backupClass, cls.data));
          await tx.insert(backupTargetAssignments).values({ backupClass: cls.data, targetId: id, priority: 0 });
        });
        emit({ ok: true, backupClass: cls.data, targetId: id, note: 'in-cluster reconcilers converge on their next tick' });
        break;
      }
      case 'unbind': {
        const cls = backupShimClassEnum.safeParse(rest[0]);
        if (!cls.success) fail(2, `unbind: <class> must be system|tenant|mail, got ${rest[0] ? `'${rest[0]}'` : 'none'}`);
        await db.delete(backupTargetAssignments).where(eq(backupTargetAssignments.backupClass, cls.data));
        emit({ ok: true, backupClass: cls.data, unbound: true });
        break;
      }
      default:
        fail(2, `expected list|add|test|delete|bind|unbind, got ${sub ? `'${sub}'` : 'none'}`);
    }
  } finally {
    await closeDb().catch(() => undefined);
  }
}

main().catch((e) => fail(1, e instanceof Error ? e.message : String(e)));
