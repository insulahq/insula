/**
 * Stalwart Domain + Listener self-healing reconciler.
 *
 * Bridges the gap between `scripts/bootstrap.sh:configure_stalwart_full()`
 * (the one-shot installer that creates the Stalwart `x:Domain` entry,
 * AcmeProvider, `Automatic` certificateManagement, AcmeRenewal task, and
 * the three NetworkListeners `http-acme`/`submission`/`imap`) and the
 * runtime reality that:
 *
 *   1. Bootstrap can drop steps silently — `configure_stalwart_full` did
 *      not exist in earlier bootstrap versions, and old clusters that
 *      installed before it landed will never have these objects.
 *   2. Operator-edited `mail_server_hostname` in Admin UI → Mail Settings
 *      previously only updated Stalwart's `SystemSettings.defaultHostname`
 *      (banners + EHLO). The Domain entry stayed bound to whatever
 *      hostname bootstrap installed with — and stayed `Manual` (no
 *      ACME). So a re-hostname'd install kept serving the rcgen
 *      self-signed cert.
 *   3. Stalwart's embedded store is the source of truth; nothing else
 *      reconciles drift. A wipe + restore (or operator-tinkering via
 *      the upstream web-admin UI) could remove a listener and we'd
 *      have no way to detect it.
 *
 * **Design** — self-healing, not authoritative. Every step is gated on
 * an existence check (idempotent). The reconciler never destroys
 * existing entries — operator-customized ports / extra listeners /
 * additional domains stay untouched. If the world is already correct,
 * the tick is a no-op (3 x:* GETs).
 *
 * **Mail bring-up decoupled from NS delegation** — this is the explicit
 * point. ACME HTTP-01 needs only:
 *   - DNS A record for the mail hostname resolving to the public IPs
 *   - Port 80 reachable
 *   - Stalwart's `http-acme` listener bound (this reconciler ensures it)
 * Full NS delegation (MX/SPF/DKIM/DMARC publishing under the apex) is
 * orthogonal and only matters for outbound deliverability.
 *
 * **Tick cadence**: 60s (matches proxy-networks-reconciler).
 * **Inline trigger**: also called from `PATCH /admin/webmail-settings`
 * so a hostname save reconciles immediately rather than waiting for
 * the next tick.
 */

import type { CoreV1Api } from '@kubernetes/client-node';

import { eq } from 'drizzle-orm';

