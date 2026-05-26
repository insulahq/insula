/**
 * Stalwart platform-infrastructure self-healing reconciler.
 *
 * Mirrors the established bootstrap.sh:configure_stalwart_full pattern
 * + the runtime applyMailServerHostnameToStalwart flow — i.e. the
 * code paths that already work in production. The reconciler reads
 * Stalwart's state, finds drift from those patterns, and patches.
 *
 * What it owns:
 *   1. SystemSettings.defaultHostname + defaultDomainId — operator-set
 *      mail hostname (banners + EHLO + cert-SAN selection) paired
 *      with the matching Stalwart Domain ID. Stalwart validates the
 *      singleton row requires BOTH; partial set is rejected.
 *   2. x:AcmeProvider letsencrypt — cluster-level Let's Encrypt
 *      account. Shape MUST match bootstrap (directory + contact +
 *      challengeType; NO `name` property). Hash ID is read back via
 *      /get rather than trusting /set response.
 *   3. Matching Domain.certificateManagement = Automatic with the
 *      AcmeProvider id + a subjectAlternativeNames map containing
 *      the hostname's prefix relative to Domain.name. The matching
 *      Domain is found via longest-suffix match (handles E2E test
 *      hostnames + canonical mail.<apex> alike) — the reconciler
 *      does NOT create Domain entries. They're created by
 *      bootstrap (SYSTEM tenant apex) and tenant provisioning.
 *   4. NetworkListeners http-acme/80, submission/587, imap/143 —
 *      bootstrap-created but absent on older installs.
 *   5. AcmeRenewal task fire — Stalwart-side idempotent (skips LE
 *      round-trip when cert is fresh). domainId is the matching
 *      Domain found in step 3.
 *
 * What it does NOT own:
 *   - Creating Stalwart Domain entries. If no Domain matches the
 *     mail hostname's suffix, the reconciler no-ops with a note
 *     pointing the operator to verify the SYSTEM tenant apex
 *     domain exists.
 *   - x:Certificate (PEM upload path) — that's manual-cert workflow,
 *     orthogonal to Stalwart's ACME client.
 *   - Per-tenant cert management on tenant Domains — tenant flow's job.
 *
 * Design — self-healing, not authoritative. Every step is gated
 * on an existence/equality check (idempotent). Never destroys
 * anything; if the world is already correct, the tick is read-only.
 *
 * Decoupled from NS delegation — ACME HTTP-01 needs only the A
 * record + port 80 + http-acme listener.
 *
 * Tick cadence: 30 min. Bring-up is the immediate startup tick;
 * operator hostname edits trigger inline via PATCH /admin/webmail-
 * settings; the scheduled tick only exists to catch external drift.
 */

import type { CoreV1Api } from '@kubernetes/client-node';

import { eq } from 'drizzle-orm';

import { readStalwartCredentials } from './credentials.js';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

/**
 * Read `mail_server_hostname` DIRECTLY from platform_settings — NOT
 * via webmail-settings.getMailServerHostname which has a fallback
 * chain (env STALWART_HOSTNAME → mail.<ingress_base_domain> →
 * mail.example.com). Reconciler intent is "only act when the
 * operator has explicitly chosen a mail hostname", because the
 * fallback paths can derive the wrong apex on clusters whose
 * platform-apex isn't intended to be a mail-serving domain
 * (e.g. an infrastructure-only apex with tenant-domain mail
 * served separately).
 */
async function getExplicitMailHostname(db: Database): Promise<string | null> {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, 'mail_server_hostname'));
  const v = row?.value?.trim();
  return v && v.length > 0 ? v : null;
}

