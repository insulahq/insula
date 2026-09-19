import { readFileSync as fsReadFileSync } from 'node:fs';

/**
 * Typed JMAP client for Stalwart 0.16+.
 *
 * Stalwart 0.16 dropped its legacy REST API — all programmatic
 * provisioning goes through JMAP (RFC 8620). This module wraps the
 * subset of JMAP operations that the platform-api needs:
 *
 *   Principal/get        — read admin-account or mailbox state
 *   Principal/set        — create/update/delete mailboxes and domains
 *   Principal/changes    — track state-changes for polling sync
 *   Domain/dnsZoneFile   — fetch the DNS records Stalwart wants published
 *                          (used by dns-sync.ts)
 *
 * Authentication: HTTP Basic (admin:password) via the same credentials
 * resolution chain as the rest of the mail-admin module
 * (STALWART_ADMIN_CREDS_DIR > STALWART_ADMIN_PASSWORD > ADMIN_SECRET_PLAIN).
 *
 * Transport: native `fetch` (Node 22, no keep-alive pooling needed for
 * the infrequent provisioning calls this module makes).
 *
 * Base URL: STALWART_MGMT_URL (default:
 *   http://stalwart-mgmt.mail.svc.cluster.local:8080)
 */

// ── JMAP protocol types (RFC 8620) ─────────────────────────────────────────

/** RFC 8620 §3.6 — account ID string */
export type JmapAccountId = string;

/** RFC 8620 §3 — per-method invocation: [name, args, clientId] */
export type JmapInvocation = [string, Record<string, unknown>, string];

export interface JmapRequest {
  readonly using: readonly string[];
  readonly methodCalls: readonly JmapInvocation[];
}

export interface JmapResponse {
  readonly methodResponses: readonly JmapInvocation[];
  readonly sessionState: string;
}

/** RFC 8620 §5.1 — /get response arguments */
export interface JmapGetResponse<T> {
  readonly accountId: JmapAccountId;
  readonly state: string;
  readonly list: readonly T[];
  readonly notFound: readonly string[];
}

/** RFC 8620 §5.2 — /set request arguments */
export interface JmapSetRequest<T> {
  readonly accountId?: JmapAccountId;
  readonly ifInState?: string | null;
  readonly create?: Record<string, T> | null;
  readonly update?: Record<string, Record<string, unknown>> | null;
  readonly destroy?: readonly string[] | null;
}

/** RFC 8620 §5.2 — /set response arguments */
export interface JmapSetResponse<T> {
  readonly accountId: JmapAccountId;
  readonly oldState: string | null;
  readonly newState: string;
  readonly created: Record<string, T> | null;
  readonly updated: Record<string, T | null> | null;
  readonly destroyed: readonly string[] | null;
  readonly notCreated: Record<string, JmapSetError> | null;
  readonly notUpdated: Record<string, JmapSetError> | null;
  readonly notDestroyed: Record<string, JmapSetError> | null;
}

/** RFC 8620 §5.3 — /changes response arguments */
export interface JmapChangesResponse {
  readonly accountId: JmapAccountId;
  readonly oldState: string;
  readonly newState: string;
  readonly hasMoreChanges: boolean;
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly destroyed: readonly string[];
}

export interface JmapSetError {
  readonly type: string;
  readonly description?: string | null;
  readonly properties?: readonly string[] | null;
}

// ── Stalwart Principal types ────────────────────────────────────────────────

/** Principal types recognized by Stalwart 0.16 */
export type PrincipalType = 'individual' | 'domain' | 'group' | 'list' | 'resource';

export interface PrincipalQuota {
  /** Quota in bytes. 0 = unlimited. */
  readonly messages?: number | null;
  readonly storage?: number | null;
}

/**
 * Stalwart Principal object (subset of fields the platform needs).
 *
 * The full schema has many more fields (members, roles, data, etc).
 * We include only what provisioning and DNS sync require; unknown
 * fields from the server are accepted and passed through.
 */
export interface StalwartPrincipal {
  readonly id?: string;
  readonly type: PrincipalType;
  readonly name: string;
  readonly description?: string | null;
  readonly emails?: readonly string[];
  /** Tenant / org string — unused in single-tenant installs */
  readonly tenant?: string | null;
  readonly quota?: PrincipalQuota | null;
  /** Password hash or plain password when creating (write-only) */
  readonly secrets?: readonly string[];
  /**
   * For type=domain: the full zone-file text Stalwart wants published.
   * Server-set — not sent on create/update.
   */
  readonly dnsZoneFile?: string | null;
}

/** Minimal shape for creating an individual mailbox */
export interface CreateMailboxInput {
  readonly type: 'individual';
  readonly name: string;
  readonly description?: string;
  readonly emails: readonly string[];
  readonly secrets?: readonly string[];
  readonly quota?: PrincipalQuota;
}

/** Minimal shape for registering a domain */
export interface CreateDomainInput {
  readonly type: 'domain';
  readonly name: string;
  readonly description?: string;
}

// ── JMAP session ────────────────────────────────────────────────────────────

export interface JmapSession {
  /** All capabilities advertised by the server */
  readonly capabilities: Record<string, unknown>;
  /**
   * Map of accountId → account info.
   * Stalwart exposes separate namespaces:
   *   - mail account (RFC 8620 core)
   *   - principal management account (urn:ietf:params:jmap:principals)
   */
  readonly accounts: Record<string, { readonly name: string; readonly accountCapabilities: Record<string, unknown> }>;
  readonly primaryAccounts: Record<string, JmapAccountId>;
  readonly apiUrl: string;
  readonly state: string;
}

// ── Client implementation ───────────────────────────────────────────────────

const STALWART_MGMT_URL =
  process.env.STALWART_MGMT_URL ?? 'http://stalwart-mgmt.mail.svc.cluster.local:8080';

const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_PRINCIPALS = 'urn:ietf:params:jmap:principals';
// Cut 3 follow-up: Stalwart 0.16 implements its OWN
// extension namespace for principal management — `x:Account/*` for
// individual mailboxes / admin users and `x:Domain/*` for mail domains.
// Standard JMAP `Principal/*` (RFC 8620) is NOT implemented; calls
// against it return `urn:ietf:params:jmap:error:notRequest`. Use
// JMAP_STALWART for every Account/Domain operation.
const JMAP_STALWART = 'urn:stalwart:jmap';

/**
 * Resolve admin Basic-Auth credentials using the same priority order
 * as the rest of the mail-admin module.
 *
 * We read env at call-time (not module-load-time) so that unit tests
 * can set process.env overrides after import.
 */
function adminBasicAuth(env: NodeJS.ProcessEnv = process.env): string {
  // Resolution chain (first match wins):
  //   1. Secret volume mount at STALWART_ADMIN_CREDS_DIR (default
  //      /etc/stalwart-creds). Canonical path: kubelet refreshes the
  //      mounted file within ~60s of a rotation, so platform-api
  //      picks up the new password without a pod restart.
  //   2. STALWART_ADMIN_PASSWORD / STALWART_ADMIN_SECRET_PLAIN /
  //      ADMIN_SECRET_PLAIN env vars (legacy, dev-mode only).
  // Cut 3 follow-up: the file-based path was missing here
  // even though the doc-comment promised it. Symptom: the staging
  // /admin/mail/rotate-admin-password 500'd with "STALWART_ADMIN_PASSWORD
  // not configured" because only the env-var fallback was implemented.
  const password =
    readPasswordFromCredsDir(env) ??
    env.STALWART_ADMIN_PASSWORD ??
    env.STALWART_ADMIN_SECRET_PLAIN ??
    env.ADMIN_SECRET_PLAIN ??
    '';
  const trimmed = password.trim();
  if (!trimmed) {
    throw new Error(
      'Stalwart admin password is not configured '
      + '(STALWART_ADMIN_CREDS_DIR/ADMIN_SECRET_PLAIN file or '
      + 'STALWART_ADMIN_PASSWORD / STALWART_ADMIN_SECRET_PLAIN / ADMIN_SECRET_PLAIN env)',
    );
  }
  const username = (env.STALWART_ADMIN_USER?.trim()) || 'admin';
  return `Basic ${Buffer.from(`${username}:${trimmed}`).toString('base64')}`;
}

function readPasswordFromCredsDir(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.STALWART_ADMIN_CREDS_DIR?.trim();
  if (!dir) return undefined;
  try {
    // Sync read — ~64-byte file, well under 1ms per call. An async
    // path would require threading awaits through every JMAP call site
    // for no measurable benefit.
    const content = fsReadFileSync(`${dir}/ADMIN_SECRET_PLAIN`, 'utf8');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export class JmapError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'JmapError';
  }
}

/**
 * Extract the first method-response of the expected type from a
 * JmapResponse, throwing JmapError on protocol-level errors.
 */
function extractResponse<T>(
  response: JmapResponse,
  expectedMethod: string,
  callId: string,
): T {
  for (const [method, args, id] of response.methodResponses) {
    if (id !== callId) continue;
    if (method === 'error') {
      const err = args as { type: string; description?: string };
      throw new JmapError(
        `JMAP error: ${err.description ?? err.type}`,
        err.type,
        args,
      );
    }
    if (method === expectedMethod) {
      return args as T;
    }
  }
  throw new JmapError(
    `Expected JMAP response '${expectedMethod}' (call=${callId}) not found in response`,
    'missingResponse',
    response.methodResponses,
  );
}

