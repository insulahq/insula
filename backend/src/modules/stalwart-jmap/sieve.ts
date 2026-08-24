/**
 * Platform-managed per-account Sieve scripts ("platform-mail-rules") +
 * the send-only permission profile.
 *
 * This is the platform's ONE inbound-shaping mechanism per mailbox
 * (verified live against Stalwart v0.16.16, 2026-08-24):
 *
 *   mailbox   + forwarding → `redirect :copy` per target — forwards AND
 *                            keeps the local copy (implicit keep intact).
 *   send_only + forwarding → plain `redirect` per target — the first
 *                            redirect cancels the implicit keep, so
 *                            nothing is stored locally.
 *   send_only, no forwarding → `ereject` — inbound is refused with a
 *                            MAILER-DAEMON bounce to the sender (verified:
 *                            Stalwart accepts at SMTP, then DSNs; a
 *                            disabled `emailReceive` permission would
 *                            silently DROP instead, which hides the
 *                            misdirected mail from everyone).
 *   mailbox, no forwarding  → no script (delete ours if present).
 *
 * The script is installed cross-account by the admin credential
 * (Stalwart's admin role carries `impersonate`): blob upload into the
 * user's account, then `SieveScript/set` create/update + activate.
 *
 * A user's account has ONE active script. The platform owns the
 * `platform-mail-rules` name; send-only accounts additionally get
 * `sieveAuthenticate` disabled so the account itself cannot replace it
 * via ManageSieve. Normal mailboxes keep ManageSieve access — a power
 * user CAN override the platform script; the platform DB stays
 * authoritative and the boot reconcile re-pushes it.
 *
 * NOTE for tenant-backup tooling: `platform-mail-rules` is a reserved
 * script name (images/tenant-backup-tools/jmap-aux-restore.py) so a
 * tenant restore does not clobber the live platform-managed script.
 */
import { mailLogger } from '../../shared/mail-logger.js';
import {
  rawStalwartCall,
  uploadBlob,
  updatePrincipal,
  JmapError,
  type JmapAccountId,
} from './client.js';

const log = mailLogger().child({ module: 'stalwart-sieve' });

/** Reserved platform-managed script name. */
export const PLATFORM_SIEVE_SCRIPT_NAME = 'platform-mail-rules';

const JMAP_SIEVE = 'urn:ietf:params:jmap:sieve';
const JMAP_STALWART = 'urn:stalwart:jmap';

/**
 * Sieve interpreter ceilings the platform requires for multi-target
 * forwarding. Stalwart defaults are maxRedirects=1 (!) and
 * maxOutMessages=3 — a script with more redirects than the ceiling
 * SILENTLY delivers only the first target (verified live). The contract
 * allows up to 20 forwarding targets, so the interpreter must at least
 * match that; maxOutMessages gets headroom for a future vacation reply.
 */
export const REQUIRED_MAX_REDIRECTS = 20;
export const REQUIRED_MAX_OUT_MESSAGES = 25;

export type MailRulesMailboxType = 'mailbox' | 'send_only';

/**
 * Escape a string for inclusion in a double-quoted Sieve string
 * (RFC 5228 §2.4.2: backslash and double-quote).
 */
function sieveQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build the platform-mail-rules script for a mailbox's desired state.
 * Returns null when no script is needed (normal mailbox, no forwarding)
 * — the caller then removes any existing platform script.
 *
 * Exported pure for unit tests.
 */
export function buildMailRulesScript(
  mailboxType: MailRulesMailboxType,
  forwardingAddresses: readonly string[],
): string | null {
  const targets = forwardingAddresses.filter((a) => a.trim().length > 0);
  if (mailboxType === 'mailbox' && targets.length === 0) return null;

  const lines: string[] = [
    '# Managed by the hosting platform — do not edit.',
    '# Regenerated from the mailbox forwarding settings on every change.',
  ];
  if (targets.length === 0) {
    // send_only, no forwarding: refuse inbound with a bounce.
    lines.push('require ["ereject"];');
    lines.push('ereject "This address does not accept incoming mail.";');
  } else if (mailboxType === 'mailbox') {
    lines.push('require ["copy"];');
    for (const t of targets) lines.push(`redirect :copy ${sieveQuote(t)};`);
  } else {
    // send_only: plain redirect cancels the implicit keep — not stored.
    for (const t of targets) lines.push(`redirect ${sieveQuote(t)};`);
  }
  return `${lines.join('\n')}\n`;
}