/**
 * Default tick: 30 min.
 *
 * Three failure modes the reconciler protects against, each with very
 * different frequency:
 *   - Bootstrap dropped a step:      once per cluster lifetime → caught
 *                                    by the immediate startup tick.
 *   - Operator hostname edit:        rare, operator-initiated → caught
 *                                    by the inline trigger from the
 *                                    PATCH /admin/webmail-settings route.
 *   - External Stalwart mutation:    very rare (someone deletes a
 *                                    listener via the upstream
 *                                    web-admin) → THIS is what the
 *                                    scheduled tick exists for.
 *
 * 60s would burn JMAP roundtrips for no benefit. 30 min covers drift
 * recovery within an acceptable RTO without log spam. Override via
 * `STALWART_DOMAIN_RECONCILER_TICK_MS` env when integration-testing.
 */
export const STALWART_DOMAIN_RECONCILER_TICK_MS = 30 * 60_000;

/** JMAP capability URIs (mirrors stalwart-jmap/client.ts). */
const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_STALWART = 'urn:stalwart:jmap';

/** Stalwart admin account ID — fixed constant set by bootstrap. */
const ADMIN_ACCOUNT_ID = 'd333333';

/** Per-request JMAP timeout. */
const JMAP_TIMEOUT_MS = 10_000;

/** AcmeProvider key — stable identifier the reconciler creates/updates. */
const ACME_PROVIDER_KEY = 'letsencrypt';

/**
 * Listeners the platform requires Stalwart to bind, beyond the
 * Stalwart 0.16 defaults (smtp/25, submissions/465, imaps/993,
 * pop3s/995, sieve/4190, https/443, http/8080).
 *
 * Each entry mirrors the bootstrap.sh:5776-5793 jq snippets exactly,
 * so a fresh install vs a self-heal pass produce the same shape.
 */
interface RequiredListener {
  readonly name: string;
  readonly bindAddress: string;
  readonly protocol: 'smtp' | 'imap' | 'http';
  readonly tlsImplicit: boolean;
  /** http-acme is plain HTTP for ACME HTTP-01; everything else STARTTLS. */
  readonly useTls: boolean;
}

const REQUIRED_LISTENERS: ReadonlyArray<RequiredListener> = [
  { name: 'http-acme', bindAddress: '[::]:80', protocol: 'http', tlsImplicit: false, useTls: false },
  { name: 'submission', bindAddress: '[::]:587', protocol: 'smtp', tlsImplicit: false, useTls: true },
  { name: 'imap', bindAddress: '[::]:143', protocol: 'imap', tlsImplicit: false, useTls: true },
];

// ── Public API ────────────────────────────────────────────────────────

