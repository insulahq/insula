import crypto from 'node:crypto';
import { eq, lt, and, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { nodeTerminalSessions, type NodeTerminalSessionRow } from '../../db/schema.js';

// ─── DB-backed node-terminal session store (ADR-041 evolved spec) ────
//
// Authority for "does session X exist, and what's its wsToken?" — the
// in-memory `session-registry.ts` Map remains as the owner-replica
// fast path for the live WS handle (which can't be serialised), but
// every existence check goes through here.

export interface SessionRow {
  readonly id: string;
  readonly nodeName: string;
  readonly podName: string;
  readonly podNamespace: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly clientIp: string;
  readonly ownerReplica: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastActivityAt: Date;
  /** When non-null, the scheduler will terminate this session once
   *  now() > terminateAfter. Set by the WS close handler; cleared by
   *  refreshWsToken (reconnect) or by an explicit terminate frame. */
  readonly terminateAfter: Date | null;
}

export interface InsertInput {
  readonly id: string;
  readonly nodeName: string;
  readonly podName: string;
  readonly podNamespace?: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly clientIp: string;
  readonly wsToken: string;
  readonly ownerReplica: string;
  readonly expiresAt: Date;
}

/** SHA-256 of the wsToken — token entropy is already 256 bits random
 *  (crypto.randomBytes(32)), so a cryptographic hash with no salt is
 *  appropriate. A salted KDF (argon2/bcrypt) is for low-entropy
 *  passwords; for a 256-bit random secret, SHA-256 + constant-time
 *  compare is correct. */
export function hashWsToken(rawToken: string): Buffer {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest();
}

function rowToSession(r: NodeTerminalSessionRow): SessionRow {
  return {
    id: r.id,
    nodeName: r.nodeName,
    podName: r.podName,
    podNamespace: r.podNamespace,
    userId: r.userId,
    userEmail: r.userEmail,
    clientIp: r.clientIp,
    ownerReplica: r.ownerReplica,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    lastActivityAt: r.lastActivityAt,
    terminateAfter: r.terminateAfter ?? null,
  };
}

/** Insert a fresh session row. Caller hashes the wsToken — never
 *  stores the raw token. Used by createSession in service.ts. */
export async function insertSession(db: Database, input: InsertInput): Promise<void> {
  await db.insert(nodeTerminalSessions).values({
    id: input.id,
    nodeName: input.nodeName,
    podName: input.podName,
    podNamespace: input.podNamespace ?? 'platform',
    userId: input.userId,
    userEmail: input.userEmail,
    clientIp: input.clientIp,
    wsTokenHash: hashWsToken(input.wsToken),
    wsTokenIssuedAt: new Date(),
    ownerReplica: input.ownerReplica,
    expiresAt: input.expiresAt,
  });
}

/** Fetch a session by id. Returns null if not found OR expired. */
export async function findById(db: Database, sessionId: string): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(nodeTerminalSessions)
    .where(eq(nodeTerminalSessions.id, sessionId))
    .limit(1);
  if (!row) return null;
  // Treat expired rows as not-found from the caller's POV. The
  // sweeper deletes them; we just don't honour them here.
  //
  // Why app-clock vs. SQL `WHERE expires_at > NOW()`: the sweeper
  // already filters at the DB level (findExpired below), so a fully
  // expired row that hits findById is almost certainly already on
  // its way out — surfacing null here is purely defence-in-depth.
  // App-clock comparison keeps findById a single round-trip without
  // a NOW() roundtrip; clock skew between platform-api and the DB
  // is bounded to seconds and the WS-token TTL (60s) is the real
  // gate on freshness anyway.
  if (row.expiresAt.getTime() < Date.now()) return null;
  return rowToSession(row);
}

/** Atomically validate the wsToken and burn it in one SQL statement.
 *  Returns the session row IF (and only if) the presented hash matched
 *  an active row whose token was issued within the TTL window AND was
 *  not already consumed. The hash slot is set to NULL atomically so
 *  the same token can never be replayed.
 *
 *  Also CLEARS `terminate_after` in the same UPDATE — closes the
 *  TOCTOU window where a scheduler sweep could read a still-pending
 *  termination AFTER the WS has successfully re-attached but BEFORE
 *  a follow-up cancelDelayedTermination round-trip lands. Without
 *  this, a freshly-reconnected session could have its Pod deleted
 *  out from under it. (Security review HIGH finding, 2026-05-20.)
 *
 *  Note: the comparison is by exact hash equality at the DB level —
 *  Postgres compares bytea byte-for-byte without short-circuit, which
 *  is the same constant-time property we want.
 */
export async function consumeWsToken(
  db: Database,
  sessionId: string,
  presentedToken: string,
  ttlMs: number = 60_000,
): Promise<SessionRow | null> {
  const presentedHash = hashWsToken(presentedToken);
  const cutoff = new Date(Date.now() - ttlMs);
  const [row] = await db
    .update(nodeTerminalSessions)
    .set({
      wsTokenHash: null,
      wsTokenIssuedAt: null,
      lastActivityAt: new Date(),
      // Cancel any in-flight grace-period termination atomically with
      // the token consume. See doc comment above.
      terminateAfter: null,
    })
    .where(
      and(
        eq(nodeTerminalSessions.id, sessionId),
        eq(nodeTerminalSessions.wsTokenHash, presentedHash),
        // wsTokenIssuedAt > now - ttl
        sql`${nodeTerminalSessions.wsTokenIssuedAt} > ${cutoff}`,
      ),
    )
    .returning();
  if (!row) return null;
  return rowToSession(row);
}