interface SieveScriptGetResponse {
  readonly list?: readonly { id: string; name?: string; isActive?: boolean }[];
}

interface SieveScriptSetResponse {
  readonly created?: Record<string, { id: string } | null>;
  readonly updated?: Record<string, unknown>;
  readonly destroyed?: readonly string[];
  readonly notCreated?: Record<string, { type: string; description?: string }>;
  readonly notUpdated?: Record<string, { type: string; description?: string }>;
  readonly notDestroyed?: Record<string, { type: string; description?: string }>;
}

async function findPlatformScriptId(
  principalId: string,
  baseUrl?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  const res = await rawStalwartCall<SieveScriptGetResponse>({
    using: [JMAP_SIEVE],
    method: 'SieveScript/get',
    args: { accountId: principalId, ids: null },
    baseUrl,
    env,
  });
  const match = (res.list ?? []).find((s) => s.name === PLATFORM_SIEVE_SCRIPT_NAME);
  return match?.id ?? null;
}

function firstSetError(
  res: SieveScriptSetResponse,
): { type: string; description?: string } | null {
  for (const bucket of [res.notCreated, res.notUpdated, res.notDestroyed]) {
    const first = bucket && Object.values(bucket)[0];
    if (first) return first;
  }
  return null;
}

/**
 * Reconcile the platform-managed Sieve script on a Stalwart account to
 * the desired mailbox state. Idempotent create-or-update-or-remove.
 *
 * Throws JmapError on failure — callers surface it (forwarding must
 * fail VISIBLY; a silently-dropped script is exactly the DB-only-fiction
 * failure mode this feature replaces).
 */