export interface StalwartDomainReconcilerDeps {
  readonly core: CoreV1Api;
  readonly db: Database;
  /** Override kubeconfig path for exec transport. */
  readonly kubeconfigPath?: string;
  readonly tickMs?: number;
  readonly logger?: {
    warn: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };
  /** Tests inject a stub; production uses exec-into-Stalwart-pod transport. */
  readonly jmapTransport?: JmapCall;
  /** Override for tests — defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Per-tick result summary — returned by runStalwartDomainReconcilerTick
 * so the operator-facing "Re-provision Stalwart" button can render
 * a precise "what changed" report rather than a green checkmark.
 *
 * Booleans are true when the reconciler ACTED on that step (i.e. the
 * underlying Stalwart object was created/patched). false means the
 * step was either already correct (no-op) OR skipped because a
 * precondition failed (see `notes` for the reason).
 */
export interface StalwartReconcileResult {
  /** Operator-set mail hostname the reconciler used (from platform_settings). */
  readonly mailHostname: string | null;
  /** The Stalwart Domain (name + id) the reconciler matched against. */
  readonly matchedDomain: { name: string; id: string } | null;
  /** SAN key added to the matched Domain (e.g. "mail" for mail.<apex>; "@" when hostname IS apex). */
  readonly sanKey: string | null;
  /** True when SystemSettings.defaultHostname/defaultDomainId was patched. */
  readonly defaultHostnameUpdated: boolean;
  readonly acmeProviderCreated: boolean;
  /** True when Domain.certificateManagement was patched (SAN added or set to Automatic). */
  readonly certManagementUpdated: boolean;
  /** Names of listeners newly created (subset of REQUIRED_LISTENERS). */
  readonly listenersCreated: ReadonlyArray<string>;
  /** True when AcmeRenewal task was fired (Stalwart will skip LE round-trip if cert fresh). */
  readonly acmeRenewalFired: boolean;
  /** Free-form per-step notes for the UI ("skipped — no admin creds", etc). */
  readonly notes: ReadonlyArray<string>;
  /** Convenience: true if no Stalwart state was changed this tick. */
  readonly noOp: boolean;
}

/** Start the reconciler. Returns a stop function for onClose. */
export function startStalwartDomainReconciler(
  deps: StalwartDomainReconcilerDeps,
): () => void {
  const tickMs = deps.tickMs ?? STALWART_DOMAIN_RECONCILER_TICK_MS;
  void runStalwartDomainReconcilerTick(deps); // one tick immediately
  const timer = setInterval(() => void runStalwartDomainReconcilerTick(deps), tickMs);
  return () => clearInterval(timer);
}

/**
 * One tick of the reconciler. Exported so the webmail-settings
 * PATCH handler can call it inline after persisting a new
 * mail_server_hostname (no wait-out for the next tick).
 *
 * Never throws — every failure path logs a warning and returns.
 * Subsequent ticks retry from a clean state.
 */
export async function runStalwartDomainReconcilerTick(
  deps: StalwartDomainReconcilerDeps,
): Promise<StalwartReconcileResult> {
  const log = deps.logger ?? {
    warn: (...args: unknown[]) => console.warn('[stalwart-domain-reconciler]', ...args),
    info: (...args: unknown[]) => console.info('[stalwart-domain-reconciler]', ...args),
  };

  const notes: string[] = [];
  const empty = (
    overrides: Partial<StalwartReconcileResult>,
    note?: string,
  ): StalwartReconcileResult => {
    if (note) notes.push(note);
    return {
      mailHostname: null,
      matchedDomain: null,
      sanKey: null,
      defaultHostnameUpdated: false,
      acmeProviderCreated: false,
      certManagementUpdated: false,
      listenersCreated: [],
      acmeRenewalFired: false,
      notes,
      noOp: true,
      ...overrides,
    };
  };

  // 1. Resolve mail hostname — EXPLICIT operator-set value only.
  //
  //    Earlier (2026-05-26 morning) this routed through
  //    webmail-settings.getMailServerHostname which has a fallback
  //    chain ending in `mail.<ingress_base_domain>`. That misfired on
  //    staging: `ingress_base_domain` is the platform's apex
  //    (intentionally NOT a mail-serving domain on this cluster), so
  //    the reconciler synthesized `mail.staging.phoenix-host.net` →
  //    stripped `mail.` → apex `staging.phoenix-host.net` and created
  //    a Stalwart x:Domain entry for that apex. Operator flagged it
  //    as wrong: `staging.phoenix-host.net` isn't a mail domain.
  //
  //    Fix: require the operator to explicitly choose a mail hostname
  //    via Admin UI → Email → Settings → Server (which writes
  //    platform_settings.mail_server_hostname directly). No implicit
  //    apex derivation — if the hostname isn't set, the reconciler
  //    no-ops with a note pointing the operator at the right form.
  //
  //    Apex for the Stalwart x:Domain entry is still derived by
  //    stripping the leading `mail.` label, but the input is now
  //    operator-chosen so the result is intentional.
  // 1. Operator-set mail hostname (no fallback chain).
  const mailHostname = await getExplicitMailHostname(deps.db);
  if (!mailHostname) {
    return empty({}, 'mail_server_hostname is not set — choose it via Admin UI → Email → Settings → Server (SMTP/IMAP hostname)');
  }
  const trimmedHost = mailHostname.toLowerCase();

  // 2. Build JMAP transport (loopback inside Stalwart pod — bypasses
  //    any PROXY-v2 sniff drift).
  const env = deps.env ?? process.env;
  let auth: string;
  try {
    const { username, password } = readStalwartCredentials(env);
    auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  } catch (err) {
    log.warn('Stalwart admin creds not available — skipping tick:', err);
    return empty({ mailHostname: trimmedHost }, `admin creds unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  let jmapCall: JmapCall;
  if (deps.jmapTransport) {
    jmapCall = deps.jmapTransport;
  } else {
    const podName = await findStalwartPodName(deps.core, log);
    if (!podName) {
      return empty({ mailHostname: trimmedHost }, 'no Running Stalwart pod found');
    }
    const transport: ExecTransport = {
      core: deps.core,
      podName,
      kubeconfigPath: deps.kubeconfigPath,
    };
    jmapCall = (a, b) => jmapPostViaExec(transport, a, b);
  }

  // 3. Find the Stalwart Domain that owns this hostname via
  //    longest-suffix match (matches applyMailServerHostnameToStalwart
  //    in webmail-settings/service.ts). The reconciler does NOT
  //    create Domain entries — bootstrap creates the SYSTEM tenant's
  //    apex Domain, and tenant provisioning creates per-tenant ones.
  //    If no Domain matches, the operator needs to ensure the SYSTEM
  //    tenant + apex Domain are in place.
  let matchedDomain: { name: string; id: string } | null;
  try {
    matchedDomain = await findMatchingDomain(jmapCall, auth, trimmedHost);
  } catch (err) {
    return empty({ mailHostname: trimmedHost }, `Domain lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!matchedDomain) {
    return empty(
      { mailHostname: trimmedHost },
      `No Stalwart Domain matches '${trimmedHost}' — verify the SYSTEM tenant's apex domain exists (bootstrap creates it)`,
    );
  }
  // Derive SAN key relative to the matched Domain.name (matches
  // addHostnameToDomainSANs logic).
  let sanKey: string;
  if (trimmedHost === matchedDomain.name) {
    sanKey = '@';
  } else if (trimmedHost.endsWith(`.${matchedDomain.name}`)) {
    sanKey = trimmedHost.slice(0, -1 - matchedDomain.name.length);
  } else {
    // Should be unreachable — findMatchingDomain only returns suffix matches.
    return empty(
      { mailHostname: trimmedHost, matchedDomain },
      `Cannot derive SAN key for '${trimmedHost}' under Domain '${matchedDomain.name}'`,
    );
  }

  // 4. Sync SystemSettings.defaultHostname + defaultDomainId (both
  //    required by Stalwart validation; partial set rejected).
  let defaultHostnameUpdated = false;
  try {
    defaultHostnameUpdated = await ensureDefaultHostname(
      jmapCall,
      auth,
      trimmedHost,
      matchedDomain.id,
      log,
    );
  } catch (err) {
    notes.push(`SystemSettings sync failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('Stalwart SystemSettings sync failed:', err);
  }

  // 5. Ensure x:AcmeProvider.
  let acmeProviderId: string | null = null;
  let acmeProviderCreated = false;
  try {
    const r = await ensureAcmeProvider(jmapCall, auth, matchedDomain.name, log);
    acmeProviderId = r.id;
    acmeProviderCreated = r.created;
  } catch (err) {
    notes.push(`x:AcmeProvider ensure failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('Stalwart x:AcmeProvider ensure failed:', err);
  }

  // 6. Ensure matched Domain's certificateManagement = Automatic +
  //    SAN includes our hostname prefix.
  let certManagementUpdated = false;
  if (acmeProviderId) {
    try {
      certManagementUpdated = await ensureDomainCertManagement(
        jmapCall, auth, matchedDomain.id, acmeProviderId, sanKey, log,
      );
    } catch (err) {
      notes.push(`Domain.certificateManagement ensure failed: ${err instanceof Error ? err.message : String(err)}`);
      log.warn('Stalwart Domain.certificateManagement ensure failed:', err);
    }
  }

  // 7. Ensure required NetworkListeners.
  let listenersCreated: ReadonlyArray<string> = [];
  try {
    listenersCreated = await ensureRequiredListeners(jmapCall, auth, log);
  } catch (err) {
    notes.push(`NetworkListener ensure failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('Stalwart NetworkListener ensure failed:', err);
  }

  // 8. Fire AcmeRenewal (Stalwart-side idempotent on cert freshness).
  let acmeRenewalFired = false;
  try {
    acmeRenewalFired = await fireAcmeRenewal(jmapCall, auth, matchedDomain.id, log);
  } catch (err) {
    notes.push(`AcmeRenewal fire failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('Stalwart AcmeRenewal fire failed:', err);
  }

  const noOp =
    !defaultHostnameUpdated
    && !acmeProviderCreated
    && !certManagementUpdated
    && listenersCreated.length === 0;

  return {
    mailHostname: trimmedHost,
    matchedDomain,
    sanKey,
    defaultHostnameUpdated,
    acmeProviderCreated,
    certManagementUpdated,
    listenersCreated,
    acmeRenewalFired,
    notes,
    noOp,
  };
}

// ── Internal: each ensure step ────────────────────────────────────────

/**
 * Find the Stalwart Domain that owns `hostname` via longest-suffix
 * match. Mirrors webmail-settings/service.ts:applyMailServerHostnameToStalwart
 * Step 1.
 *
 * Returns the matching {name, id} or null when none of the Domain
 * rows are a suffix of the hostname.
 */
async function findMatchingDomain(
  jmapCall: JmapCall,
  auth: string,
  hostname: string,
): Promise<{ name: string; id: string } | null> {
  const queryRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [['x:Domain/query', { accountId: ADMIN_ACCOUNT_ID }, 'q']],
  });
  const queryArgs = queryRes.methodResponses[0]?.[1] as { ids?: unknown };
  const ids = Array.isArray(queryArgs?.ids)
    ? (queryArgs.ids as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  if (ids.length === 0) return null;

  const getRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:Domain/get', { accountId: ADMIN_ACCOUNT_ID, ids, properties: ['id', 'name'] }, 'g'],
    ],
  });
  const getArgs = getRes.methodResponses[0]?.[1] as { list?: ReadonlyArray<{ id?: string; name?: string }> };
  const rows = (getArgs?.list ?? [])
    .filter((r): r is { id: string; name: string } => typeof r.id === 'string' && typeof r.name === 'string')
    .map((r) => ({ id: r.id, name: r.name.toLowerCase() }));

