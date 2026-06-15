#!/usr/bin/env node
/**
 * mail-rotate-master — in-pod CLI entrypoint for
 * `platform-ops mail rotate-master-password`.
 *
 * Runs INSIDE the platform-api pod (in-cluster k8s + the DB for the apex + JMAP
 * reachability to Stalwart). Recovery action: rotate the Stalwart
 * `master@mail.<apex>` Account password that Roundcube's jwt_auth plugin uses for
 * IMAP master-user impersonation — the webmail recovery that was previously only
 * an API/UI button (rotate-webmail-master-password). Reuses the SAME tested
 * service the API calls (rotateWebmailMasterPassword); resolves the master
 * principal's Domain as the canonical `mail.<apex>` (the rotation auto-reseeds
 * the principal if it's missing — drift heals without an extra step).
 *
 * Output: one JSON line {"ok":true,"rotatedAt":"…","principalDomain":"…"} on
 * success. The new password is NOT printed — it's consumed by Roundcube
 * internally and stored in the mail-secrets Secret, not an operator login.
 * Exit: 0 ok · 1 runtime · 2 setup (no DATABASE_URL / no apex configured).
 */
import { getDb, closeDb } from '../db/index.js';
import { getPlatformApex } from '../modules/system-settings/platform-domain.js';
import { rotateWebmailMasterPassword } from '../modules/mail-admin/rotate-webmail-master.js';

function fail(code: number, msg: string): never {
  process.stderr.write(`mail-rotate-master: ${msg}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) fail(2, 'DATABASE_URL is not set in this pod');

  const db = getDb(url);
  let apex: string | null;
  try {
    apex = await getPlatformApex(db);
  } finally {
    await closeDb().catch(() => undefined);
  }
  if (!apex) fail(2, 'platform apex is not configured (platform_settings.platform_domain) — cannot resolve mail.<apex>');

  const principalDomain = `mail.${apex}`.toLowerCase();
  // In-cluster: kubeconfigPath undefined → the service uses the pod's in-cluster
  // config. masterUsername / namespaces / roundcubeDeployment all take their
  // documented defaults (master, mail, mail-secrets, roundcube).
  const result = await rotateWebmailMasterPassword({ kubeconfigPath: undefined, principalDomain });

  process.stdout.write(`${JSON.stringify({ ok: true, rotatedAt: result.rotatedAt, principalDomain })}\n`);
}

main().catch((e) => fail(1, e instanceof Error ? e.message : String(e)));
