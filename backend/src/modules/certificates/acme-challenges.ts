/**
 * ACME Challenge visibility, wedge detection and self-healing.
 *
 * WHY THIS EXISTS
 *
 * The platform read Certificate CRs and nothing below them, so the entire ACME
 * layer — Orders and Challenges — was invisible. That blind spot cost a tenant
 * a working certificate for a full day:
 *
 *   cert-manager's challenge scheduler runs at most ONE in-flight challenge per
 *   (dnsName, type). A challenge that reaches `processing: true` and never
 *   completes holds that slot FOREVER, and every later challenge for the same
 *   name is created with a completely EMPTY status and is never processed.
 *
 * Nothing recovered from that on its own. Deleting and recreating the
 * Certificate — which is exactly what the Request Certificate button does —
 * produced a fresh Order whose challenges inherited the same blocked slot, so
 * the button ran, reported success, and changed nothing. Proven on 2026-09-07
 * against the Let's Encrypt STAGING issuer: a certificate for a DIFFERENT name
 * in the same zone issued in ~75s through the same webhook and nameservers,
 * while three separate orders for the wedged name never started at all.
 *
 * A mispointed NS record is the usual way in — issuance is gated on domain
 * verification, so a domain that looks verified starts an order it cannot
 * complete — but it is not the only one. Any challenge that dies mid-flight
 * (an expired authorization, a provider outage during renewal) leaves the same
 * permanent blockage, and renewals hit it just as hard as first issuance.
 *
 * So this module does three things the platform could not do before:
 *   1. read Challenges and say WHY issuance is stuck,
 *   2. tell a wedged challenge apart from one that is merely slow,
 *   3. clear the wedge, on a timer and on demand, so it self-heals.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/** cert-manager's Challenge, narrowed to the fields that matter here. */
export interface AcmeChallenge {
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
    readonly creationTimestamp?: string;
  };
  readonly spec?: {
    readonly dnsName?: string;
    readonly type?: string;
    readonly wildcard?: boolean;
  };
  readonly status?: {
    readonly state?: string;
    readonly processing?: boolean;
    readonly presented?: boolean;
    readonly reason?: string;
  };
}

/**
 * How long a challenge may hold its (dnsName, type) slot before we treat it as
 * wedged rather than slow.
 *
 * Measured on the staging issuer: a single-name order completed in ~75s and a
 * wildcard order (two challenges, run sequentially) in ~165s. Thirty minutes is
 * an order of magnitude above that, which matters because tenants can point a
 * domain at any DNS provider: secondary zones with AXFR lag, high TTLs and
 * rate-limited provider APIs can all make a HEALTHY validation slow without it
 * being wedged in the "holds the slot forever" sense this detects. A genuine
 * wedge never resolves, so waiting longer costs nothing, while guessing too
 * eagerly kills validation that was about to succeed.
 */
export const CHALLENGE_WEDGE_AFTER_MS = 30 * 60 * 1000;

/**
 * A challenge with no status at all is not necessarily wedged — it may simply
 * be queued behind another challenge for the same name, which is legitimate.
 * It only becomes evidence of a problem once the thing it is queued behind is
 * itself wedged, so `blocked` is reported separately from `wedged`.
 */
export type ChallengeDisposition = 'valid' | 'progressing' | 'blocked' | 'wedged';

export interface ChallengeInsight {
  readonly name: string;
  readonly dnsName: string;
  readonly wildcard: boolean;
  readonly disposition: ChallengeDisposition;
  /** cert-manager's own explanation, when it has one. */
  readonly reason?: string;
  readonly ageMs: number;
  /** Set on a `blocked` challenge: the challenge holding its slot. */
  readonly blockedBy?: string;
}

function ageMsOf(c: AcmeChallenge, now: Date): number {
  const created = c.metadata?.creationTimestamp;
  if (!created) return 0;
  const t = new Date(created).getTime();
  return Number.isNaN(t) ? 0 : Math.max(0, now.getTime() - t);
}

/** The scheduler's slot key: one in-flight challenge per name and type. */
function slotKey(c: AcmeChallenge): string {
  return `${(c.spec?.dnsName ?? '').toLowerCase()}|${c.spec?.type ?? ''}`;
}