  // Exact match first; otherwise longest-suffix match.
  const exact = rows.find((r) => r.name === hostname);
  if (exact) return exact;
  const suffixMatches = rows
    .filter((r) => hostname.endsWith(`.${r.name}`))
    .sort((a, b) => b.name.length - a.name.length);
  return suffixMatches[0] ?? null;
}

/**
 * Patch SystemSettings.defaultHostname + defaultDomainId. Stalwart
 * validation rejects partial set (both fields required). Returns
 * true when an update was issued.
 */
async function ensureDefaultHostname(
  jmapCall: JmapCall,
  auth: string,
  desiredHostname: string,
  desiredDomainId: string,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<boolean> {
  const getRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:SystemSettings/get',
        { ids: ['singleton'], properties: ['defaultHostname', 'defaultDomainId'] },
        'c0',
      ],
    ],
  });
  const args = getRes.methodResponses[0]?.[1] as {
    list?: ReadonlyArray<{ defaultHostname?: unknown; defaultDomainId?: unknown }>;
  };
  const row = args?.list?.[0];
  const currentHost = typeof row?.defaultHostname === 'string' ? row.defaultHostname : '';
  const currentDomainId = typeof row?.defaultDomainId === 'string' ? row.defaultDomainId : '';
  if (currentHost.toLowerCase() === desiredHostname && currentDomainId === desiredDomainId) {
    return false;
  }
  await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:SystemSettings/set',
        {
          update: {
            singleton: {
              defaultHostname: desiredHostname,
              defaultDomainId: desiredDomainId,
            },
          },
        },
        'c0',
      ],
    ],
  });
  log.info(`Stalwart SystemSettings → defaultHostname=${desiredHostname}, defaultDomainId=${desiredDomainId}`);
  return true;
}

