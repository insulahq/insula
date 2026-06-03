/**
 * Version-poller Job entrypoint (W11). Runs hourly as a CronJob in the
 * `platform` namespace (k8s/base/version-poller/cronjob.yaml), or ad-hoc.
 *
 * Fetches the upstream repo's GitHub Releases, selects the newest eligible one,
 * downloads its cosign-signed `release-manifest.json`, verifies the signature
 * against the pinned key, and persists `platform_settings.available_version`
 * ONLY when verification passes (fail-closed otherwise). See
 * backend/src/modules/platform-updates/poller/ for the verified logic.
 *
 * Inputs (env vars):
 *   DATABASE_URL              required — platform DB (from platform-db-credentials)
 *   PLATFORM_RELEASES_REPO    optional — owner/repo to poll (default insulahq/insula)
 *   PLATFORM_COSIGN_PUB_PATH  optional — pinned key path (default /app/platform/cosign.pub)
 *   GITHUB_TOKEN              optional — raises GitHub API rate limit (public repo needs none)
 *
 * This Job mounts NEITHER JWT_SECRET nor the k8s API (it only reads GitHub and
 * writes one DB table), so it carries far less privilege than the API pod —
 * loadConfig() is intentionally NOT called.
 *
 * Exit codes:
 *   0 = poll completed (verified, or a benign no-releases/unreachable result)
 *   1 = the poll REFUSED a release (unsigned / verify-failed / invalid-manifest)
 *       — a security-relevant non-success; reserved for that case so monitoring
 *       can alert on it without firing on transient infra errors.
 *   2 = setup OR runtime error (missing DATABASE_URL, unreadable key, DB connect
 *       failed, or an unexpected exception mid-poll)
 */

import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../db/index.js';
import { runVersionPoll, readPinnedPublicKey } from '../modules/platform-updates/poller/index.js';

// Redact credentials from any connection string that leaked into an error
// message before it reaches stdout (kubectl logs is readable namespace-wide).
function scrubDsn(msg: string | undefined): string | undefined {
  return msg?.replace(/(\w+:\/\/)[^@\s/]*@/g, '$1***@');
}

function fail(code: number, msg: string, extra?: Record<string, unknown>): never {
  console.error(JSON.stringify({ msg: `version-poll-job: ${msg}`, ...extra }));
  process.exit(code);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail(2, 'DATABASE_URL env var is required');

  // No key ⇒ nothing can be verified ⇒ refuse to run (fail-closed at the door).
  let publicKeyPem: string;
  try {
    publicKeyPem = readPinnedPublicKey(process.env);
  } catch (err) {
    fail(2, 'pinned cosign public key is unreadable — refusing to poll', { error: (err as Error).message });
  }

  const db = getDb(databaseUrl);
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    const e = err as Error & { cause?: Error };
    await closeDb().catch(() => undefined);
    fail(2, 'db-connect failed', { error: scrubDsn(e.message), cause: scrubDsn(e.cause?.message) });
  }

  try {
    const result = await runVersionPoll({
      db,
      env: process.env,
      publicKeyPem,
      log: (level, msg) => console.log(JSON.stringify({ level, msg })),
    });
    console.log(JSON.stringify({ msg: 'version-poll-job complete', ...result }));
    await closeDb();
    // A refused release (unsigned/verify-failed/invalid-manifest) is a security-
    // relevant non-success: exit 1 so the Job surfaces as Failed and operators
    // see it. Benign outcomes (verified / no-releases / unreachable) exit 0.
    const refused = result.status === 'unsigned' || result.status === 'verify-failed' || result.status === 'invalid-manifest';
    process.exit(refused ? 1 : 0);
  } catch (err) {
    const e = err as Error;
    await closeDb().catch(() => undefined);
    // An unexpected exception (e.g. the DB vanished mid-poll) is a RUNTIME error,
    // not a security "refused release" — exit 2, keeping exit 1 for the latter.
    fail(2, 'poll failed', { error: scrubDsn(e.message) });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ msg: 'version-poll-job: unhandled', error: (err as Error).message }));
  process.exit(1);
});