/**
 * Classify every challenge, resolving `blocked` against the slot that holds it.
 *
 * Takes the whole set rather than one challenge at a time: "blocked" is a
 * statement about a PAIR of challenges, and a per-item classifier cannot see
 * it. That is precisely the relationship no surface exposed, which is why the
 * blocked challenges looked like nothing was happening at all.
 */
export function classifyChallenges(
  challenges: readonly AcmeChallenge[],
  now: Date = new Date(),
): readonly ChallengeInsight[] {
  // Whoever is processing owns the slot.
  const holders = new Map<string, AcmeChallenge>();
  for (const c of challenges) {
    if (c.status?.processing === true) holders.set(slotKey(c), c);
  }

  return challenges.map((c) => {
    const ageMs = ageMsOf(c, now);
    const base = {
      name: c.metadata?.name ?? '(unnamed)',
      dnsName: c.spec?.dnsName ?? '',
      wildcard: c.spec?.wildcard === true,
      reason: c.status?.reason || undefined,
      ageMs,
    };

    if (c.status?.state === 'valid') return { ...base, disposition: 'valid' as const };

    if (c.status?.processing === true) {
      return {
        ...base,
        disposition: ageMs >= CHALLENGE_WEDGE_AFTER_MS ? ('wedged' as const) : ('progressing' as const),
      };
    }

    // No status of its own. If something else holds the slot, say so by name —
    // an operator seeing an empty challenge has no way to guess otherwise.
    const holder = holders.get(slotKey(c));
    if (holder && holder.metadata?.name !== c.metadata?.name) {
      return { ...base, disposition: 'blocked' as const, blockedBy: holder.metadata?.name };
    }
    return { ...base, disposition: 'progressing' as const };
  });
}

/**
 * Remembers which challenges were ALREADY seen wedged on a previous sweep.
 *
 * Deliberately in-memory and per-process. `wedged` is derived purely from wall
 * clock age, so a reconciler that could not run for a while — a CrashLoopBackOff,
 * an OOM kill, a database outage blocking the tick, a node drain — comes back to
 * a cluster full of challenges that aged past the threshold with nobody
 * watching. Acting on that first observation would delete every in-flight
 * challenge across EVERY tenant namespace in a single pass, including ones
 * seconds from completing.
 *
 * Requiring two consecutive sightings makes the automatic sweep cost one extra
 * tick and removes that entire class of incident: after any restart or gap the
 * memory is empty, so the first sweep only observes. It is exactly the
 * hysteresis an age-threshold needs and its volatility is the feature, not a
 * limitation.
 */
export interface WedgeMemory {
  seen: Set<string>;
}

export function createWedgeMemory(): WedgeMemory {
  return { seen: new Set<string>() };
}

/** The wedged challenges, i.e. the ones worth deleting. */
export function wedgedChallenges(
  insights: readonly ChallengeInsight[],
): readonly ChallengeInsight[] {
  return insights.filter((i) => i.disposition === 'wedged');
}

interface ChallengeApi {
  listNamespacedCustomObject: (args: Record<string, unknown>) => Promise<unknown>;
  deleteNamespacedCustomObject: (args: Record<string, unknown>) => Promise<unknown>;
}

const ACME_GROUP = 'acme.cert-manager.io';
const ACME_VERSION = 'v1';
const ACME_PLURAL = 'challenges';

/** Every Challenge in a namespace. */
export async function listChallenges(
  k8s: K8sClients,
  namespace: string,
): Promise<readonly AcmeChallenge[]> {
  // `custom`, not `customObjects` — the K8sClients field name. Reaching for a
  // field that does not exist returns undefined and this degrades to "no
  // challenges", which is indistinguishable from a healthy cluster.
  const api = (k8s as unknown as { custom?: ChallengeApi }).custom;
  if (!api) return [];
  try {
    const res = (await api.listNamespacedCustomObject({
      group: ACME_GROUP,
      version: ACME_VERSION,
      namespace,
      plural: ACME_PLURAL,
    })) as { items?: AcmeChallenge[] };
    return res?.items ?? [];
  } catch {
    // A cluster with no cert-manager CRDs is not an error worth failing a
    // status read over — the caller degrades to "no challenge information".
    return [];
  }
}