/**
 * Ensure the matched Domain's certificateManagement is Automatic with
 * the AcmeProvider id and a SAN map that includes our hostname's
 * prefix. MERGES into existing SANs (idempotent for re-runs +
 * non-destructive for previously-added entries from other hostnames).
 *
 * Mirrors webmail-settings/service.ts:addHostnameToDomainSANs.
 */
async function ensureDomainCertManagement(
  jmapCall: JmapCall,
  auth: string,
  domainId: string,
  acmeProviderId: string,
  sanKey: string,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<boolean> {
  const getRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:Domain/get',
        { accountId: ADMIN_ACCOUNT_ID, ids: [domainId], properties: ['certificateManagement'] },
        'c0',
      ],
    ],
  });
  const args = getRes.methodResponses[0]?.[1] as {
    list?: ReadonlyArray<{ certificateManagement?: Record<string, unknown> }>;
  };
  const cm = args?.list?.[0]?.certificateManagement ?? {};
  const cmType = typeof cm['@type'] === 'string' ? (cm['@type'] as string) : 'Manual';
  const existingProviderId = typeof cm.acmeProviderId === 'string' ? (cm.acmeProviderId as string) : '';
  const existingSans =
    cm.subjectAlternativeNames && typeof cm.subjectAlternativeNames === 'object'
      ? (cm.subjectAlternativeNames as Record<string, boolean>)
      : {};

  const alreadyCorrect =
    cmType === 'Automatic'
    && existingProviderId === acmeProviderId
    && existingSans[sanKey] === true;
  if (alreadyCorrect) return false;

  const merged: Record<string, boolean> = { ...existingSans, [sanKey]: true };
  await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:Domain/set',
        {
          accountId: ADMIN_ACCOUNT_ID,
          update: {
            [domainId]: {
              certificateManagement: {
                '@type': 'Automatic',
                acmeProviderId,
                subjectAlternativeNames: merged,
              },
            },
          },
        },
        'c0',
      ],
    ],
  });
  log.info(
    `Stalwart Domain.certificateManagement = Automatic (domainId=${domainId}, acme=${acmeProviderId}, sans=[${Object.keys(merged).join(',')}])`,
  );
  return true;
}

