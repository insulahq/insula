/**
 * reconcile-master-credential — keep Stalwart's webmail master Account
 * (`master@<sentinel>`) CONVERGED with `mail-secrets` so a Stalwart
 * redeploy/restore that resets or wipes the account can never leave webmail
 * login + impersonation persistently broken.
 *
 * Why this exists
 * ---------------
 * `mail-secrets/STALWART_MASTER_PASSWORD` is the source of truth — Bulwark and
 * Roundcube authenticate to Stalwart as the master with it. Stalwart stores the
 * account credential in its OWN data store (rocksdb). A Stalwart pod
 * redeploy/restore, a snapshot rollback, or a half-run migration can revert or
 * drop that stored credential, leaving `mail-secrets` and Stalwart out of sync:
 * every `<mailbox>%<master>` proxy login then fails and ALL webmail
 * impersonation silently breaks (observed on staging 2026-07-01 after the
 * 0.16.11 bump). Nothing re-converges it — which is the drift this closes.
 *
 * What it does
 * ------------
 * Ensures the master authenticates with the mail-secrets password. If it
 * already does → no-op. If it does not (missing / reset / password drift) →
 * RE-ASSERT the existing mail-secrets password onto Stalwart (creating the
 * account with the Admin role if absent), WITHOUT generating a new password or
 * rolling Bulwark/Roundcube — they already hold this value, so there is nothing
 * for them to pick up. This is the key difference from
 * `rotateWebmailMasterPassword` (which mints a NEW password and rolls webmail):
 * a reconciler that runs on every drift tick must not churn the password or the
 * webmail pods.
 *
 * Invoked by the principals-sync drift detector when it sees master drift, so
 * any redeploy/restore reset self-heals within one reconcile cycle. Kill-switch
 * for the caller: `MAIL_MASTER_AUTOHEAL=disable`.
 */
import type { CoreV1Api } from '@kubernetes/client-node';
import { rotateAdminPasswordViaJmap } from './rotate-jmap.js';
import {
  readStalwartMasterUser,
  readStalwartMasterPassword,
  MASTER_SENTINEL_DOMAIN,
  MASTER_USER_KEY,
  MAIL_SECRET_NAMESPACE,
  MAIL_SECRET_NAME,
} from './stalwart-master-user.js';
import { verifyMasterJmapAuth } from '../stalwart-jmap/client.js';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'mail-reconcile-master' });

export type MasterReconcileStatus = 'skipped' | 'ok' | 'healed' | 'failed';

export interface ReconcileMasterOptions {
  readonly core: CoreV1Api | null | undefined;
  /** Stalwart JMAP base URL; defaults to STALWART_MGMT_URL inside the client. */
  readonly baseUrl?: string;
  /** Kubeconfig path; undefined = in-cluster (the normal platform-api case). */
  readonly kubeconfigPath?: string | undefined;
  /**
   * A guaranteed-present mailbox (`_system@<apex>`) the master must be able to
   * IMPERSONATE. When set, the convergence probes test `<target>%<master>`
   * rather than a bare master login — so this reconcile detects (and its
   * post-heal check requires) that the master retains impersonate capability,
   * not merely that it can authenticate as itself. Undefined ⇒ direct-auth
   * probe (unbootstrapped apex, or caller opted out).
   */
  readonly impersonateTarget?: string;
}

export interface MasterReconcileResult {
  readonly status: MasterReconcileStatus;
  readonly healed: boolean;
  readonly detail: string;
}

export async function reconcileStalwartMasterCredential(
  opts: ReconcileMasterOptions,
): Promise<MasterReconcileResult> {
  if (!opts.core) return { status: 'skipped', healed: false, detail: 'no k8s client' };

  const masterUser = (await readStalwartMasterUser(opts.core)).trim().toLowerCase();
  const masterPw = await readStalwartMasterPassword(opts.core);
  if (!masterPw) {
    return { status: 'skipped', healed: false, detail: 'no STALWART_MASTER_PASSWORD in mail-secrets' };
  }

  // Already converged? (verifyMasterJmapAuth throws on a transient/non-auth
  // error — never mutate on an unclear signal.) When an impersonation target is
  // supplied, "converged" means the master can IMPERSONATE it — a bare login
  // (which the config fallback-admin satisfies even with the principal gone) is
  // NOT enough. This is what makes the auto-heal fire on the 2026-07-03 class:
  // master authenticates but cannot impersonate → still drift.
  try {
    const probe = await verifyMasterJmapAuth(masterUser, masterPw, opts.baseUrl, {
      impersonateTarget: opts.impersonateTarget,
    });
    if (probe.ok) {
      return {
        status: 'ok',
        healed: false,
        detail: `master already ${probe.mode === 'impersonation' ? 'impersonates' : 'authenticates'}`,
      };
    }
  } catch (err) {
    return {
      status: 'skipped',
      healed: false,
      detail: `auth probe inconclusive (transient): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Drifted → re-assert the mail-secrets password onto Stalwart. autoReseed
  // (re)creates the account + Admin role if it was wiped; explicitPassword
  // keeps the Secret + webmail untouched.
  const atIdx = masterUser.indexOf('@');
  const username = atIdx > 0 ? masterUser.slice(0, atIdx) : 'master';
  const principalDomain = atIdx > 0 ? masterUser.slice(atIdx + 1) : MASTER_SENTINEL_DOMAIN;
  try {
    await rotateAdminPasswordViaJmap({
      kubeconfigPath: opts.kubeconfigPath,
      stalwartNamespace: MAIL_SECRET_NAMESPACE,
      secretName: MAIL_SECRET_NAME,
      username,
      secretKeys: ['STALWART_MASTER_PASSWORD'],
      extraStringData: { [MASTER_USER_KEY]: masterUser },
      explicitPassword: masterPw, // converge to the existing secret — no new pw, no webmail roll
      skipJmapSessionVerify: true, // verified below via verifyMasterJmapAuth
      principalDomain,
      autoReseed: true,
      principalRoles: { '@type': 'Admin' },
      cleanupStaleMastersInOtherDomains: true,
      principalDescription:
        'Webmail master account (Roundcube + Bulwark JWT impersonation). DO NOT DELETE — auto-reconciled from mail-secrets.',
    });
  } catch (err) {
    log.error(
      { masterUser, err: err instanceof Error ? err.message : String(err) },
      'master credential re-assert FAILED',
    );
    return {
      status: 'failed',
      healed: false,
      detail: `re-assert threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Confirm convergence — via impersonation when a target is supplied, so a
  // reseed that restores login but NOT impersonate capability is reported as a
  // FAILED heal (not a false success). This is the check that surfaces the
  // 2026-07-03 "reseed did not restore impersonation" gap.
  let after = false;
  try {
    after = (await verifyMasterJmapAuth(masterUser, masterPw, opts.baseUrl, {
      impersonateTarget: opts.impersonateTarget,
    })).ok;
  } catch {
    after = false;
  }
  if (after) {
    log.info({ masterUser }, 'master credential re-asserted from mail-secrets — impersonation restored');
    return { status: 'healed', healed: true, detail: 're-asserted master password from mail-secrets' };
  }
  return {
    status: 'failed',
    healed: false,
    detail: opts.impersonateTarget
      ? 're-assert did not converge (master still cannot impersonate)'
      : 're-assert did not converge (still not authenticating)',
  };
}