/** Replace the wsToken on an existing session — used by the
 *  reconnect endpoint (POST .../sessions/:id/ws-token) to mint a
 *  fresh single-use token after the old one was consumed.
 *
 *  Also CLEARS terminate_after — minting a fresh token implies the
 *  user is actively reconnecting, so the grace-period termination
 *  must be cancelled in the same atomic UPDATE. Otherwise an in-
 *  flight reconnect could race with the scheduler's reap query.
 *
 *  Returns the row IF the session exists and is owned by the calling
 *  user (caller checks ownership separately; this helper only sets
 *  the hash atomically). */
export async function refreshWsToken(
  db: Database,
  sessionId: string,
  newToken: string,
): Promise<SessionRow | null> {
  const [row] = await db
    .update(nodeTerminalSessions)
    .set({
      wsTokenHash: hashWsToken(newToken),
      wsTokenIssuedAt: new Date(),
      terminateAfter: null, // cancel pending grace-period termination
    })
    .where(eq(nodeTerminalSessions.id, sessionId))
    .returning();
  if (!row) return null;
  return rowToSession(row);
}

/** Schedule a delayed termination for `sessionId`. Called from the
 *  WS close handler when the client did NOT send an explicit
 *  terminate frame — i.e. ambiguous drops (page reload, network blip,
 *  replica restart) get a grace period during which a fresh reconnect
 *  can save the session.
 *
 *  Idempotent — calling twice replaces the timestamp. */
export async function setTerminateAfter(
  db: Database,
  sessionId: string,
  terminateAfter: Date,
): Promise<void> {
  await db
    .update(nodeTerminalSessions)
    .set({ terminateAfter })
    .where(eq(nodeTerminalSessions.id, sessionId));
}

/** Cancel a pending delayed termination. Called by refreshWsToken
 *  implicitly (in the same atomic UPDATE), but also exported so the
 *  in-memory grace timer can mirror cancellation when a re-attach
 *  happens via a fresh exec stream without a /ws-token round-trip. */
export async function clearTerminateAfter(
  db: Database,
  sessionId: string,
): Promise<void> {
  await db
    .update(nodeTerminalSessions)
    .set({ terminateAfter: null })
    .where(eq(nodeTerminalSessions.id, sessionId));
}

/** Sessions whose grace period has elapsed — `terminate_after < now()`.
 *  Used by the cross-replica scheduler as the authoritative reaper:
 *  the in-memory setTimeout dies with its replica, but this query
 *  catches the orphan on the next sweep tick. */
export async function findReadyForTermination(db: Database): Promise<SessionRow[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(nodeTerminalSessions)
    .where(
      and(
        // IS NOT NULL via sql template; Drizzle's isNotNull on a
        // composed AND with lt was awkward, so use the SQL fragment.
        sql`${nodeTerminalSessions.terminateAfter} IS NOT NULL`,
        lt(nodeTerminalSessions.terminateAfter, now),
      ),
    );
  return rows.map(rowToSession);
}

/** Update which replica last attached an exec stream for diagnostics
 *  and stickiness telemetry. Also bumps last_activity_at. */
export async function updateOwnerReplica(
  db: Database,
  sessionId: string,
  ownerReplica: string,
): Promise<void> {
  await db
    .update(nodeTerminalSessions)
    .set({ ownerReplica, lastActivityAt: new Date() })
    .where(eq(nodeTerminalSessions.id, sessionId));
}

/** Touch the activity clock. Batched/throttled by the caller —
 *  hammering this on every stdin keystroke would be wasteful. */
export async function updateActivity(db: Database, sessionId: string): Promise<void> {
  await db
    .update(nodeTerminalSessions)
    .set({ lastActivityAt: new Date() })
    .where(eq(nodeTerminalSessions.id, sessionId));
}

/** Delete a session row. Idempotent. Returns true if a row was
 *  actually removed, false if it was already gone. */
export async function deleteSession(db: Database, sessionId: string): Promise<boolean> {
  const rows = await db
    .delete(nodeTerminalSessions)
    .where(eq(nodeTerminalSessions.id, sessionId))
    .returning({ id: nodeTerminalSessions.id });
  return rows.length > 0;
}

/** Sessions whose lastActivityAt is older than `idleMs` ago. Used by
 *  the cross-replica idle sweeper — any platform-api can now reap
 *  any session, not just one owned locally. */
export async function findIdle(db: Database, idleMs: number): Promise<SessionRow[]> {
  const cutoff = new Date(Date.now() - idleMs);
  const rows = await db
    .select()
    .from(nodeTerminalSessions)
    .where(lt(nodeTerminalSessions.lastActivityAt, cutoff));
  return rows.map(rowToSession);
}

/** Sessions whose expires_at has elapsed. Same cleanup path —
 *  belt-and-braces with k8s activeDeadlineSeconds. */
export async function findExpired(db: Database): Promise<SessionRow[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(nodeTerminalSessions)
    .where(lt(nodeTerminalSessions.expiresAt, now));
  return rows.map(rowToSession);
}

/** All active sessions for a given node — used by the GET
 *  /admin/nodes/:nodeName/terminal/sessions endpoint. */
export async function listForNode(db: Database, nodeName: string): Promise<SessionRow[]> {
  const rows = await db
    .select()
    .from(nodeTerminalSessions)
    .where(eq(nodeTerminalSessions.nodeName, nodeName));
  return rows.map(rowToSession);
}

/** All active sessions cluster-wide — used by GET
 *  /admin/node-terminal/sessions. */
export async function listAll(db: Database): Promise<SessionRow[]> {
  const rows = await db.select().from(nodeTerminalSessions);
  return rows.map(rowToSession);
}