/**
 * Fire x:Task/set AcmeRenewal — Stalwart's internal ACME client
 * picks up the task and acquires/renews the cert. Stalwart-side
 * idempotent (skips LE round-trip if cert is fresh).
 */
async function fireAcmeRenewal(
  jmapCall: JmapCall,
  auth: string,
  domainId: string,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<boolean> {
  const setRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:Task/set',
        {
          accountId: ADMIN_ACCOUNT_ID,
          create: { r: { '@type': 'AcmeRenewal', domainId } },
        },
        'c0',
      ],
    ],
  });
  const setArgs = setRes.methodResponses[0]?.[1] as {
    notCreated?: Record<string, { description?: string }>;
  };
  const notCreated = setArgs?.notCreated ?? {};
  if (Object.keys(notCreated).length > 0) {
    log.warn('x:Task/set AcmeRenewal noop:', JSON.stringify(notCreated));
    return false;
  }
  log.info(`Stalwart AcmeRenewal fired (domainId=${domainId})`);
  return true;
}

/**
 * Resolve the AcmeProvider hash ID for `letsencrypt`, creating it if
 * absent.
 *
 * **Schema gotchas verified against staging 2026-05-26** (mirrors
 * scripts/bootstrap.sh:5682-5701 which is the canonical working
 * pattern):
 *
 *   - Property name on x:AcmeProvider/set create is `directory`
 *     (NOT `directoryUrl` — Stalwart 0.16 rejects that).
 *   - No `name` field. The map key (`letsencrypt`) is the creation
 *     handle; `name` is also rejected as "Invalid property".
 *   - `contact` is required by Let's Encrypt (RFC 8555 §7.3.1
 *     terms-of-service acceptance); omit and the eventual ACME
 *     order errors with a 400 from the LE staging directory.
 *
 * **ID resolution gotcha** (also verified on staging Phase K):
 *   The hash ID assigned by Stalwart is NOT the creation key. It's
 *   the autogenerated `id` field on the created object. Read it
 *   back via x:AcmeProvider/get rather than trusting the /set
 *   response shape — some Stalwart releases return `created:{key:{}}`
 *   without the id, which would silently leave the downstream
 *   Domain.certificateManagement=Manual.
 */
