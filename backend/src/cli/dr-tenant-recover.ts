#!/usr/bin/env node
/**
 * dr-tenant-recover — in-pod CLI entrypoint for `platform-ops dr tenant-restore`.
 *
 * Runs INSIDE the platform-api pod (via `kubectl exec`), where DATABASE_URL,
 * JWT_SECRET and the RUNNING Fastify server (127.0.0.1:PORT) all live — the
 * `platform-ops` SEA binary on a bare host has none of them. It:
 *   1. reads the recover request as ONE JSON object on STDIN (never argv);
 *   2. mints a short-lived (5-min) admin access token, attributed to a REAL
 *      active admin user — the recover route persists `request.user.sub` into
 *      `restore_jobs.initiator_user_id`, an FK to `users.id`, so a synthetic
 *      subject would make the cart-create sub-request fail with an FK violation;
 *   3. POSTs it to the one-button recover route on the LOCAL server so auth,
 *      validation and the whole provision→cart→execute orchestration run through
 *      the exact same code path an operator drives from the admin panel;
 *   4. prints the route's `{ data }` / `{ error }` envelope as ONE JSON line.
 *
 * The token is a plain HS256 JWT signed with the pod's JWT_SECRET — identical to
 * what @fastify/jwt issues at login — so the route's `authenticate` decorator
 * verifies it statelessly (it does NOT re-load the user from the DB; the DB read
 * here exists ONLY to satisfy the initiator FK described above).
 *
 * Input  (STDIN, one JSON object): { tenantId, bundleId?, components?, mailboxMode?, targetNode?, provision? }
 * Output (STDOUT, one JSON line):  the recover route's `{ data: {…} }` (success)
 *                                  or `{ error: { code, message } }` (route failure) envelope.
 * Exit:  0 ok · 1 route/runtime failure · 2 setup/usage (no env, bad stdin, no admin user).
 */
import { createHmac } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb, closeDb } from '../db/index.js';
import { users } from '../db/schema.js';

/** Roles the recover route accepts (`requireRole('super_admin','admin')`). */
const ADMIN_ROLES = ['super_admin', 'admin'] as const;
/** Access-token lifetime — long enough for the synchronous recover, short by design. */
const TOKEN_TTL_SECONDS = 5 * 60;

/** Parsed STDIN request. Optionals map 1:1 to the recover route's JSON body. */
interface RecoverRequestInput {
  readonly tenantId: string;
  readonly bundleId?: string;
  readonly components?: readonly string[];
  readonly mailboxMode?: string;
  readonly targetNode?: string;
  readonly provision?: boolean;
}

function fail(code: number, msg: string): never {
  process.stderr.write(`dr-tenant-recover: ${msg}\n`);
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

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Sign a minimal HS256 JWT — the SAME shape @fastify/jwt issues at login
 * (`{ sub, role, panel, iat, exp }`) — with the pod's JWT_SECRET, so the route's
 * `authenticate` verifier accepts it without any Fastify app instance in-scope.
 */
function signAdminToken(secret: string, sub: string, role: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub, role, panel: 'admin', iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const signature = base64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function parseRequest(raw: string): RecoverRequestInput {
  const trimmed = raw.trim();
  if (!trimmed) fail(2, 'expected a JSON request object on stdin');
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    fail(2, `invalid JSON on stdin (${e instanceof Error ? e.message : String(e)})`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    fail(2, 'stdin JSON must be a request object');
  }
  const rec = obj as Record<string, unknown>;
  const tenantId = rec.tenantId;
  if (typeof tenantId !== 'string' || tenantId.length < 1) {
    fail(2, 'stdin JSON is missing a non-empty "tenantId"');
  }
  return {
    tenantId,
    bundleId: typeof rec.bundleId === 'string' ? rec.bundleId : undefined,
    components: Array.isArray(rec.components) ? rec.components.filter((c): c is string => typeof c === 'string') : undefined,
    mailboxMode: typeof rec.mailboxMode === 'string' ? rec.mailboxMode : undefined,
    targetNode: typeof rec.targetNode === 'string' ? rec.targetNode : undefined,
    provision: typeof rec.provision === 'boolean' ? rec.provision : undefined,
  };
}

/** Build the recover route body — only the fields the operator set (never tenantId). */
function buildBody(req: RecoverRequestInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (req.bundleId !== undefined) body.bundleId = req.bundleId;
  if (req.components !== undefined) body.components = req.components;
  if (req.mailboxMode !== undefined) body.mailboxMode = req.mailboxMode;
  if (req.targetNode !== undefined) body.targetNode = req.targetNode;
  if (req.provision !== undefined) body.provision = req.provision;
  return body;
}

async function main(): Promise<void> {
  const req = parseRequest(await readStdin());

  const url = process.env.DATABASE_URL;
  if (!url) fail(2, 'DATABASE_URL is not set in this pod');
  const secret = process.env.JWT_SECRET;
  if (!secret) fail(2, 'JWT_SECRET is not set in this pod');
  const port = process.env.PORT && process.env.PORT.trim() ? process.env.PORT.trim() : '3000';

  const db = getDb(url);
  let token: string;
  try {
    // Attribute the recover to a REAL active admin (oldest, deterministic) so
    // the route's `initiator_user_id` FK is satisfied. `authenticate` itself is
    // stateless — this read only backs the FK, not the auth check.
    const [admin] = await db
      .select({ id: users.id, roleName: users.roleName })
      .from(users)
      .where(and(
        inArray(users.roleName, [...ADMIN_ROLES]),
        eq(users.panel, 'admin'),
        eq(users.status, 'active'),
      ))
      .orderBy(asc(users.createdAt))
      .limit(1);
    if (!admin) fail(1, "no active admin user found to attribute the recover to (need role_name in ('admin','super_admin'), panel='admin', status='active')");
    token = signAdminToken(secret, admin.id, admin.roleName);
  } finally {
    await closeDb().catch(() => undefined);
  }

  const recoverUrl = `http://127.0.0.1:${port}/api/v1/admin/dr/tenants/${encodeURIComponent(req.tenantId)}/recover`;
  let res: Response;
  try {
    res = await fetch(recoverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(buildBody(req)),
    });
  } catch (e) {
    fail(1, `could not reach the recover route at ${recoverUrl} (${e instanceof Error ? e.message : String(e)})`);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (res.ok) {
    // Success: print the `{ data: {…} }` envelope; the host seam reads `.data`.
    emit(parsed);
    process.exit(0);
  }

  // Route failure: surface the `{ error: { code, message } }` envelope on stdout
  // (host seam lifts `.error.code`) and a human line on stderr.
  process.stderr.write(`dr-tenant-recover: recover route returned HTTP ${res.status}\n`);
  emit(parsed);
  process.exit(1);
}

main().catch((e) => fail(1, e instanceof Error ? e.message : String(e)));
