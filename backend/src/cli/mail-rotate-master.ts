#!/usr/bin/env node
/**
 * mail-rotate-master — in-pod CLI entrypoint for
 * `platform-ops mail rotate-master-password`.
 *
 * Runs INSIDE the platform-api pod (in-cluster k8s + JMAP reachability to
 * Stalwart). Recovery action: rotate the Stalwart `master@local.host` Account
 * password that Roundcube's jwt_auth plugin uses for IMAP master-user
 * impersonation — the webmail recovery that was previously only an API/UI
 * button (rotate-webmail-master-password). Reuses the SAME tested service the
 * API calls (rotateWebmailMasterPassword).
 *
 * The master lives on the FIXED `MASTER_SENTINEL_DOMAIN` (decoupled from the
 * mail domain), so no apex/DB lookup is needed. The rotation auto-reseeds
 * master@<sentinel> + the Admin role if missing AND re-stamps
 * STALWART_MASTER_USER — so this is ALSO the one-shot migration for a legacy
 * install whose Secret still points at `master@mail.<oldApex>` (the API route
 * guard refuses that mismatch; this CLI has no guard and targets the sentinel).
 *
 * Output: one JSON line {"ok":true,"rotatedAt":"…","principalDomain":"…"} on
 * success. The new password is NOT printed — it's consumed by Roundcube
 * internally and stored in the mail-secrets Secret, not an operator login.
 * Exit: 0 ok · 1 runtime.
 */
import { rotateWebmailMasterPassword } from '../modules/mail-admin/rotate-webmail-master.js';
import { MASTER_SENTINEL_DOMAIN } from '../modules/mail-admin/stalwart-master-user.js';

function fail(code: number, msg: string): never {
  process.stderr.write(`mail-rotate-master: ${msg}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  // In-cluster: kubeconfigPath undefined → the service uses the pod's in-cluster
  // config. masterUsername / namespaces / roundcubeDeployment all take their
  // documented defaults (master, mail, mail-secrets, roundcube); principalDomain
  // defaults to the sentinel.
  const principalDomain = MASTER_SENTINEL_DOMAIN;
  const result = await rotateWebmailMasterPassword({ kubeconfigPath: undefined, principalDomain });

  process.stdout.write(`${JSON.stringify({ ok: true, rotatedAt: result.rotatedAt, principalDomain })}\n`);
}

main().catch((e) => fail(1, e instanceof Error ? e.message : String(e)));