export interface ClearResult {
  readonly deleted: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Delete wedged challenges so the slot frees up.
 *
 * cert-manager recreates the challenge from its Order, and the replacement
 * starts clean. Deleting is therefore the recovery, not a destructive act —
 * and it is the ONLY recovery, because nothing in cert-manager times a
 * challenge out on its own.
 *
 * Only ever touches challenges classified `wedged`: a slow-but-moving order
 * must be left alone, or this turns a working renewal into a restart loop.
 */
export async function clearWedgedChallenges(
  k8s: K8sClients,
  namespace: string,
  opts: {
    now?: Date;
    dnsNames?: readonly string[];
    /**
     * Supply on the AUTOMATIC path so a challenge must be seen wedged twice.
     * Omit on the operator-initiated break-glass path: a human who has looked
     * at a stuck certificate and pressed the button should not be made to wait
     * another tick for the machine to agree with them.
     */
    memory?: WedgeMemory;
  } = {},
): Promise<ClearResult> {
  const api = (k8s as unknown as { custom?: ChallengeApi }).custom;
  if (!api) return { deleted: [], errors: [] };

  const all = await listChallenges(k8s, namespace);
  const scoped = opts.dnsNames?.length
    ? all.filter((c) => {
        const n = (c.spec?.dnsName ?? '').toLowerCase().replace(/\.$/, '');
        return opts.dnsNames!.some((raw) => {
          // Callers pass the DOMAIN, but a certificate for a domain also covers
          // its hostnames, and cert-manager names each challenge after the host
          // being validated. Scoping on exact equality alone missed every
          // route: a wedge on blog.example.com is invisible to an operator
          // pressing the button on example.com, which is the whole point of the
          // button. Caught on DEV — the probe challenge was
          // wedgeprobe.testing.phoenix-host.net under domain
          // testing.phoenix-host.net.
          //
          // A wildcard SAN is normalised because cert-manager strips the "*."
          // itself: both challenges of a wildcard order carry the BASE name and
          // are told apart by spec.wildcard (verified on production).
          const d = raw.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
          return n === d || n.endsWith(`.${d}`);
        });
      })
    : all;

  const deleted: string[] = [];
  const errors: string[] = [];
  const wedged = wedgedChallenges(classifyChallenges(scoped, opts.now ?? new Date()));

  if (opts.memory) {
    // Forget anything that recovered, so a challenge that was briefly slow does
    // not carry a strike forward into an unrelated future sweep.
    const stillWedged = new Set(wedged.map((w) => `${namespace}/${w.name}`));
    for (const key of [...opts.memory.seen]) {
      if (key.startsWith(`${namespace}/`) && !stillWedged.has(key)) opts.memory.seen.delete(key);
    }
  }

  for (const w of wedged) {
    if (opts.memory) {
      const key = `${namespace}/${w.name}`;
      if (!opts.memory.seen.has(key)) {
        // First sighting: record and leave it alone.
        opts.memory.seen.add(key);
        continue;
      }
      opts.memory.seen.delete(key);
    }
    try {
      await api.deleteNamespacedCustomObject({
        group: ACME_GROUP,
        version: ACME_VERSION,
        namespace,
        plural: ACME_PLURAL,
        name: w.name,
      });
      deleted.push(w.name);
    } catch (err) {
      errors.push(`${w.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { deleted, errors };
}

/**
 * One operator-facing sentence for the certificate card.
 *
 * The card previously showed only THAT issuance was running and when reissue
 * would next be allowed. Faced with a wedge it said nothing at all, so the
 * operator's only signal was a certificate that never appeared.
 */
export function summarizeChallenges(
  insights: readonly ChallengeInsight[],
): { readonly blocked: boolean; readonly summary?: string } {
  const wedged = insights.find((i) => i.disposition === 'wedged');
  if (wedged) {
    const mins = Math.round(wedged.ageMs / 60000);
    return {
      blocked: true,
      summary:
        `Validation for ${wedged.dnsName} has been stuck for ${mins} minutes`
        + `${wedged.reason ? ` (${wedged.reason})` : ''}. `
        + 'It is being cleared automatically so issuance can restart.',
    };
  }
  const blocked = insights.find((i) => i.disposition === 'blocked');
  if (blocked) {
    return {
      blocked: true,
      summary:
        `Validation for ${blocked.dnsName} is waiting for another challenge on the same name to finish.`,
    };
  }
  const progressing = insights.find((i) => i.disposition === 'progressing');
  if (progressing?.reason) {
    return { blocked: false, summary: progressing.reason };
  }
  return { blocked: false };
}