export async function applyMailRules(params: {
  /** The USER's Stalwart principal id (JMAP account id for its data). */
  principalId: string;
  mailboxType: MailRulesMailboxType;
  forwardingAddresses: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { principalId, mailboxType, forwardingAddresses, baseUrl, env } = params;
  const script = buildMailRulesScript(mailboxType, forwardingAddresses);
  const existingId = await findPlatformScriptId(principalId, baseUrl, env);

  if (script === null) {
    if (existingId === null) return;
    // Deactivate, then destroy. Two calls — a destroy of the still-active
    // script is rejected with `scriptIsActive`. Stalwart's deactivation
    // argument is `onSuccessDeactivateScript: true` (verified against
    // v0.16.16 source, crates/jmap-proto/src/object/sieve.rs — an
    // `onSuccessActivateScript: null` parses to Option::None = no-op,
    // which left the script ACTIVE; caught live 2026-08-24).
    await rawStalwartCall<SieveScriptSetResponse>({
      using: [JMAP_SIEVE],
      method: 'SieveScript/set',
      args: { accountId: principalId, onSuccessDeactivateScript: true },
      baseUrl,
      env,
    });
    const res = await rawStalwartCall<SieveScriptSetResponse>({
      using: [JMAP_SIEVE],
      method: 'SieveScript/set',
      args: { accountId: principalId, destroy: [existingId] },
      baseUrl,
      env,
    });
    const err = firstSetError(res);
    if (err) {
      // Destroy failed — whether this is acceptable depends on the script's
      // ACTIVATION state: an inactive leftover is inert, but an ACTIVE
      // leftover keeps forwarding mail the platform DB says is off. Verify
      // and fail VISIBLY in the active case.
      const check = await rawStalwartCall<SieveScriptGetResponse>({
        using: [JMAP_SIEVE],
        method: 'SieveScript/get',
        args: { accountId: principalId, ids: [existingId] },
        baseUrl,
        env,
      });
      const leftover = check.list?.[0];
      if (leftover?.isActive) {
        throw new JmapError(
          `platform-mail-rules could not be deactivated: ${err.description ?? err.type}`,
          err.type,
          err,
        );
      }
      log.warn({ principalId, err }, 'platform-mail-rules destroy failed (script is deactivated; leftover is inert)');
    }
    return;
  }

  const { blobId } = await uploadBlob({
    accountId: principalId,
    content: script,
    contentType: 'application/sieve',
    baseUrl,
    env,
  });

  const args: Record<string, unknown> = existingId
    ? {
        accountId: principalId,
        update: { [existingId]: { blobId } },
        onSuccessActivateScript: existingId,
      }
    : {
        accountId: principalId,
        create: { s1: { name: PLATFORM_SIEVE_SCRIPT_NAME, blobId } },
        onSuccessActivateScript: '#s1',
      };
  const res = await rawStalwartCall<SieveScriptSetResponse>({
    using: [JMAP_SIEVE],
    method: 'SieveScript/set',
    args,
    baseUrl,
    env,
  });
  const err = firstSetError(res);
  if (err) {
    throw new JmapError(
      `SieveScript/set rejected platform-mail-rules: ${err.description ?? err.type}`,
      err.type,
      err,
    );
  }
}

/**
 * Send-only permission profile: block IMAP/POP3 mailbox access and
 * ManageSieve self-management while keeping `authenticate` + `emailSend`
 * (SMTP submission via login passwords) and `emailReceive` (inbound must
 * still reach the Sieve stage so ereject/redirect run — a disabled
 * emailReceive silently drops mail instead; verified live).
 *
 * Names are Stalwart v0.16 registry camelCase (NOT the kebab-case of the
 * 0.15 directory docs).
 */
export async function applySendOnlyPermissions(params: {
  /** Admin principals account id (session primaryAccounts). */
  accountId: JmapAccountId;
  /** The USER's Stalwart principal id. */
  principalId: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { accountId, principalId, baseUrl, env } = params;
  await updatePrincipal({
    accountId,
    id: principalId,
    patch: {
      permissions: {
        '@type': 'Merge',
        enabledPermissions: {},
        disabledPermissions: {
          imapAuthenticate: true,
          pop3Authenticate: true,
          sieveAuthenticate: true,
        },
      },
    },
    baseUrl,
    env,
  });
}

interface SieveUserInterpreterGetResponse {
  readonly list?: readonly {
    id: string;
    maxRedirects?: number;
    maxOutMessages?: number;
  }[];
}

/**
 * Ensure the Stalwart untrusted-Sieve interpreter ceilings can carry the
 * platform's forwarding fan-out. Read-modify-write on the singleton; only
 * writes (and hot-reloads settings) when a ceiling is below target, so
 * an operator who raised them further is never clamped back down.
 */
export async function ensureSieveInterpreterLimits(params: {
  /** Admin principals account id (session primaryAccounts). */
  accountId: JmapAccountId;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { accountId, baseUrl, env } = params;
  const res = await rawStalwartCall<SieveUserInterpreterGetResponse>({
    using: [JMAP_STALWART],
    method: 'x:SieveUserInterpreter/get',
    args: { accountId, ids: ['singleton'] },
    baseUrl,
    env,
  });
  const current = res.list?.[0];
  const redirects = current?.maxRedirects ?? 0;
  const outMessages = current?.maxOutMessages ?? 0;
  if (redirects >= REQUIRED_MAX_REDIRECTS && outMessages >= REQUIRED_MAX_OUT_MESSAGES) {
    return;
  }
  await rawStalwartCall({
    using: [JMAP_STALWART],
    method: 'x:SieveUserInterpreter/set',
    args: {
      accountId,
      update: {
        singleton: {
          maxRedirects: Math.max(redirects, REQUIRED_MAX_REDIRECTS),
          maxOutMessages: Math.max(outMessages, REQUIRED_MAX_OUT_MESSAGES),
        },
      },
    },
    baseUrl,
    env,
  });
  // Interpreter limits are read from the live settings snapshot — a
  // ReloadSettings action applies them without a pod restart (verified).
  await rawStalwartCall({
    using: [JMAP_STALWART],
    method: 'x:Action/set',
    args: { accountId, create: { a1: { '@type': 'ReloadSettings' } } },
    baseUrl,
    env,
  });
  log.info(
    { maxRedirects: REQUIRED_MAX_REDIRECTS, maxOutMessages: REQUIRED_MAX_OUT_MESSAGES },
    'raised Stalwart Sieve interpreter ceilings for mailbox forwarding',
  );
}