import { readStalwartCredentials } from './credentials.js';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, key));
  return row?.value ?? null;
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
  /** Apex the reconciler used (derived from mail_server_hostname). */
  readonly apex: string | null;
  /** SAN key used (e.g. "mail" for mail.example.com). */
  readonly sanKey: string | null;
  readonly domainCreated: boolean;
  readonly acmeProviderCreated: boolean;
  readonly certManagementUpdated: boolean;
  /** Names of listeners newly created (subset of REQUIRED_LISTENERS). */
  readonly listenersCreated: ReadonlyArray<string>;
  readonly acmeRenewalFired: boolean;
  /** Free-form per-step notes for the UI ("skipped — no admin creds", etc). */
  readonly notes: ReadonlyArray<string>;
  /** Convenience: true if every step was a clean no-op (idempotent re-run). */
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
  const emptyResult = (note: string): StalwartReconcileResult => {
    notes.push(note);
    return {
      apex: null,
      sanKey: null,
      domainCreated: false,
      acmeProviderCreated: false,
      certManagementUpdated: false,
      listenersCreated: [],
      acmeRenewalFired: false,
      notes,
      noOp: true,
    };
  };

  // 1. Read the operator-chosen mail hostname (set via Admin UI → Mail
  //    Settings → SMTP/IMAP hostname). Apex is derived by stripping the
  //    leading `mail.` label, falling back to the full hostname if there
  //    is no such prefix.
  const mailHostname = await getSetting(deps.db, 'mail_server_hostname');
  if (!mailHostname || mailHostname.trim().length === 0) {
    return emptyResult('mail_server_hostname is unset — set it via Admin UI → Mail Settings');
  }
  const trimmedHost = mailHostname.trim().toLowerCase();
  const apex = trimmedHost.startsWith('mail.') ? trimmedHost.slice('mail.'.length) : trimmedHost;
  const sanKey = trimmedHost.startsWith('mail.') ? 'mail' : trimmedHost.split('.')[0];

  // 2. Build JMAP transport. Prod path: exec curl inside a Running
  //    Stalwart pod (matches proxy-networks-reconciler.ts pattern —
  //    loopback bypasses Stalwart's PROXY-v2 sniff irrespective of
  //    any trust-list drift).
  const env = deps.env ?? process.env;
  let auth: string;
  try {
    const { username, password } = readStalwartCredentials(env);
    auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  } catch (err) {
    log.warn('Stalwart admin creds not available — skipping tick:', err);
    notes.push(`admin creds unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { apex, sanKey, domainCreated: false, acmeProviderCreated: false, certManagementUpdated: false, listenersCreated: [], acmeRenewalFired: false, notes, noOp: true };
  }

  let jmapCall: JmapCall;
  if (deps.jmapTransport) {
    jmapCall = deps.jmapTransport;
  } else {
    const podName = await findStalwartPodName(deps.core, log);
    if (!podName) {
      notes.push('no Running Stalwart pod found');
      return { apex, sanKey, domainCreated: false, acmeProviderCreated: false, certManagementUpdated: false, listenersCreated: [], acmeRenewalFired: false, notes, noOp: true };
    }
    const transport: ExecTransport = {
      core: deps.core,
      podName,
      kubeconfigPath: deps.kubeconfigPath,
    };
    jmapCall = (a, b) => jmapPostViaExec(transport, a, b);
  }

  let domainId: string | null;
  let domainCreated = false;
  try {
    const r = await ensureDomain(jmapCall, auth, apex, log);
    domainId = r.id;
    domainCreated = r.created;
  } catch (err) {
    notes.push(`x:Domain ensure failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('Stalwart x:Domain ensure failed:', err);
    return { apex, sanKey, domainCreated: false, acmeProviderCreated: false, certManagementUpdated: false, listenersCreated: [], acmeRenewalFired: false, notes, noOp: false };
  }
  if (!domainId) {
    notes.push('x:Domain create rejected');
    return { apex, sanKey, domainCreated: false, acmeProviderCreated: false, certManagementUpdated: false, listenersCreated: [], acmeRenewalFired: false, notes, noOp: false };
  }

  let acmeProviderId: string | null;
  let acmeProviderCreated = false;
  try {
    const r = await ensureAcmeProvider(jmapCall, auth, log);
    acmeProviderId = r.id;
    acmeProviderCreated = r.created;
  } catch (err) {
    notes.push(`x:AcmeProvider ensure failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('Stalwart x:AcmeProvider ensure failed:', err);
    return { apex, sanKey, domainCreated, acmeProviderCreated: false, certManagementUpdated: false, listenersCreated: [], acmeRenewalFired: false, notes, noOp: false };
  }
  if (!acmeProviderId) {
    notes.push('x:AcmeProvider create rejected');
    return { apex, sanKey, domainCreated, acmeProviderCreated: false, certManagementUpdated: false, listenersCreated: [], acmeRenewalFired: false, notes, noOp: false };
  }

  let certManagementUpdated = false;
  try {
    certManagementUpdated = await ensureDomainCertManagement(jmapCall, auth, domainId, acmeProviderId, sanKey, log);
  } catch (err) {
    notes.push(`Domain.certificateManagement ensure failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('Stalwart Domain.certificateManagement ensure failed:', err);
  }

  let listenersCreated: ReadonlyArray<string> = [];
  try {
    listenersCreated = await ensureRequiredListeners(jmapCall, auth, log);
  } catch (err) {
    notes.push(`NetworkListener ensure failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('Stalwart NetworkListener ensure failed:', err);
  }

  let acmeRenewalFired = false;
  try {
    acmeRenewalFired = await fireAcmeRenewal(jmapCall, auth, domainId, log);
  } catch (err) {
    notes.push(`AcmeRenewal fire failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('Stalwart AcmeRenewal task fire failed:', err);
  }

  const noOp =
    !domainCreated
    && !acmeProviderCreated
    && !certManagementUpdated
    && listenersCreated.length === 0;
  return { apex, sanKey, domainCreated, acmeProviderCreated, certManagementUpdated, listenersCreated, acmeRenewalFired, notes, noOp };
}

// ── Internal: each ensure step ────────────────────────────────────────

async function ensureDomain(
  jmapCall: JmapCall,
  auth: string,
  apex: string,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<{ id: string | null; created: boolean }> {
  const getRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:Domain/get', { accountId: ADMIN_ACCOUNT_ID, ids: null, properties: ['id', 'name'] }, 'c0'],
    ],
  });
  const args = getRes.methodResponses[0]?.[1] as { list?: ReadonlyArray<{ id?: string; name?: string }> };
  const list = args?.list ?? [];
  const existing = list.find((d) => d.name?.toLowerCase() === apex);
  if (existing?.id) {
    return { id: existing.id, created: false };
  }

  const setRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:Domain/set', { accountId: ADMIN_ACCOUNT_ID, create: { d: { name: apex } } }, 'c0'],
    ],
  });
  const setArgs = setRes.methodResponses[0]?.[1] as {
    created?: Record<string, { id?: string }>;
    notCreated?: Record<string, { description?: string }>;
  };
  const notCreated = setArgs?.notCreated ?? {};
  if (Object.keys(notCreated).length > 0) {
    log.warn(`x:Domain/set create rejected for apex=${apex}:`, JSON.stringify(notCreated));
    return { id: null, created: false };
  }
  const id = setArgs?.created?.d?.id ?? null;
  if (id) log.info(`Stalwart x:Domain created for apex=${apex} (id=${id})`);
  return { id, created: id !== null };
}

