#!/usr/bin/env node
/**
 * admin-reset-password — in-pod CLI entrypoint for `platform-ops admin reset-password`.
 *
 * Runs INSIDE the platform-api pod (via `kubectl exec`), where native bcrypt and
 * the pod's DATABASE_URL are available — the `platform-ops` SEA binary can't load
 * the native bcrypt binding on a bare host. The host-side command
 * (backend/src/cli/platform-ops/admin.ts) execs this with the email via --email
 * and the cleartext password via STDIN (never argv → never in `ps`/exec logs).
 * It hashes with the backend's own `hashNewPassword` (ONE tested impl) and
 * updates `users.password_hash` + writes an audit row.
 *
 * This consolidates scripts/admin-password-reset.sh's split-across-two-pods
 * kubectl logic (which carried the multi-container `-c postgres` bug) into one
 * tested TS path that runs entirely in the platform-api pod. The bash script
 * stays as the break-glass for a fully-broken cluster (ADR-045 / R18 policy).
 *
 * Inputs:
 *   --email <addr>   target user (REQUIRED; must already exist — does NOT create)
 *   STDIN            the new cleartext password (REQUIRED, ≥1 char)
 * Output: one JSON line on stdout: {"ok":true,"userId":"…","email":"…"}.
 * Exit:   0 ok · 1 user-not-found / runtime · 2 setup error (no DATABASE_URL/email).
 */
import { eq } from 'drizzle-orm';
import { clearTotp } from '../modules/auth/totp-service.js';
import { randomUUID } from 'node:crypto';
import { getDb, closeDb } from '../db/index.js';
import { users, auditLogs } from '../db/schema.js';
import { hashNewPassword } from '../modules/auth/service.js';

function fail(code: number, msg: string): never {
  process.stderr.write(`admin-reset-password: ${msg}\n`);
  process.exit(code);
}

function parseEmail(argv: string[]): string {
  const i = argv.indexOf('--email');
  const v = i === -1 ? undefined : argv[i + 1];
  if (!v) fail(2, '--email <addr> is required');
  return v;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const email = parseEmail(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) fail(2, 'DATABASE_URL is not set in this pod');

  // Password via stdin. Strip a single trailing newline (the piped echo) only —
  // do NOT trim other whitespace, since a password may legitimately contain it.
  const password = (await readStdin()).replace(/\r?\n$/, '');
  if (password.length < 1) fail(2, 'empty password on stdin');

  const db = getDb(url);
  try {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!user) fail(1, `no user with email '${email}'`);

    const passwordHash = await hashNewPassword(password);
    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    // Operator escape-hatch (mirrors the bash reset): a user who lost their
    // authenticator app must be able to sign in with the new password alone,
    // so the reset also removes TOTP and its backup codes. They can set it up
    // again. Passkeys are untouched — a passkey never gates a password.
    const totpCleared = await clearTotp(db, user.id);

    // Best-effort audit row (fire-and-forget, matching middleware/audit.ts). The
    // password change has already committed; a failed audit insert must NOT make
    // the host-side CLI report the reset as failed (which would mislead the
    // operator into re-running it). Failures are swallowed, not surfaced.
    await db
      .insert(auditLogs)
      .values({
        id: randomUUID(),
        actorId: user.id, // self-reset semantics; actor_id is NOT NULL
        actorType: 'system',
        actionType: 'admin_password_reset_via_cli',
        resourceType: 'user',
        resourceId: user.id,
        httpMethod: 'CLI',
        httpPath: '/platform-ops/admin/reset-password',
        httpStatus: 200,
        changes: { totpCleared },
      })
      .catch(() => undefined);

    process.stdout.write(`${JSON.stringify({ ok: true, userId: user.id, email, totpCleared })}\n`);
  } finally {
    await closeDb().catch(() => undefined);
  }
}

main().catch((e) => fail(1, e instanceof Error ? e.message : String(e)));