/**
 * Default per-request timeout. A hung Stalwart pod or network partition
 * would otherwise block the caller indefinitely; the scheduler's
 * `running = true` guard means a single stuck cycle blocks all future
 * cycles. Override via JMAP_TIMEOUT_MS env var when needed (e.g. for
 * long-running snapshot/apply operations).
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Raw JMAP request/response cycle */
async function jmapPost(
  baseUrl: string,
  auth: string,
  body: JmapRequest,
): Promise<JmapResponse> {
  const url = `${baseUrl}/jmap/`;
  const timeoutMs = Number(process.env.JMAP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new JmapError(
      `JMAP request to ${url} failed: HTTP ${res.status} ${res.statusText}`,
      'httpError',
      { status: res.status, body: text.slice(0, 500) },
    );
  }

  // Code-review L1 fix: guard the network boundary.
  // A 200 response from a reverse-proxy error page (Cloudflare, nginx
  // landing page, etc.) would JSON.parse fine but lack the expected
  // shape — extractResponse would then throw a confusing TypeError on
  // .methodResponses. Validate the minimal shape before returning.
  const data = (await res.json()) as unknown;
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { methodResponses?: unknown }).methodResponses)
  ) {
    throw new JmapError(
      `JMAP response from ${url} did not match the protocol shape (missing methodResponses array)`,
      'malformedResponse',
      data,
    );
  }
  return data as JmapResponse;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch the JMAP session object.
 *
 * Returns the account IDs and capability URIs. The principal-management
 * account ID is under `primaryAccounts[JMAP_PRINCIPALS]`.
 */