async function ensureAcmeProvider(
  jmapCall: JmapCall,
  auth: string,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<{ id: string | null; created: boolean }> {
  const getRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:AcmeProvider/get', { accountId: ADMIN_ACCOUNT_ID, ids: null, properties: ['id', 'name'] }, 'c0'],
    ],
  });
  const args = getRes.methodResponses[0]?.[1] as { list?: ReadonlyArray<{ id?: string; name?: string }> };
  const list = args?.list ?? [];
  const existing = list[0];
  if (existing?.id) return { id: existing.id, created: false };

  const setRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:AcmeProvider/set',
        {
          accountId: ADMIN_ACCOUNT_ID,
          create: {
            [ACME_PROVIDER_KEY]: {
              name: ACME_PROVIDER_KEY,
              directoryUrl: 'https://acme-v02.api.letsencrypt.org/directory',
              challengeType: 'Http01',
            },
          },
        },
        'c0',
      ],
    ],
  });
  const setArgs = setRes.methodResponses[0]?.[1] as {
    created?: Record<string, { id?: string }>;
    notCreated?: Record<string, { description?: string }>;
  };
  const notCreated = setArgs?.notCreated ?? {};
  if (Object.keys(notCreated).length > 0) {
    log.warn('x:AcmeProvider/set create rejected:', JSON.stringify(notCreated));
    return { id: null, created: false };
  }
  const id = setArgs?.created?.[ACME_PROVIDER_KEY]?.id ?? null;
  if (id) log.info(`Stalwart x:AcmeProvider created (id=${id})`);
  return { id, created: id !== null };
}

async function ensureDomainCertManagement(
  jmapCall: JmapCall,
  auth: string,
  domainId: string,
  acmeProviderId: string,
  sanKey: string,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<boolean> {
  // Read current certificateManagement to avoid a no-op patch (Stalwart
  // accepts it but every patch advances ETag → cache invalidations
  // elsewhere).
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
    list?: ReadonlyArray<{ certificateManagement?: CertManagement }>;
  };
  const current = args?.list?.[0]?.certificateManagement;
  if (
    current?.['@type'] === 'Automatic'
    && current.acmeProviderId === acmeProviderId
    && current.subjectAlternativeNames
    && current.subjectAlternativeNames[sanKey] === true
  ) {
    return false; // already correct — no patch needed
  }

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
                subjectAlternativeNames: { [sanKey]: true },
              },
            },
          },
        },
        'c0',
      ],
    ],
  });
  log.info(
    `Stalwart Domain.certificateManagement = Automatic (domainId=${domainId}, acme=${acmeProviderId}, san=${sanKey})`,
  );
  return true;
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

async function fireAcmeRenewal(
  jmapCall: JmapCall,
  auth: string,
  domainId: string,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<boolean> {
  // x:Task/set AcmeRenewal — idempotent on the Stalwart side (skips
  // LE round-trip if the cert is fresh + valid for its SANs).
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
    // Common case: task with same key is in-flight; treat as soft-warn.
    log.warn('x:Task/set AcmeRenewal noop:', JSON.stringify(notCreated));
    return false;
  }
  log.info(`Stalwart AcmeRenewal task fired (domainId=${domainId})`);
  return true;
}

// ── JMAP transport (exec into Stalwart pod) ──────────────────────────

interface CertManagement {
  readonly '@type'?: string;
  readonly acmeProviderId?: string;
  readonly subjectAlternativeNames?: Record<string, boolean>;
}

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