async function ensureAcmeProvider(
  jmapCall: JmapCall,
  auth: string,
  apex: string,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<{ id: string | null; created: boolean }> {
  // Helper: read back the first AcmeProvider's id, or null.
  const readId = async (): Promise<string | null> => {
    const getRes = await jmapCall(auth, {
      using: [JMAP_CORE, JMAP_STALWART],
      methodCalls: [
        ['x:AcmeProvider/get', { accountId: ADMIN_ACCOUNT_ID, ids: null, properties: ['id'] }, 'c0'],
      ],
    });
    const args = getRes.methodResponses[0]?.[1] as { list?: ReadonlyArray<{ id?: string }> };
    return args?.list?.[0]?.id ?? null;
  };

  const existing = await readId();
  if (existing) return { id: existing, created: false };

  const setRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:AcmeProvider/set',
        {
          accountId: ADMIN_ACCOUNT_ID,
          create: {
            [ACME_PROVIDER_KEY]: {
              directory: 'https://acme-v02.api.letsencrypt.org/directory',
              challengeType: 'Http01',
              contact: { [`hostmaster@${apex}`]: true },
            },
          },
        },
        'c0',
      ],
    ],
  });
  const setArgs = setRes.methodResponses[0]?.[1] as {
    notCreated?: Record<string, { description?: string; properties?: string[] }>;
  };
  const notCreated = setArgs?.notCreated ?? {};
  if (Object.keys(notCreated).length > 0) {
    log.warn('x:AcmeProvider/set create rejected:', JSON.stringify(notCreated));
    return { id: null, created: false };
  }
  // Defensive read-back instead of trusting the /set response shape.
  const id = await readId();
  if (id) log.info(`Stalwart x:AcmeProvider created (id=${id})`);
  return { id, created: id !== null };
}

async function ensureRequiredListeners(
  jmapCall: JmapCall,
  auth: string,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<ReadonlyArray<string>> {
  const getRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:NetworkListener/get', { accountId: ADMIN_ACCOUNT_ID, ids: null, properties: ['name'] }, 'c0'],
    ],
  });
  const args = getRes.methodResponses[0]?.[1] as { list?: ReadonlyArray<{ name?: string }> };
  const existing = new Set((args?.list ?? []).map((l) => l.name).filter((n): n is string => !!n));

  const create: Record<string, Record<string, unknown>> = {};
  for (const want of REQUIRED_LISTENERS) {
    if (existing.has(want.name)) continue;
    create[want.name] = {
      name: want.name,
      bind: { [want.bindAddress]: true },
      protocol: want.protocol,
      tlsImplicit: want.tlsImplicit,
      // useTls=false only meaningful for http-acme; Stalwart defaults
      // to true for mail protocols so omit it for those.
      ...(want.protocol === 'http' ? { useTls: want.useTls } : {}),
    };
  }
  if (Object.keys(create).length === 0) return [];

  const setRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:NetworkListener/set', { accountId: ADMIN_ACCOUNT_ID, create }, 'c0'],
    ],
  });
  const setArgs = setRes.methodResponses[0]?.[1] as {
    created?: Record<string, unknown>;
    notCreated?: Record<string, { description?: string }>;
  };
  const notCreated = setArgs?.notCreated ?? {};
  if (Object.keys(notCreated).length > 0) {
    log.warn('x:NetworkListener/set create rejected:', JSON.stringify(notCreated));
  }
  const created = Object.keys(setArgs?.created ?? {});
  if (created.length > 0) {
    log.info(`Stalwart NetworkListener created: ${created.join(', ')}`);
  }
  return created;
}