export async function getJmapSession(
  baseUrl: string = STALWART_MGMT_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JmapSession> {
  const timeoutMs = Number(env.JMAP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const res = await fetch(`${baseUrl}/jmap/session`, {
    headers: {
      Authorization: adminBasicAuth(env),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new JmapError(
      `JMAP session fetch failed: HTTP ${res.status}`,
      'httpError',
      { status: res.status, body: text.slice(0, 500) },
    );
  }
  // Same protocol-shape guard as jmapPost — see L1 comment there.
  const data = (await res.json()) as unknown;
  if (
    !data ||
    typeof data !== 'object' ||
    typeof (data as { primaryAccounts?: unknown }).primaryAccounts !== 'object'
  ) {
    throw new JmapError(
      `JMAP session from ${baseUrl} did not match the protocol shape (missing primaryAccounts object)`,
      'malformedResponse',
      data,
    );
  }
  return data as JmapSession;
}

/**
 * Verify the webmail master principal can obtain a JMAP session with the
 * given credentials.
 *
 * The principals-sync drift detector uses this to catch a master that
 * EXISTS in Stalwart but whose password has drifted out of sync with
 * `mail-secrets` (e.g. after a Stalwart data restore / redeploy that reset
 * the account). Impersonation is then silently broken for ALL webmail
 * users, yet the existence check alone reports the master as healthy.
 *
 * Returns `{ ok: true }` on a 200 session and `{ ok: false, status }` on a
 * definitive auth rejection (401/403). THROWS on network / non-auth errors
 * (5xx, timeout, malformed) so the caller can treat those as transient and
 * NOT raise a false drift item.
 */
export async function verifyMasterJmapAuth(
  masterUser: string,
  masterPassword: string,
  baseUrl: string = STALWART_MGMT_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; status: number }> {
  const timeoutMs = Number(env.JMAP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const auth = `Basic ${Buffer.from(`${masterUser}:${masterPassword}`).toString('base64')}`;
  const res = await fetch(`${baseUrl}/jmap/session`, {
    headers: { Authorization: auth, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 200) return { ok: true, status: 200 };
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status };
  throw new JmapError(
    `master-auth probe got unexpected HTTP ${res.status} (not a clean auth verdict)`,
    'httpError',
    { status: res.status },
  );
}

// ── Stalwart x:Account / x:Domain primitives ────────────────────────────────
//
// Cut 3 follow-up: Stalwart 0.16 implements its own JMAP
// extension namespace for principal management — `x:Account/*` for
// individual users (mailboxes, admins) and `x:Domain/*` for mail
// domains. RFC 8620 standard `Principal/*` is NOT implemented; calls
// against it return 400 with `notRequest`. The functions below are
// the on-the-wire-correct primitives; the legacy `principalGet/Set`
// helpers further down route through these.

/** Raw response shape from x:Account/get. */
interface XAccountGetResponse {
  readonly accountId: JmapAccountId;
  readonly state: string;
  readonly list: readonly Record<string, unknown>[];
  readonly notFound: readonly string[];
}

/** Raw response shape from x:Account/query. */
interface XQueryResponse {
  readonly accountId: JmapAccountId;
  readonly state: string;
  readonly ids: readonly string[];
  readonly position?: number;
  readonly total?: number;
}

async function _xCall<T>(
  capability: string,
  method: string,
  args: Record<string, unknown>,
  baseUrl: string = STALWART_MGMT_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const auth = adminBasicAuth(env);
  const callId = 'c0';
  const req: JmapRequest = {
    using: [JMAP_CORE, capability],
    methodCalls: [[method, args, callId]],
  };
  const res = await jmapPost(baseUrl, auth, req);
  return extractResponse<T>(res, method, callId);
}

/**
 * `x:Account/get` — fetch one or more accounts (users, admins) by ID.
 * Pass `ids: null` to list all accounts.
 */
export async function accountGet(params: {
  accountId: JmapAccountId;
  ids: readonly string[] | null;
  properties?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<XAccountGetResponse> {
  const { accountId, ids, properties, baseUrl, env } = params;
  const projected = _withRequired(properties, REQUIRED_ACCOUNT_PROPERTIES);
  return _xCall<XAccountGetResponse>(
    JMAP_STALWART,
    'x:Account/get',
    { accountId, ids: ids ?? null, ...(projected ? { properties: projected } : {}) },
    baseUrl, env,
  );
}

// ── DkimSignature registry objects (x:DkimSignature/*) ────────────────────
//
// Stalwart 0.16 manages DKIM keys as registry objects reachable over the
// same JMAP surface as principals (capability urn:stalwart:jmap). The
// platform uses these to (a) create RSA rotation keys (email-dkim/rotate)
// and (b) destroy the Ed25519 signature Stalwart auto-creates on every
// new domain principal — Gmail/M365 don't support RFC 8463, so we keep
// tenant domains RSA-only (see ADR-046-adjacent DKIM notes + PR #207).
// NOTE: there is NO REST /api/object or /api/store/import endpoint for
// these in v0.16.5 — JMAP set/get is the only wire that works.

/** Minimal row shape for a Stalwart DkimSignature registry object. */
export interface StalwartDkimSignatureRow {
  readonly id: string;
  readonly '@type': string;
  readonly domainId: string;
  readonly selector: string;
  readonly stage?: string;
}

interface XDkimGetResponse {
  readonly accountId: JmapAccountId;
  readonly list?: readonly StalwartDkimSignatureRow[];
}

/** `x:DkimSignature/get` — pass `ids: null` to list all signatures. */
export async function dkimSignatureGet(params: {
  accountId: JmapAccountId;
  ids?: readonly string[] | null;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<readonly StalwartDkimSignatureRow[]> {
  const { accountId, ids, baseUrl, env } = params;
  const res = await _xCall<XDkimGetResponse>(
    JMAP_STALWART,
    'x:DkimSignature/get',
    { accountId, ids: ids ?? null },
    baseUrl, env,
  );
  return res.list ?? [];
}

/** `x:DkimSignature/set` — create and/or destroy signature objects. */
export async function dkimSignatureSet(params: {
  accountId: JmapAccountId;
  create?: Record<string, Record<string, unknown>>;
  destroy?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<StalwartDkimSignatureRow>> {
  const { accountId, create, destroy, baseUrl, env } = params;
  return _xCall<JmapSetResponse<StalwartDkimSignatureRow>>(
    JMAP_STALWART,
    'x:DkimSignature/set',
    {
      accountId,
      ...(create ? { create } : {}),
      ...(destroy ? { destroy } : {}),
    },
    baseUrl, env,
  );
}

// ── MTA outbound throttles + queue quotas (R6 PR 1) ───────────────────────
//
// Stalwart 0.16 models queue rate limiting as registry objects, NOT the
// legacy [queue.throttle] TOML (which v0.16 no longer reads — the old
// stalwart-outbound-config ConfigMap was dead config). The platform's
// send-limit reconciler (email-outbound/stalwart-throttles.ts) manages:
//   - x:MtaOutboundThrottle  — paces delivery (rate = count/period)
//   - x:MtaQueueQuota        — caps queued backlog; messages=0 rejects
//                              every submission (the suspension lever)
// Registry objects are account-agnostic: no accountId argument needed
// (verified live on v0.16.5, spike).

/**
 * Boolean match expression: `{match: {}, else: "<condition>"}`.
 * `match` is the if/then chain serialized as Stalwart's registry
 * List<T> — a JSON OBJECT with integer-string keys ("0", "1", …),
 * NOT an array (an array is rejected with invalidPatch match/match).
 */
export interface StalwartExpression {
  readonly match: Readonly<Record<string, { if: string; then: string }>>;
  readonly else: string;
}

export interface StalwartMtaThrottleRow {
  readonly id: string;
  readonly enable: boolean;
  readonly description: string;
  /** Bucket key map, e.g. `{senderDomain: true}`. */
  readonly key: Record<string, boolean>;
  readonly match: StalwartExpression;
  /** `period` is milliseconds. */
  readonly rate: { count: number; period: number };
}

export interface StalwartMtaQueueQuotaRow {
  readonly id: string;
  readonly enable: boolean;
  readonly description: string | null;
  readonly key: Record<string, boolean>;
  readonly match: StalwartExpression;
  readonly messages: number | null;
  readonly size: number | null;
}

interface XListResponse<T> {
  readonly list?: readonly T[];
}

export interface StalwartTracerRow {
  readonly id: string;
  readonly enable: boolean;
  /** Discriminator: "Stdout", "Log", "Journal", "OpenTelemetry", ... */
  readonly '@type': string;
  readonly level: string;
  readonly path?: string | null;
}

export async function tracerGet(params: {
  ids?: readonly string[] | null;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<readonly StalwartTracerRow[]> {
  const { ids, baseUrl, env } = params;
  const res = await _xCall<XListResponse<StalwartTracerRow>>(
    JMAP_STALWART,
    'x:Tracer/get',
    { ids: ids ?? null },
    baseUrl, env,
  );
  return res.list ?? [];
}

export async function tracerSet(params: {
  create?: Record<string, Record<string, unknown>>;
  update?: Record<string, Record<string, unknown>>;
  destroy?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<StalwartTracerRow>> {
  const { create, update, destroy, baseUrl, env } = params;
  return _xCall<JmapSetResponse<StalwartTracerRow>>(
    JMAP_STALWART,
    'x:Tracer/set',
    {
      ...(create ? { create } : {}),
      ...(update ? { update } : {}),
      ...(destroy ? { destroy } : {}),
    },
    baseUrl, env,
  );
}

export async function mtaOutboundThrottleGet(params: {
  ids?: readonly string[] | null;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<readonly StalwartMtaThrottleRow[]> {
  const { ids, baseUrl, env } = params;
  const res = await _xCall<XListResponse<StalwartMtaThrottleRow>>(
    JMAP_STALWART,
    'x:MtaOutboundThrottle/get',
    { ids: ids ?? null },
    baseUrl, env,
  );
  return res.list ?? [];
}

export async function mtaOutboundThrottleSet(params: {
  create?: Record<string, Record<string, unknown>>;
  update?: Record<string, Record<string, unknown>>;
  destroy?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<StalwartMtaThrottleRow>> {
  const { create, update, destroy, baseUrl, env } = params;
  return _xCall<JmapSetResponse<StalwartMtaThrottleRow>>(
    JMAP_STALWART,
    'x:MtaOutboundThrottle/set',
    {
      ...(create ? { create } : {}),
      ...(update ? { update } : {}),
      ...(destroy ? { destroy } : {}),
    },
    baseUrl, env,
  );
}

export async function mtaQueueQuotaGet(params: {
  ids?: readonly string[] | null;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<readonly StalwartMtaQueueQuotaRow[]> {
  const { ids, baseUrl, env } = params;
  const res = await _xCall<XListResponse<StalwartMtaQueueQuotaRow>>(
    JMAP_STALWART,
    'x:MtaQueueQuota/get',
    { ids: ids ?? null },
    baseUrl, env,
  );
  return res.list ?? [];
}

export async function mtaQueueQuotaSet(params: {
  create?: Record<string, Record<string, unknown>>;
  update?: Record<string, Record<string, unknown>>;
  destroy?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<StalwartMtaQueueQuotaRow>> {
  const { create, update, destroy, baseUrl, env } = params;
  return _xCall<JmapSetResponse<StalwartMtaQueueQuotaRow>>(
    JMAP_STALWART,
    'x:MtaQueueQuota/set',
    {
      ...(create ? { create } : {}),
      ...(update ? { update } : {}),
      ...(destroy ? { destroy } : {}),
    },
    baseUrl, env,
  );
}

// ── Incoming report analysis ──────────────────────────────────────────────
//
// Stalwart parses DMARC aggregate / TLS reports sent to the ReportSettings
// inboundReportAddresses and stores them as typed registry objects (default
// retention 30d). The platform polls them and destroys what it consumes.
//
// The ARF half (x:ArfExternalReport) is below. It was removed with the FBL
// retirement and restored for abuse-report ingestion: FBL was about a
// complaint RATE and needed per-provider enrolment to yield anything, while an
// abuse report is an incident that arrives unsolicited.

// ── ARF abuse reports (x:ArfExternalReport/*) ───────────────────────────────
//
// RFC 5965. Stalwart parses the `message/feedback-report` part and stores a
// typed object, so the platform never handles the MIME.
//
// `to`, `reportedDomains` and `authenticationResults` are OBJECTS KEYED BY
// VALUE (`{"example.test": true}`), not arrays — the same shape trap as the
// DMARC records below. Read them with Object.keys(), never .map().

export interface StalwartArfReportRow {
  readonly id: string;
  readonly from?: string;
  readonly subject?: string;
  readonly to?: Record<string, boolean>;
  readonly receivedAt?: string;
  readonly expiresAt?: string;
  readonly report?: {
    readonly feedbackType?: string;
    readonly arrivalDate?: string | null;
    readonly incidents?: number;
    readonly originalMailFrom?: string | null;
    readonly originalRcptTo?: string | null;
    readonly reportedDomains?: Record<string, boolean>;
    readonly reportingMta?: string | null;
    readonly sourceIp?: string | null;
    readonly userAgent?: string | null;
    readonly authenticationResults?: Record<string, boolean>;
  };
}

interface XArfGetResponse {
  readonly list?: readonly StalwartArfReportRow[];
}

/**
 * List + fetch stored ARF reports (query/get with a back-reference).
 *
 * Capped at 200 per poll so a backlog drains across ticks instead of producing
 * one unbounded fetch + insert loop.
 */
export async function arfExternalReportList(params: {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<readonly StalwartArfReportRow[]> {
  const { baseUrl, env } = params;
  const auth = adminBasicAuth(env);
  const req: JmapRequest = {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:ArfExternalReport/query', { limit: 200 }, 'q'],
      ['x:ArfExternalReport/get', {
        '#ids': { resultOf: 'q', name: 'x:ArfExternalReport/query', path: '/ids' },
      }, 'g'],
    ],
  };
  const res = await jmapPost(baseUrl ?? STALWART_MGMT_URL, auth, req);
  const get = extractResponse<XArfGetResponse>(res, 'x:ArfExternalReport/get', 'g');
  return get.list ?? [];
}

/** Destroy reports the platform has committed, so the next poll does not refetch them. */
export async function arfExternalReportDestroy(params: {
  ids: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<{ id: string }>> {
  const { ids, baseUrl, env } = params;
  return _xCall<JmapSetResponse<{ id: string }>>(
    JMAP_STALWART,
    'x:ArfExternalReport/set',
    { destroy: ids },
    baseUrl, env,
  );
}

// ── TLS-RPT reports (x:TlsExternalReport/*) ────────────────────────────────
//
// RFC 8460. These arrive because every mail-enabled domain publishes
// `_smtp._tls.<domain> TXT "v=TLSRPTv1; rua=mailto:postmaster@<domain>"`, so a
// receiver that failed — or succeeded — to negotiate TLS to OUR MX reports it
// back daily. The subject is inbound delivery TO us, not our outbound mail.
//
// SHAPE, taken from Stalwart's own registry structs rather than RFC 8460:
//
//   `policies` and `failureDetails` are `List<T>`, which serialises as an
//   object keyed by DECIMAL-STRING INDEX (`{"0": …, "1": …}`) — the same trap
//   as the DMARC `records` below. `.map()` over one yields nothing and reports
//   a clean zero.
//
//   `to`, `mxHosts` and `policyStrings` are `Map<String>`, which serialises as
//   an object keyed BY VALUE (`{"mx.example.test": true}`).
//
// Both are objects; which key means what differs. Read with Object.keys() /
// Object.values() accordingly.

export interface StalwartTlsFailureDetails {
  readonly resultType?: string;
  readonly sendingMtaIp?: string | null;
  readonly receivingMxHostname?: string | null;
  readonly receivingMxHelo?: string | null;
  readonly receivingIp?: string | null;
  readonly failedSessionCount?: number;
  readonly additionalInformation?: string | null;
  readonly failureReasonCode?: string | null;
}

export interface StalwartTlsReportPolicy {
  readonly policyType?: string;
  readonly policyStrings?: Record<string, boolean>;
  readonly policyDomain?: string;
  readonly mxHosts?: Record<string, boolean>;
  readonly totalSuccessfulSessions?: number;
  readonly totalFailedSessions?: number;
  /** Index-keyed object, NOT an array. */
  readonly failureDetails?: Record<string, StalwartTlsFailureDetails>;
}

export interface StalwartTlsReportRow {
  readonly id: string;
  readonly from?: string;
  readonly subject?: string;
  readonly to?: Record<string, boolean>;
  readonly receivedAt?: string;
  readonly expiresAt?: string;
  readonly report?: {
    readonly organizationName?: string | null;
    readonly contactInfo?: string | null;
    readonly reportId?: string;
    readonly dateRangeStart?: string;
    readonly dateRangeEnd?: string;
    /** Index-keyed object, NOT an array. */
    readonly policies?: Record<string, StalwartTlsReportPolicy>;
  };
}

interface XTlsGetResponse {
  readonly list?: readonly StalwartTlsReportRow[];
}

/**
 * List + fetch stored TLS-RPT reports.
 *
 * Capped at 200 per poll, as for the other two report types: a backlog drains
 * across ticks instead of producing one unbounded fetch + insert loop.
 */
export async function tlsExternalReportList(params: {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<readonly StalwartTlsReportRow[]> {
  const { baseUrl, env } = params;
  const auth = adminBasicAuth(env);
  const req: JmapRequest = {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:TlsExternalReport/query', { limit: 200 }, 'q'],
      ['x:TlsExternalReport/get', {
        '#ids': { resultOf: 'q', name: 'x:TlsExternalReport/query', path: '/ids' },
      }, 'g'],
    ],
  };
  const res = await jmapPost(baseUrl ?? STALWART_MGMT_URL, auth, req);
  const get = extractResponse<XTlsGetResponse>(res, 'x:TlsExternalReport/get', 'g');
  return get.list ?? [];
}

export async function tlsExternalReportDestroy(params: {
  ids: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<{ id: string }>> {
  const { ids, baseUrl, env } = params;
  return _xCall<JmapSetResponse<{ id: string }>>(
    JMAP_STALWART,
    'x:TlsExternalReport/set',
    { destroy: ids },
    baseUrl, env,
  );
}

// ── DMARC aggregate reports (x:DmarcExternalReport/*) ───────────────────────
//
// Stalwart's report-analysis does the whole RFC 7489 job for us: it intercepts
// mail to the configured report addresses, un-gzips the attachment, parses the
// aggregate XML, and stores a typed registry object. The platform never sees
// the XML. Confirmed against a live server by delivering a real
// aggregate report and reading the object back — `x:DmarcReport` and
// `x:IncomingReport` return `unknownMethod` on the same server, so the types
// below are the real ones rather than a catch-all responding to anything.
//
// TWO SHAPE DETAILS THAT A PARSER WRITTEN FROM THE RFC WOULD GET WRONG, both
// observed on the wire:
//
//   1. `records`, `dkimResults`, `spfResults` and `errors` are OBJECTS KEYED BY
//      DECIMAL-STRING INDEX (`{"0": …, "1": …}`), not arrays. `.map()` over
//      them yields nothing and silently reports zero messages.
//   2. Result values are camelCase — SPF softfail arrives as `softFail`, not
//      the RFC's `softfail`. A lowercase comparison misses it, and a missed
//      softfail counts as neither pass nor fail.
//
// Retention is Stalwart's default 30d (`expiresAt`), but the platform destroys
// each object once persisted, exactly as it does for ARF.

/** One DKIM or SPF auth result inside a report record. */
export interface StalwartDmarcAuthResult {
  readonly domain?: string | null;
  readonly selector?: string | null;
  readonly scope?: string | null;
  /** camelCase on the wire: `pass` | `fail` | `softFail` | `temperror` | … */
  readonly result?: string | null;
  readonly humanResult?: string | null;
}

/** One row of the aggregate report — a source IP and its message counts. */
export interface StalwartDmarcRecord {
  readonly sourceIp?: string | null;
  readonly count?: number;
  readonly evaluatedDisposition?: string | null;
  readonly evaluatedDkim?: string | null;
  readonly evaluatedSpf?: string | null;
  readonly policyOverrideReasons?: Record<string, unknown>;
  readonly envelopeTo?: string | null;
  readonly envelopeFrom?: string | null;
  readonly headerFrom?: string | null;
  /** Index-keyed, not an array. */
  readonly dkimResults?: Record<string, StalwartDmarcAuthResult>;
  /** Index-keyed, not an array. */
  readonly spfResults?: Record<string, StalwartDmarcAuthResult>;
}

export interface StalwartDmarcReportRow {
  readonly id: string;
  readonly from?: string;
  readonly subject?: string;
  readonly to?: Record<string, boolean>;
  readonly receivedAt?: string;
  readonly expiresAt?: string;
  readonly report?: {
    readonly orgName?: string | null;
    readonly email?: string | null;
    readonly extraContactInfo?: string | null;
    readonly reportId?: string | null;
    readonly dateRangeBegin?: string | null;
    readonly dateRangeEnd?: string | null;
    /** The domain the policy was published for — the attribution key. */
    readonly policyDomain?: string | null;
    readonly policyAdkim?: string | null;
    readonly policyAspf?: string | null;
    readonly policyDisposition?: string | null;
    readonly policySubdomainDisposition?: string | null;
    readonly policyTestingMode?: boolean;
    /** Index-keyed, not an array. */
    readonly records?: Record<string, StalwartDmarcRecord>;
    readonly errors?: Record<string, unknown>;
  };
}

interface XDmarcGetResponse {
  readonly list?: readonly StalwartDmarcReportRow[];
}

/**
 * List + fetch stored DMARC aggregate reports.
 *
 * Capped at 200 per poll for the same reason as ARF: a large backlog should
 * drain across ticks rather than produce one unbounded fetch + insert loop.
 * An aggregate report can carry thousands of records, so the per-report cost
 * here is higher than for ARF and the cap matters more.
 */
export async function dmarcExternalReportList(params: {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<readonly StalwartDmarcReportRow[]> {
  const { baseUrl, env } = params;
  const auth = adminBasicAuth(env);
  const req: JmapRequest = {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:DmarcExternalReport/query', { limit: 200 }, 'q'],
      ['x:DmarcExternalReport/get', {
        '#ids': { resultOf: 'q', name: 'x:DmarcExternalReport/query', path: '/ids' },
      }, 'g'],
    ],
  };
  const res = await jmapPost(baseUrl ?? STALWART_MGMT_URL, auth, req);
  const get = extractResponse<XDmarcGetResponse>(res, 'x:DmarcExternalReport/get', 'g');
  return get.list ?? [];
}

export async function dmarcExternalReportDestroy(params: {
  ids: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<{ id: string }>> {
  const { ids, baseUrl, env } = params;
  return _xCall<JmapSetResponse<{ id: string }>>(
    JMAP_STALWART,
    'x:DmarcExternalReport/set',
    { destroy: ids },
    baseUrl, env,
  );
}

/** One page of `x:SpamTrainingSample` destroys for a single principal. */
export interface SpamTrainingSamplePage {
  /** Sample ids actually destroyed in this page. */
  readonly destroyed: readonly string[];
  /** Server-reported total still matching the filter BEFORE this page's destroy. */
  readonly total: number;
}

interface XSpamSampleQueryResponse {
  readonly ids?: readonly string[];
  readonly total?: number;
}

/**
 * Destroy up to `limit` `x:SpamTrainingSample` rows belonging to one Stalwart
 * principal, in a SINGLE round-trip (query → `#destroy` back-reference).
 *
 * Why this exists: a spam training sample holds the message blob via a
 * `BlobLink::Temporary { until }` stamped at ingest as
 * `midnight + SpamClassifier.holdSamplesFor` — 180 DAYS on a default install.
 * Destroying an Account does NOT drop it (`destroy_account_blobs` unlinks only
 * Email/FileNode/SieveScript hard links), so a deleted tenant's mail keeps its
 * bytes on the mail PVC until that timer expires. Verified on Stalwart v0.16.16:
 * with samples present the blob purge reports `expires 0 / total 4221`; after
 * destroying them, `expires 4200 / total 21` and 2 GiB is reclaimed at the next
 * compaction.
 *
 * Paged deliberately: the back-reference keeps only `limit` ids in flight, so a
 * mailbox with a huge sample backlog can never build an unbounded array in the
 * API process. Callers re-invoke until `destroyed` comes back empty.
 */
export async function spamTrainingSampleDestroyPage(params: {
  /** Stalwart Account (principal) id that owns the samples. */
  principalId: string;
  limit?: number;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SpamTrainingSamplePage> {
  const { principalId, limit = 200, baseUrl, env } = params;
  const auth = adminBasicAuth(env);
  const req: JmapRequest = {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:SpamTrainingSample/query', {
        filter: { accountId: principalId },
        limit,
        calculateTotal: true,
      }, 'q'],
      ['x:SpamTrainingSample/set', {
        '#destroy': { resultOf: 'q', name: 'x:SpamTrainingSample/query', path: '/ids' },
      }, 's'],
    ],
  };
  const res = await jmapPost(baseUrl ?? STALWART_MGMT_URL, auth, req);
  const query = extractResponse<XSpamSampleQueryResponse>(res, 'x:SpamTrainingSample/query', 'q');
  const set = extractResponse<JmapSetResponse<{ id: string }>>(res, 'x:SpamTrainingSample/set', 's');
  return { destroyed: set.destroyed ?? [], total: query.total ?? 0 };
}

export interface StalwartReportSettingsRow {
  readonly id: string;
  readonly inboundReportAddresses?: Record<string, boolean>;
  readonly inboundReportForwarding?: boolean;
}

/**
 * Outbound DMARC aggregate reporting.
 *
 * A SEPARATE singleton from `x:ReportSettings` (which governs INBOUND report
 * intake). Read live: the object is addressable but its list is
 * EMPTY on a fresh server, and empty does not mean off — Stalwart falls back
 * to its built-in defaults, which are `aggregateSendFrequency: daily` and
 * `aggregateFromAddress: 'noreply-dmarc@' + system('domain')`.
 *
 * That default is the whole problem: it derives a sender from the server's own
 * hostname, which on this platform is not a domain the operator controls and
 * has no mailbox, so every DSN for an outgoing report bounces. Reporting is
 * therefore DISABLED unless an operator picks a real local postmaster@.
 *
 * Fields are Stalwart "expressions": `{ match: {}, else: "<value>" }`. String
 * literals inside an expression need their own quotes — `"'daily'"` — which is
 * why the helpers below build them rather than leaving it to callers.
 */
export interface StalwartDmarcReportSettingsRow {
  readonly id: string;
  readonly aggregateSendFrequency?: StalwartExpression;
  readonly aggregateFromAddress?: StalwartExpression;
  readonly aggregateFromName?: StalwartExpression;
  readonly aggregateOrgName?: StalwartExpression;
  readonly aggregateDkimSignDomain?: StalwartExpression;
  /**
   * Failure (forensic, `ruf=`) reports. Same subsystem, same defaults
   * (`[1, 1d]` from `'noreply-dmarc@' + system('domain')`), so it needs the
   * same gate as the aggregate half — see dmarc-report-sender.ts.
   */
  readonly failureSendFrequency?: StalwartExpression;
  readonly failureFromAddress?: StalwartExpression;
  /**
   * The remaining fields of the group. They carry Stalwart's own defaults and
   * the platform has no opinion about their values — but a `/set update`
   * against a never-written singleton only persists when the patch states
   * EVERY field, so they are written all the same. See
   * `DMARC_SETTINGS_FIELDS` in mail-events/dmarc-report-sender.ts.
   */
  readonly aggregateSubject?: StalwartExpression;
  readonly aggregateContactInfo?: StalwartExpression;
  readonly aggregateMaxReportSize?: StalwartExpression;
  readonly failureFromName?: StalwartExpression;
  readonly failureDkimSignDomain?: StalwartExpression;
  readonly failureSubject?: StalwartExpression;
}

export async function dmarcReportSettingsGet(params: {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<StalwartDmarcReportSettingsRow | null> {
  const { baseUrl, env } = params;
  const res = await _xCall<{ list?: readonly StalwartDmarcReportSettingsRow[] }>(
    JMAP_STALWART,
    'x:DmarcReportSettings/get',
    {},
    baseUrl, env,
  );
  // An empty list is the UNWRITTEN state, not an error — see the note above.
  return res.list?.[0] ?? null;
}

export async function dmarcReportSettingsUpdate(params: {
  patch: Record<string, unknown>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<StalwartDmarcReportSettingsRow>> {
  const { patch, baseUrl, env } = params;
  return _xCall<JmapSetResponse<StalwartDmarcReportSettingsRow>>(
    JMAP_STALWART,
    'x:DmarcReportSettings/set',
    { update: { singleton: patch } },
    baseUrl, env,
  );
}

export async function reportSettingsGet(params: {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<StalwartReportSettingsRow | null> {
  const { baseUrl, env } = params;
  const res = await _xCall<{ list?: readonly StalwartReportSettingsRow[] }>(
    JMAP_STALWART,
    'x:ReportSettings/get',
    {},
    baseUrl, env,
  );
  return res.list?.[0] ?? null;
}

export async function reportSettingsUpdate(params: {
  patch: Record<string, unknown>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<StalwartReportSettingsRow>> {
  const { patch, baseUrl, env } = params;
  return _xCall<JmapSetResponse<StalwartReportSettingsRow>>(
    JMAP_STALWART,
    'x:ReportSettings/set',
    { update: { singleton: patch } },
    baseUrl, env,
  );
}

// ── Outbound queue inspection (PR 5 Monitoring Mail tab) ──────────────────

export interface StalwartQueuedMessage {
  readonly id: string;
  readonly createdAt?: string;
  readonly nextRetry?: string | null;
  readonly returnPath?: string;
  /** Integer-keyed map (registry VecMap) of recipients. */
  readonly recipients?: Record<string, { address?: string; status?: unknown }>;
  readonly size?: number;
}

interface XQueuedGetResponse {
  readonly list?: readonly StalwartQueuedMessage[];
}

/** List up to `limit` queued messages (query+get back-reference). */
export async function queuedMessageList(params: {
  limit?: number;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<readonly StalwartQueuedMessage[]> {
  const { limit = 50, baseUrl, env } = params;
  const auth = adminBasicAuth(env);
  const req: JmapRequest = {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:QueuedMessage/query', { limit }, 'q'],
      ['x:QueuedMessage/get', {
        '#ids': { resultOf: 'q', name: 'x:QueuedMessage/query', path: '/ids' },
      }, 'g'],
    ],
  };
  const res = await jmapPost(baseUrl ?? STALWART_MGMT_URL, auth, req);
  const get = extractResponse<XQueuedGetResponse>(res, 'x:QueuedMessage/get', 'g');
  return get.list ?? [];
}

interface XQueuedQueryResponse {
  readonly ids?: readonly string[];
  readonly total?: number;
}

/**
 * Count queued outbound messages without fetching their bodies — a
 * lightweight liveness + backlog probe for the mail-health collector.
 * Uses `calculateTotal` (the count is the JMAP query `total`); falls back
 * to the returned id-page length (bounded by `cap`) when a Stalwart build
 * doesn't populate `total`, so the backlog alert still trips above `cap/2`.
 */
export async function queuedMessageCount(params: {
  cap?: number;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<number> {
  const { cap = 2000, baseUrl, env } = params;
  const auth = adminBasicAuth(env);
  const req: JmapRequest = {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [['x:QueuedMessage/query', { calculateTotal: true, limit: cap }, 'q']],
  };
  const res = await jmapPost(baseUrl ?? STALWART_MGMT_URL, auth, req);
  const q = extractResponse<XQueuedQueryResponse>(res, 'x:QueuedMessage/query', 'q');
  return typeof q.total === 'number' ? q.total : (q.ids?.length ?? 0);
}

// ── Actions (R6 PR 2) ──────────────────────────────────────────────────────
//
// Stalwart loads most registry config (MTA throttles/quotas, report
// settings, webhooks) at boot only; `x:Action/set` with
// {"@type":"ReloadSettings"} re-reads it into the live server and
// cluster-broadcasts the reload — proven live on v0.16.5:
// a throttle rate change applied immediately after the action, with
// no pod restart.

export async function actionReloadSettings(params: {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<void> {
  const { baseUrl, env } = params;
  const res = await _xCall<JmapSetResponse<{ id: string }>>(
    JMAP_STALWART,
    'x:Action/set',
    { create: { reload: { '@type': 'ReloadSettings' } } },
    baseUrl, env,
  );
  if (res.notCreated && Object.keys(res.notCreated).length > 0) {
    throw new Error(`Stalwart ReloadSettings rejected: ${JSON.stringify(res.notCreated)}`);
  }
}

// ── WebHooks (R6 PR 2) ─────────────────────────────────────────────────────
//
// Telemetry webhooks as registry objects. CRITICAL: eventsPolicy
// defaults to "exclude" — a webhook created with only an `events` map
// firehoses everything EXCEPT those events (including frames that leak
// Authorization headers). Always set eventsPolicy: "include".
// Config is loaded at Stalwart boot only — creates/updates need a pod
// roll (see mail-events/webhook-reconciler.ts).

export interface StalwartWebHookRow {
  readonly id: string;
  readonly description?: string;
  readonly url?: string;
  readonly enable?: boolean;
  readonly lossy?: boolean;
  readonly eventsPolicy?: string;
  readonly events?: Record<string, boolean>;
  readonly throttle?: number;
  readonly timeout?: number;
  readonly discardAfter?: number;
  /** Masked ("****") on get when set. */
  readonly signatureKey?: { '@type': string; secret?: string };
}

interface XWebHookGetResponse {
  readonly list?: readonly StalwartWebHookRow[];
}

export async function webHookGet(params: {
  ids?: readonly string[] | null;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<readonly StalwartWebHookRow[]> {
  const { ids, baseUrl, env } = params;
  const res = await _xCall<XWebHookGetResponse>(
    JMAP_STALWART,
    'x:WebHook/get',
    { ids: ids ?? null },
    baseUrl, env,
  );
  return res.list ?? [];
}

export async function webHookSet(params: {
  create?: Record<string, Record<string, unknown>>;
  update?: Record<string, Record<string, unknown>>;
  destroy?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<StalwartWebHookRow>> {
  const { create, update, destroy, baseUrl, env } = params;
  return _xCall<JmapSetResponse<StalwartWebHookRow>>(
    JMAP_STALWART,
    'x:WebHook/set',
    {
      ...(create ? { create } : {}),
      ...(update ? { update } : {}),
      ...(destroy ? { destroy } : {}),
    },
    baseUrl, env,
  );
}

// ── App passwords (a.k.a. "login passwords") ──────────────────────────────────
//
// Stalwart "AppPassword" registry objects are per-account secondary
// credentials: the server generates the secret (returned ONCE on create,
// masked as "****" on every subsequent get), and they authenticate
// anywhere the primary password does (IMAP/SMTP/POP3/JMAP/DAV). The
// platform surfaces them as "login passwords" — the human-facing
// credential set for a mailbox. Same JMAP wire as DkimSignature
// (capability urn:stalwart:jmap); accountId = the mailbox's
// stalwart_principal_id. There is NO REST endpoint for these in v0.16.5.

/**
 * Metadata for a Stalwart AppPassword. The `secret` is masked ("****")
 * on /get — the cleartext is only ever returned inside the /set `created`
 * entry, once.
 */
export interface StalwartAppPasswordRow {
  readonly id: string;
  readonly description?: string;
  readonly createdAt?: string;
  readonly expiresAt?: string | null;
  /** Map of allowed IP/CIDR → true. Empty object = unrestricted. */
  readonly allowedIps?: Record<string, boolean>;
}

interface XAppPasswordGetResponse {
  readonly accountId: JmapAccountId;
  readonly list?: readonly StalwartAppPasswordRow[];
}

/** `x:AppPassword/get` — pass `ids: null` (default) to list all for the account. */
export async function appPasswordGet(params: {
  accountId: JmapAccountId;
  ids?: readonly string[] | null;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<readonly StalwartAppPasswordRow[]> {
  const { accountId, ids, baseUrl, env } = params;
  const res = await _xCall<XAppPasswordGetResponse>(
    JMAP_STALWART,
    'x:AppPassword/get',
    { accountId, ids: ids ?? null },
    baseUrl, env,
  );
  return res.list ?? [];
}

/** `x:AppPassword/set` — create and/or destroy app-password objects. */
export async function appPasswordSet(params: {
  accountId: JmapAccountId;
  create?: Record<string, Record<string, unknown>>;
  destroy?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<StalwartAppPasswordRow & { readonly secret?: string }>> {
  const { accountId, create, destroy, baseUrl, env } = params;
  return _xCall<JmapSetResponse<StalwartAppPasswordRow & { readonly secret?: string }>>(
    JMAP_STALWART,
    'x:AppPassword/set',
    {
      accountId,
      ...(create ? { create } : {}),
      ...(destroy ? { destroy } : {}),
    },
    baseUrl, env,
  );
}

/**
 * `x:Account/query` — search accounts by filter.
 * Stalwart accepts `{ name }`, `{ domainId }`, etc. on the filter.
 */
export async function accountQuery(params: {
  accountId: JmapAccountId;
  filter?: Record<string, unknown>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<XQueryResponse> {
  const { accountId, filter, baseUrl, env } = params;
  return _xCall<XQueryResponse>(
    JMAP_STALWART,
    'x:Account/query',
    { accountId, ...(filter ? { filter } : {}) },
    baseUrl, env,
  );
}

/**
 * `x:Account/set` — create / update / destroy accounts.
 * The `create` payload requires `@type: "User"` and uses
 * `domainId` (not `emails`) to bind the account to its domain.
 * Password updates use the `credentials` map shape:
 *   `{ "credentials/0/secret": "<new>" }`
 * for partial updates, or full replace via
 *   `{ "credentials": { "0": { "@type": "Password", "secret": ... } } }`.
 */
export async function accountSet(params: {
  accountId: JmapAccountId;
  request: JmapSetRequest<Record<string, unknown>>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<Record<string, unknown>>> {
  const { accountId, request, baseUrl, env } = params;
  return _xCall<JmapSetResponse<Record<string, unknown>>>(
    JMAP_STALWART,
    'x:Account/set',
    { accountId, ...request },
    baseUrl, env,
  );
}

/** `x:Domain/get` — fetch one or more domains by ID. */
export async function domainGet(params: {
  accountId: JmapAccountId;
  ids: readonly string[] | null;
  properties?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<XAccountGetResponse> {
  const { accountId, ids, properties, baseUrl, env } = params;
  const projected = _withRequired(properties, REQUIRED_DOMAIN_PROPERTIES);
  return _xCall<XAccountGetResponse>(
    JMAP_STALWART,
    'x:Domain/get',
    { accountId, ids: ids ?? null, ...(projected ? { properties: projected } : {}) },
    baseUrl, env,
  );
}

/** `x:Domain/query` — search domains by filter (typically `{ name }`). */
export async function domainQuery(params: {
  accountId: JmapAccountId;
  filter?: Record<string, unknown>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<XQueryResponse> {
  const { accountId, filter, baseUrl, env } = params;
  return _xCall<XQueryResponse>(
    JMAP_STALWART,
    'x:Domain/query',
    { accountId, ...(filter ? { filter } : {}) },
    baseUrl, env,
  );
}

/** `x:Domain/set` — create / update / destroy domains. */
export async function domainSet(params: {
  accountId: JmapAccountId;
  request: JmapSetRequest<Record<string, unknown>>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<Record<string, unknown>>> {
  const { accountId, request, baseUrl, env } = params;
  return _xCall<JmapSetResponse<Record<string, unknown>>>(
    JMAP_STALWART,
    'x:Domain/set',
    { accountId, ...request },
    baseUrl, env,
  );
}

// ── Legacy Principal/* compatibility shims ──────────────────────────────────
//
// `principalGet` / `principalSet` keep their old signatures (a unified
// "type": individual|domain shape) so existing callers compile without
// change. Internally they fan out to x:Account + x:Domain. Eventually
// every call site should move to the typed x:* helpers above; until
// then, the shim ensures we never hit the unsupported standard
// `Principal/*` methods on the wire.

/**
 * Map an x:Account/get list entry to the legacy `StalwartPrincipal`
 * shape (with `type: 'individual'`).
 */
/**
 * Normalise a Stalwart registry `List<T>`.
 *
 * Stalwart serialises repeated fields as a JSON OBJECT with integer-string
 * keys (`{"0": …, "1": …}`), not as an array — the same shape documented on
 * `StalwartExpression` above. `Array.isArray()` is therefore false for every
 * one of them, and a reader that assumes an array silently sees nothing.
 */
function _stalwartList(raw: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null);
  }
  if (typeof raw === 'object' && raw !== null) {
    return Object.values(raw as Record<string, unknown>)
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null);
  }
  return [];
}

/**
 * Map an x:Account/get list entry to the legacy `StalwartPrincipal` shape.
 *
 * CRITICAL, and verified against a live v0.16 server rather than assumed:
 *
 *  - `name` is only the LOCAL login part ("postmaster"), never the address.
 *  - The full primary address is `emailAddress`.
 *  - **There is no `emails` property.** Aliases live under `aliases`, as a
 *    registry List (index-keyed object), and each entry carries only
 *    `{enabled, name, domainId}` — the local part plus a domain REFERENCE.
 *    Rebuilding the address needs `domainNameById`, which the caller joins
 *    from x:Domain/get.
 *
 * Callers match mailboxes by full address (principals-sync drift detection,
 * `findMailboxByEmail`, the webmail master-user detector), so anything missing
 * here gets reported as "missing from Stalwart". That already happened once for
 * primary addresses; it happened again for aliases because this function read a
 * flat `emails` array the server never sends — which made all 36 aliases on
 * production look like drift while mail to them was being delivered normally.
 *
 * When `domainNameById` is absent, or a `domainId` is unknown, the alias is
 * skipped: the caller could not have resolved it either. Every drift-detecting
 * path lists all domains, so that case does not arise there.
 */
function _accountToPrincipal(
  raw: Record<string, unknown>,
  domainNameById?: ReadonlyMap<string, string>,
): StalwartPrincipal {
  const id = typeof raw.id === 'string' ? raw.id : undefined;
  const name = typeof raw.name === 'string' ? raw.name : '';
  const description = typeof raw.description === 'string' ? raw.description : null;
  const primary = typeof raw.emailAddress === 'string' ? raw.emailAddress : undefined;

  const aliasAddresses: string[] = [];
  for (const entry of _stalwartList(raw.aliases)) {
    // A disabled alias records intent, not a live address.
    if (entry.enabled === false) continue;
    const local = typeof entry.name === 'string' ? entry.name : '';
    const domainId = typeof entry.domainId === 'string' ? entry.domainId : '';
    if (local === '' || domainId === '') continue;
    const domain = domainNameById?.get(domainId);
    if (domain === undefined || domain === '') continue;
    aliasAddresses.push(`${local}@${domain}`);
  }

  // Tolerate a flat `emails` array too — harmless if a future Stalwart adds one.
  const extra = Array.isArray(raw.emails)
    ? (raw.emails as unknown[]).filter((e): e is string => typeof e === 'string')
    : [];

  const merged = [...(primary ? [primary] : []), ...aliasAddresses, ...extra];
  const seen = new Set<string>();
  const emails = merged.filter((e) => {
    const key = e.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { id, type: 'individual', name, description, emails: emails.length > 0 ? emails : undefined };
}

/** Build the `domainId → domain name` join used to rebuild alias addresses. */
function _domainNameById(
  list: readonly Record<string, unknown>[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const d of list) {
    if (typeof d.id === 'string' && typeof d.name === 'string') map.set(d.id, d.name);
  }
  return map;
}

/**
 * Fields the client cannot build a correct principal without.
 *
 * Stalwart honours the JMAP `properties` projection and strips everything
 * unlisted, so a caller that pins a list and forgets one of these gets a
 * silently wrong answer — the exact failure this module has now hit twice.
 * Rather than rely on every call site remembering, add them back here.
 */
const REQUIRED_ACCOUNT_PROPERTIES = ['id', 'name', 'emailAddress', 'aliases'] as const;
const REQUIRED_DOMAIN_PROPERTIES = ['id', 'name'] as const;

function _withRequired(
  properties: readonly string[] | undefined,
  required: readonly string[],
): readonly string[] | undefined {
  if (!properties) return undefined; // no projection → the server returns everything
  return [...new Set([...properties, ...required])];
}

function _domainToPrincipal(raw: Record<string, unknown>): StalwartPrincipal {
  const id = typeof raw.id === 'string' ? raw.id : undefined;
  const name = typeof raw.name === 'string' ? raw.name : '';
  const description = typeof raw.description === 'string' ? raw.description : null;
  const dnsZoneFile = typeof raw.dnsZoneFile === 'string' ? raw.dnsZoneFile : null;
  return { id, type: 'domain', name, description, dnsZoneFile };
}

/**
 * `principalGet` (legacy) — fetches individuals and/or domains and
 * returns them as a unified list. Routes through x:Account/get and
 * x:Domain/get under the hood.
 *
 * Pass `ids: null` to list ALL principals across both namespaces.
 * Pass `ids: [...]` and we'll try x:Account first, then x:Domain for
 * any IDs that came back in `notFound`.
 */
export async function principalGet(params: {
  accountId: JmapAccountId;
  ids: readonly string[] | null;
  properties?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapGetResponse<StalwartPrincipal>> {
  const { accountId, ids, properties, baseUrl, env } = params;

  // List all → query both namespaces in parallel.
  if (ids === null) {
    const [accounts, domains] = await Promise.all([
      accountGet({ accountId, ids: null, properties, baseUrl, env }),
      domainGet({ accountId, ids: null, properties, baseUrl, env }),
    ]);
    // Aliases carry a `domainId`, not a domain name, so accounts can only be
    // mapped once the domain list is in hand. Both namespaces are fetched here
    // anyway — join them rather than emitting half-built addresses.
    const domainNameById = _domainNameById(domains.list);
    return {
      accountId,
      state: `${accounts.state}|${domains.state}`,
      list: [
        ...accounts.list.map((a) => _accountToPrincipal(a, domainNameById)),
        ...domains.list.map(_domainToPrincipal),
      ],
      notFound: [],
    };
  }

  // Specific IDs — try x:Account first; anything in notFound retry on x:Domain.
  const accountResp = await accountGet({ accountId, ids, properties, baseUrl, env });
  const stillMissing = accountResp.notFound;
  let domainList: StalwartPrincipal[] = [];
  let trulyNotFound: readonly string[] = [];
  if (stillMissing.length > 0) {
    const domainResp = await domainGet({
      accountId,
      ids: stillMissing,
      properties,
      baseUrl,
      env,
    });
    domainList = domainResp.list.map(_domainToPrincipal);
    trulyNotFound = domainResp.notFound;
  }
  // This branch has no domain list of its own (domains are fetched only for
  // IDs the account namespace did not recognise), so resolve the join with one
  // extra call — and only when an account actually has aliases to resolve.
  // Dropping them instead would hand the caller an account whose alias
  // addresses silently vanished, which is the bug this whole change fixes.
  const needsDomains = accountResp.list.some((a) => _stalwartList(a.aliases).length > 0);
  let domainNameById: ReadonlyMap<string, string> | undefined;
  if (needsDomains) {
    const allDomains = await domainGet({ accountId, ids: null, properties, baseUrl, env });
    domainNameById = _domainNameById(allDomains.list);
  }
  return {
    accountId,
    state: accountResp.state,
    list: [
      ...accountResp.list.map((a) => _accountToPrincipal(a, domainNameById)),
      ...domainList,
    ],
    notFound: trulyNotFound,
  };
}

/**
 * `Principal/get` shorthand — fetch a single principal by ID.
 *
 * Returns `null` when the server reports the ID in `notFound`.
 */
export async function principalGetOne(params: {
  accountId: JmapAccountId;
  id: string;
  properties?: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StalwartPrincipal | null> {
  const result = await principalGet({ ...params, ids: [params.id] });
  if (result.notFound.includes(params.id)) return null;
  return result.list[0] ?? null;
}

/**
 * `principalSet` (legacy compatibility shim) — dispatches each
 * `create` entry to x:Account/set or x:Domain/set based on the
 * `type` field, and `update` / `destroy` IDs are sent to x:Account
 * first with x:Domain as the fallback.
 *
 * The Stalwart 0.16 server doesn't support a unified `Principal/set`
 * method — it expects calls split per principal kind. This shim
 * keeps the legacy callers (mailboxes/email-domains/principals-sync)
 * working without forcing them to know which namespace each ID lives
 * in.
 */
export async function principalSet<T extends Partial<StalwartPrincipal>>(params: {
  accountId: JmapAccountId;
  request: JmapSetRequest<T>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapSetResponse<StalwartPrincipal>> {
  const { accountId, request, baseUrl, env } = params;

  // Split create into account creates vs domain creates by `type`.
  const accountCreates: Record<string, Record<string, unknown>> = {};
  const domainCreates: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(request.create ?? {})) {
    const principal = v as unknown as StalwartPrincipal & {
      readonly emails?: readonly string[];
      readonly secrets?: readonly string[];
    };
    if (principal.type === 'individual') {
      // Map legacy → x:Account/User shape.
      const credentials: Record<string, unknown> = {};
      const secrets = principal.secrets ?? [];
      secrets.forEach((s, i) => {
        credentials[String(i)] = {
          '@type': 'Password',
          secret: s,
          allowedIps: {},
          expiresAt: null,
        };
      });
      // x:Account requires `domainId`, but the legacy callers only
      // pass `emails`. The mailboxes/service.ts caller now resolves
      // domainId before calling createMailbox; older paths still
      // passing `emails` will fail with a clear server error.
      const accountPayload: Record<string, unknown> = {
        '@type': 'User',
        name: principal.name,
      };
      if (principal.description) accountPayload.description = principal.description;
      if (principal.emails && principal.emails.length > 0) {
        accountPayload.emails = principal.emails;
      }
      if (Object.keys(credentials).length > 0) accountPayload.credentials = credentials;
      accountCreates[k] = accountPayload;
    } else if (principal.type === 'domain') {
      domainCreates[k] = { name: principal.name };
    }
  }

  // Updates / destroys: dispatch by trying x:Account first.
  const updates = request.update ?? {};
  const destroys = request.destroy ?? [];

  // Run x:Account/set with the account-side slices.
  const accountResp = await accountSet({
    accountId,
    request: {
      ...(Object.keys(accountCreates).length > 0 ? { create: accountCreates } : {}),
      ...(Object.keys(updates).length > 0 ? { update: updates as Record<string, Record<string, unknown>> } : {}),
      ...(destroys.length > 0 ? { destroy: destroys } : {}),
      ifInState: request.ifInState,
    },
    baseUrl,
    env,
  });

  // Anything not-{updated|destroyed} on x:Account because of `notFound`
  // → retry on x:Domain. Stalwart's `notUpdated` / `notDestroyed`
  // payloads include `type: 'notFound'` for IDs in the wrong namespace.
  const domainUpdates: Record<string, Record<string, unknown>> = {};
  for (const [id, err] of Object.entries(accountResp.notUpdated ?? {})) {
    if (err.type === 'notFound' && updates[id]) {
      domainUpdates[id] = updates[id] as Record<string, unknown>;
    }
  }
  const domainDestroys: string[] = [];
  for (const [id, err] of Object.entries(accountResp.notDestroyed ?? {})) {
    if (err.type === 'notFound') domainDestroys.push(id);
  }

  if (
    Object.keys(domainCreates).length === 0 &&
    Object.keys(domainUpdates).length === 0 &&
    domainDestroys.length === 0
  ) {
    // Pure-account operation; map the response directly.
    return {
      accountId: accountResp.accountId,
      oldState: accountResp.oldState,
      newState: accountResp.newState,
      created: accountResp.created
        ? Object.fromEntries(
            Object.entries(accountResp.created).map(([k, v]) => [k, _accountToPrincipal(v)]),
          )
        : null,
      updated: accountResp.updated as Record<string, StalwartPrincipal | null> | null,
      destroyed: accountResp.destroyed,
      notCreated: accountResp.notCreated,
      notUpdated: accountResp.notUpdated,
      notDestroyed: accountResp.notDestroyed,
    };
  }

  const domainResp = await domainSet({
    accountId,
    request: {
      ...(Object.keys(domainCreates).length > 0 ? { create: domainCreates } : {}),
      ...(Object.keys(domainUpdates).length > 0 ? { update: domainUpdates } : {}),
      ...(domainDestroys.length > 0 ? { destroy: domainDestroys } : {}),
      ifInState: request.ifInState,
    },
    baseUrl,
    env,
  });

  // Merge the two responses. Account-side notUpdated/notDestroyed
  // entries that were resolved on x:Domain are removed from the
  // notFound bucket.
  const mergedNotUpdated: Record<string, JmapSetError> = { ...(accountResp.notUpdated ?? {}) };
  for (const id of Object.keys(domainUpdates)) {
    if (domainResp.updated && id in domainResp.updated) delete mergedNotUpdated[id];
    if (domainResp.notUpdated && id in domainResp.notUpdated) {
      mergedNotUpdated[id] = domainResp.notUpdated[id];
    }
  }
  const mergedNotDestroyed: Record<string, JmapSetError> = { ...(accountResp.notDestroyed ?? {}) };
  for (const id of domainDestroys) {
    if (domainResp.destroyed?.includes(id)) delete mergedNotDestroyed[id];
    if (domainResp.notDestroyed && id in domainResp.notDestroyed) {
      mergedNotDestroyed[id] = domainResp.notDestroyed[id];
    }
  }

  const created: Record<string, StalwartPrincipal> = {};
  if (accountResp.created) {
    for (const [k, v] of Object.entries(accountResp.created)) created[k] = _accountToPrincipal(v);
  }
  if (domainResp.created) {
    for (const [k, v] of Object.entries(domainResp.created)) created[k] = _domainToPrincipal(v);
  }

  return {
    accountId,
    oldState: accountResp.oldState,
    newState: `${accountResp.newState}|${domainResp.newState}`,
    created: Object.keys(created).length > 0 ? created : null,
    updated: { ...(accountResp.updated as object | null ?? {}), ...(domainResp.updated as object | null ?? {}) } as Record<string, StalwartPrincipal | null> | null,
    destroyed: [...(accountResp.destroyed ?? []), ...(domainResp.destroyed ?? [])],
    notCreated: { ...(accountResp.notCreated ?? {}), ...(domainResp.notCreated ?? {}) },
    notUpdated: Object.keys(mergedNotUpdated).length > 0 ? mergedNotUpdated : null,
    notDestroyed: Object.keys(mergedNotDestroyed).length > 0 ? mergedNotDestroyed : null,
  };
}

/**
 * Create an individual mailbox (email account).
 *
 * Throws `JmapError` if the server rejects the create (e.g. duplicate
 * address, quota policy, etc).
 *
 * Returns the created principal as the server assigned it (with `id`).
 */
export async function createMailbox(params: {
  accountId: JmapAccountId;
  input: CreateMailboxInput;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StalwartPrincipal> {
  const { accountId, input, baseUrl, env } = params;
  const result = await principalSet({
    accountId,
    baseUrl,
    env,
    request: {
      create: { 'new-mailbox': input },
    },
  });

  const notCreated = result.notCreated?.['new-mailbox'];
  if (notCreated) {
    throw new JmapError(
      `Failed to create mailbox '${input.name}': ${notCreated.description ?? notCreated.type}`,
      notCreated.type,
      notCreated,
    );
  }

  const created = result.created?.['new-mailbox'];
  if (!created) {
    throw new JmapError(
      `Principal/set create returned no result for mailbox '${input.name}'`,
      'missingResult',
      result,
    );
  }
  return created;
}

/**
 * Register a domain in Stalwart.
 *
 * After this call, Stalwart will start accepting mail for the domain
 * and will populate `dnsZoneFile` with the DNS records it needs
 * published (MX, SPF, DKIM, etc). The dns-sync module polls that field.
 *
 * Returns the created principal (with server-assigned `id` and
 * `dnsZoneFile`).
 */
export async function createDomain(params: {
  accountId: JmapAccountId;
  input: CreateDomainInput;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StalwartPrincipal> {
  const { accountId, input, baseUrl, env } = params;
  const result = await principalSet({
    accountId,
    baseUrl,
    env,
    request: {
      create: { 'new-domain': input },
    },
  });

  const notCreated = result.notCreated?.['new-domain'];
  if (notCreated) {
    throw new JmapError(
      `Failed to create domain '${input.name}': ${notCreated.description ?? notCreated.type}`,
      notCreated.type,
      notCreated,
    );
  }

  const created = result.created?.['new-domain'];
  if (!created) {
    throw new JmapError(
      `Principal/set create returned no result for domain '${input.name}'`,
      'missingResult',
      result,
    );
  }
  return created;
}

/**
 * Update an existing principal by ID (partial patch).
 *
 * `patch` is a JSON patch-like map of property-paths to new values
 * (Stalwart uses the JMAP /set update semantics, not RFC 6902).
 */
export async function updatePrincipal(params: {
  accountId: JmapAccountId;
  id: string;
  patch: Record<string, unknown>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { accountId, id, patch, baseUrl, env } = params;
  const result = await principalSet({
    accountId,
    baseUrl,
    env,
    request: {
      update: { [id]: patch },
    },
  });

  const notUpdated = result.notUpdated?.[id];
  if (notUpdated) {
    throw new JmapError(
      `Failed to update principal '${id}': ${notUpdated.description ?? notUpdated.type}`,
      notUpdated.type,
      notUpdated,
    );
  }
}

/**
 * Destroy a principal (mailbox or domain) by ID.
 *
 * Throws `JmapError` if the server refuses (e.g. domain still has
 * active mailboxes).
 */
export async function destroyPrincipal(params: {
  accountId: JmapAccountId;
  id: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { accountId, id, baseUrl, env } = params;
  const result = await principalSet({
    accountId,
    baseUrl,
    env,
    request: {
      destroy: [id],
    },
  });

  const notDestroyed = result.notDestroyed?.[id];
  if (notDestroyed) {
    throw new JmapError(
      `Failed to destroy principal '${id}': ${notDestroyed.description ?? notDestroyed.type}`,
      notDestroyed.type,
      notDestroyed,
    );
  }
}

/**
 * `Principal/changes` — detect which principals changed since a
 * known state token.
 *
 * Use the `state` field from a previous `Principal/get` or
 * `Principal/set` response as `sinceState`. A new `state` from
 * the session object is also valid.
 *
 * If `hasMoreChanges` is true in the response, call again with the
 * returned `newState` until it is false.
 */
export async function principalChanges(params: {
  accountId: JmapAccountId;
  sinceState: string;
  maxChanges?: number;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JmapChangesResponse> {
  const { accountId, sinceState, maxChanges = 256, baseUrl, env } = params;
  // Stalwart 0.16: split the call across x:Account/changes and
  // x:Domain/changes; merge the deltas into the legacy unified shape.
  const sinceStates = sinceState.split('|', 2);
  const sinceAccount = sinceStates[0] ?? '';
  const sinceDomain = sinceStates[1] ?? sinceStates[0] ?? '';
  const [accountChanges, domainChanges] = await Promise.all([
    _xCall<JmapChangesResponse>(
      JMAP_STALWART, 'x:Account/changes',
      { accountId, sinceState: sinceAccount, maxChanges },
      baseUrl, env,
    ),
    _xCall<JmapChangesResponse>(
      JMAP_STALWART, 'x:Domain/changes',
      { accountId, sinceState: sinceDomain, maxChanges },
      baseUrl, env,
    ),
  ]);
  return {
    accountId,
    oldState: sinceState,
    newState: `${accountChanges.newState}|${domainChanges.newState}`,
    hasMoreChanges: accountChanges.hasMoreChanges || domainChanges.hasMoreChanges,
    created: [...accountChanges.created, ...domainChanges.created],
    updated: [...accountChanges.updated, ...domainChanges.updated],
    destroyed: [...accountChanges.destroyed, ...domainChanges.destroyed],
  };
}

/**
 * Fetch the DNS zone-file text for a single domain principal.
 *
 * Stalwart populates `dnsZoneFile` on the Domain principal object with
 * all the DNS records it needs published (MX, SPF, DKIM, DMARC, etc)
 * in standard zone-file format. This is the authoritative source for
 * M5 DNS sync — we fetch this and diff it against the platform's
 * `dns_records` table.
 *
 * Returns `null` when the domain does not exist or `dnsZoneFile` is
 * empty (e.g. the domain was just created and Stalwart hasn't populated
 * the field yet).
 */
export async function getDomainDnsZoneFile(params: {
  accountId: JmapAccountId;
  domainPrincipalId: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const principal = await principalGetOne({
    ...params,
    id: params.domainPrincipalId,
    properties: ['id', 'name', 'type', 'dnsZoneFile'],
  });
  if (!principal) return null;
  return principal.dnsZoneFile ?? null;
}

/**
 * Find a domain principal by name (e.g. "example.com").
 *
 * Stalwart doesn't have a server-side filter for Principal/get by name,
 * so we fetch ALL domain principals and filter client-side. This is
 * acceptable for the expected number of domains per install (<1000).
 *
 * Returns `null` if not found.
 */
export async function findDomainByName(params: {
  accountId: JmapAccountId;
  domainName: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StalwartPrincipal | null> {
  const { accountId, domainName, baseUrl, env } = params;
  // Cut 3 follow-up: Stalwart 0.16's x:Domain/query does
  // not support a `name` filter — it silently returns `ids: []` for
  // any filter shape we tried, while x:Domain/get with `ids: null`
  // returns the full list correctly. Use list-and-filter until
  // Stalwart documents a working filter shape.
  const getRes = await domainGet({
    accountId,
    ids: null,
    properties: ['id', 'name', 'description', 'dnsZoneFile'],
    baseUrl,
    env,
  });
  const target = domainName.toLowerCase();
  const match = getRes.list.find((r) => {
    const name = typeof r.name === 'string' ? r.name.toLowerCase() : '';
    return name === target;
  });
  return match ? _domainToPrincipal(match) : null;
}

/**
 * Find an individual mailbox principal by email address.
 *
 * Fetches all individual principals and filters by the `emails` array.
 * Returns `null` if not found.
 */
export async function findMailboxByEmail(params: {
  accountId: JmapAccountId;
  email: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StalwartPrincipal | null> {
  const { accountId, email, baseUrl, env } = params;
  // Cut 3 follow-up: Stalwart 0.16's x:Account/query
  // doesn't accept a working `email` / `name` filter (silently returns
  // ids: []). List-and-filter via x:Account/get with ids: null until
  // a working filter shape is documented.
  // Domains are fetched alongside because an alias entry only carries a
  // `domainId`; without the join this lookup cannot match an alias address at
  // all, and callers read that as "the mailbox does not exist".
  const [getRes, domainRes] = await Promise.all([
    accountGet({
      accountId,
      ids: null,
      // `emailAddress` carries the full primary address (Stalwart's `name` is
      // only the local login part). It MUST be projected or Stalwart strips
      // it — without it this filter matched nothing. `aliases` likewise.
      properties: ['id', 'name', 'description', 'emailAddress', 'aliases'],
      baseUrl,
      env,
    }),
    domainGet({ accountId, ids: null, properties: ['id', 'name'], baseUrl, env }),
  ]);
  const domainNameById = _domainNameById(domainRes.list);
  const target = email.toLowerCase();
  const match = getRes.list
    .map((a) => _accountToPrincipal(a, domainNameById))
    .find((p) => (p.emails ?? []).some((e) => e.toLowerCase() === target));
  return match ?? null;
}

// ── Low-level helpers for sibling stalwart-jmap modules ─────────────────────
//
// `sieve.ts` (platform-managed per-account Sieve scripts + send-only
// permission profile) needs two primitives client.ts keeps private:
// a capability-parameterised single-method call and the JMAP binary
// upload endpoint. Exported here rather than duplicating transport/auth.

/**
 * Single JMAP method call with caller-chosen capabilities. Same admin
 * Basic-Auth + transport as every other helper in this module.
 */
export async function rawStalwartCall<T>(params: {
  using: readonly string[];
  method: string;
  args: Record<string, unknown>;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<T> {
  const { using, method, args, baseUrl = STALWART_MGMT_URL, env = process.env } = params;
  const callId = 'c0';
  const req: JmapRequest = {
    using: [JMAP_CORE, ...using.filter((u) => u !== JMAP_CORE)],
    methodCalls: [[method, args, callId]],
  };
  const res = await jmapPost(baseUrl, adminBasicAuth(env), req);
  return extractResponse<T>(res, method, callId);
}

/**
 * Upload a blob into a target account's blob store (admin cross-account —
 * Stalwart's `impersonate` permission on the admin role allows targeting
 * any accountId). Returns the blobId for use in e.g. SieveScript/set.
 */
export async function uploadBlob(params: {
  /** Target account (the USER's principal id, not the admin session id). */
  accountId: string;
  content: string;
  contentType: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ blobId: string }> {
  const { accountId, content, contentType, baseUrl = STALWART_MGMT_URL, env = process.env } = params;
  const url = `${baseUrl}/jmap/upload/${encodeURIComponent(accountId)}/`;
  const timeoutMs = Number(process.env.JMAP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: adminBasicAuth(env),
      'Content-Type': contentType,
      Accept: 'application/json',
    },
    body: content,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new JmapError(
      `JMAP blob upload to ${url} failed: HTTP ${res.status} ${res.statusText}`,
      'httpError',
      { status: res.status, body: text.slice(0, 500) },
    );
  }
  const data = (await res.json()) as { blobId?: unknown };
  if (typeof data?.blobId !== 'string' || data.blobId.length === 0) {
    throw new JmapError(
      `JMAP blob upload to ${url} returned no blobId`,
      'malformedResponse',
      data,
    );
  }
  return { blobId: data.blobId };
}

/**
 * Cached admin principals-account id (session primaryAccounts) with a
 * 5-minute TTL — the same recovery semantics as mailboxes/service.ts's
 * local cache (a Stalwart rebuild mints new ids; the TTL picks the new
 * one up without a platform-api restart). Returns null when Stalwart is
 * unreachable (unit tests, stacks without the mail overlay).
 */
const PRINCIPALS_ACCOUNT_TTL_MS = 5 * 60 * 1000;
let _principalsAccountCache: JmapAccountId | null = null;
let _principalsAccountCachedAt = 0;

export async function getCachedPrincipalsAccountId(
  env: NodeJS.ProcessEnv = process.env,
): Promise<JmapAccountId | null> {
  if (_principalsAccountCache && Date.now() - _principalsAccountCachedAt < PRINCIPALS_ACCOUNT_TTL_MS) {
    return _principalsAccountCache;
  }
  try {
    const session = await getJmapSession(env.STALWART_MGMT_URL, env);
    const id = session.primaryAccounts['urn:ietf:params:jmap:principals'];
    if (id) {
      _principalsAccountCache = id;
      _principalsAccountCachedAt = Date.now();
    }
    return id ?? null;
  } catch {
    return null;
  }
}