// ── JMAP transport (exec into Stalwart pod) ──────────────────────────

interface ExecTransport {
  readonly core: CoreV1Api;
  readonly podName: string;
  readonly kubeconfigPath?: string;
}

interface JmapInvocationResponse {
  readonly methodResponses: ReadonlyArray<[string, Record<string, unknown>, string]>;
}

type JmapCall = (auth: string, body: unknown) => Promise<JmapInvocationResponse>;

async function findStalwartPodName(
  core: CoreV1Api,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<string | null> {
  try {
    const pods = await core.listNamespacedPod({
      namespace: 'mail',
      labelSelector: 'app=stalwart-mail',
      limit: 5,
    });
    const ready = (pods.items ?? []).find((p) =>
      p.status?.containerStatuses?.some((cs) => cs.name === 'stalwart' && cs.ready === true),
    );
    if (!ready?.metadata?.name) {
      log.warn('No Running Stalwart pod found — skipping tick (will retry).');
      return null;
    }
    return ready.metadata.name;
  } catch (err) {
    log.warn('Failed to list Stalwart pods:', err);
    return null;
  }
}

async function jmapPostViaExec(
  transport: ExecTransport,
  auth: string,
  body: unknown,
): Promise<JmapInvocationResponse> {
  // Lazy require to keep the kubeconfig + Exec deps out of the
  // common-case import graph (matches proxy-networks-reconciler).
  const { KubeConfig, Exec } = await import('@kubernetes/client-node');
  const kc = new KubeConfig();
  if (transport.kubeconfigPath) {
    kc.loadFromFile(transport.kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }
  const exec = new Exec(kc);
  const payload = JSON.stringify(body);
  const cmd = [
    'sh', '-c',
    [
      'curl', '-sS', '-m', String(Math.ceil(JMAP_TIMEOUT_MS / 1000)),
      '-H', `'Authorization: ${auth}'`,
      '-H', "'Content-Type: application/json'",
      '-d', `'${payload.replace(/'/g, `'\\''`)}'`,
      "'http://127.0.0.1:8080/jmap/'",
    ].join(' '),
  ];

  let stdout = '';
  let stderr = '';
  const { Writable } = await import('node:stream');
  const stdoutSink = new Writable({
    write(chunk, _enc, cb) { stdout += chunk.toString('utf8'); cb(); },
  });
  const stderrSink = new Writable({
    write(chunk, _enc, cb) { stderr += chunk.toString('utf8'); cb(); },
  });

  await new Promise<void>((resolve, reject) => {
    exec.exec(
      'mail',
      transport.podName,
      'stalwart',
      cmd,
      stdoutSink,
      stderrSink,
      null,
      false,
      (status) => {
        if (status.status === 'Failure') {
          reject(new Error(
            `Stalwart JMAP exec failed: ${status.message ?? 'unknown'} (stderr=${stderr.slice(0, 200)})`,
          ));
        } else {
          resolve();
        }
      },
    ).catch(reject);
  });

  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`Stalwart JMAP non-JSON response: ${stdout.slice(0, 200)}`);
  }
  if (
    !data
    || typeof data !== 'object'
    || !Array.isArray((data as { methodResponses?: unknown }).methodResponses)
  ) {
    throw new Error('Stalwart JMAP response missing methodResponses array');
  }
  return data as JmapInvocationResponse;
}
