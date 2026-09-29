import type { OperatorError } from '@insula/api-contracts';

/**
 * Turn a deployment's raw `lastError` into something a tenant can act on.
 *
 * `lastError` is whatever the Kubernetes client threw, which for a rejected
 * pod is the API server's entire Status body:
 *
 *   HTTP-Code: 403 … Body: {"kind":"Status","apiVersion":"v1","status":"Failure",
 *   "message":"pods \"moodle-…\" is forbidden: exceeded quota: …-quota,
 *   requested: limits.memory=512Mi, used: limits.memory=544Mi,
 *   limited: limits.memory=1Gi","reason":"Forbidden","code":403}
 *
 * Rendered verbatim on a card, that is unreadable twice over — too long to
 * read as prose and too dense to read as JSON. The facts a tenant needs are
 * three numbers inside it.
 *
 * This returns the platform's standard `OperatorError`, so `<ErrorPanel>`
 * renders it like every other failure: a plain sentence, what to do about it,
 * and a "More details" table holding the decoded fields. Nothing is discarded
 * — the raw string is always the last row.
 */

/**
 * Kubernetes quota keys → what a tenant calls them, and how that budget is
 * charged.
 *
 * ★ The two CPU keys are DIFFERENT budgets and must not share a sentence.
 *
 * `requests.cpu` is what the tenant's apps RESERVE. `limits.cpu` is the
 * ceiling budget: every container is charged its whole burst ceiling against
 * it the moment it starts, used or not. Calling both of them "cpu" produced a
 * message a tenant cannot act on — and worse, one they can disprove: it said
 * two cores were "already in use" while their own usage page, correctly, read
 * near zero. Neither number is usage. Nothing says which one it is unless
 * this table does.
 */
interface ResourceKind {
  /** Heading in the diagnostics table, and the noun in the title. */
  readonly label: string;
  /** The noun mid-sentence — what the app is asking for some of. */
  readonly noun: string;
  /** Whose budget this is. Completes "Of the 2 cores …". */
  readonly budget: string;
  /** What the used figure means. Completes "… already reserved". */
  readonly charge: string;
  /** Answers "but nothing is using that much!" — the whole point. */
  readonly note?: string;
  /** Overrides the "Not enough <label> in your plan" title. */
  readonly title?: string;
}

const PLAN_BUDGET = 'your plan allows';

const RESOURCE_KINDS: Record<string, ResourceKind> = {
  'requests.cpu': {
    label: 'CPU',
    noun: 'reserved CPU',
    // Not "your plan allows": on the share model this budget is sized by the
    // platform from what the apps actually ask for, and only on the older
    // model is it the plan's CPU figure. True either way.
    budget: 'this account may reserve',
    charge: 'reserved',
    note: 'Reserved is not the same as in use: an app holds its reservation while it is idle, '
      + 'so your usage figures can read near zero while this budget is full.',
    title: 'No CPU reservation left for this app',
  },
  'limits.cpu': {
    label: 'CPU ceiling',
    noun: 'CPU ceiling',
    budget: 'of CPU ceiling this account may commit',
    charge: 'committed',
    note: 'Every app is charged its full burst ceiling here the moment it starts, whether it '
      + 'uses that much or not — so this fills up with idle apps.',
    title: 'No CPU ceiling left for this app',
  },
  'requests.memory': { label: 'Memory', noun: 'memory', budget: PLAN_BUDGET, charge: 'reserved' },
  'limits.memory': { label: 'Memory', noun: 'memory', budget: PLAN_BUDGET, charge: 'reserved' },
  'requests.storage': { label: 'Storage', noun: 'storage', budget: PLAN_BUDGET, charge: 'used' },
  'count/pods': { label: 'Pods', noun: 'pods', budget: PLAN_BUDGET, charge: 'running' },
  'count/services': { label: 'Services', noun: 'services', budget: PLAN_BUDGET, charge: 'in use' },
  persistentvolumeclaims: { label: 'Volumes', noun: 'volumes', budget: PLAN_BUDGET, charge: 'in use' },
};

function kindFor(key: string): ResourceKind {
  return RESOURCE_KINDS[key] ?? { label: key, noun: key, budget: PLAN_BUDGET, charge: 'in use' };
}

const MIB_PER_GI = 1024;

/** Parse a Kubernetes memory/storage quantity to MiB. Returns null if unparseable. */
function toMiB(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'Ki': return n / 1024;
    case 'Mi': return n;
    case 'Gi': return n * MIB_PER_GI;
    case 'Ti': return n * MIB_PER_GI * 1024;
    case 'K': return (n * 1000) / (1024 * 1024);
    case 'M': return (n * 1e6) / (1024 * 1024);
    case 'G': return (n * 1e9) / (1024 * 1024);
    case 'T': return (n * 1e12) / (1024 * 1024);
    default: return n / (1024 * 1024); // bare bytes
  }
}

/** Parse a Kubernetes CPU quantity to cores. Returns null if unparseable. */
function toCores(value: string): number | null {
  const t = value.trim();
  const n = t.endsWith('m') ? Number(t.slice(0, -1)) / 1000 : Number(t);
  return Number.isFinite(n) ? n : null;
}

function formatMiB(mib: number): string {
  if (mib >= MIB_PER_GI && mib % MIB_PER_GI === 0) return `${mib / MIB_PER_GI}Gi`;
  if (mib >= MIB_PER_GI) return `${(mib / MIB_PER_GI).toFixed(2).replace(/\.?0+$/, '')}Gi`;
  return `${Math.round(mib)}Mi`;
}

function formatCores(cores: number): string {
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  const n = Number(cores.toFixed(3));
  return `${n} ${n === 1 ? 'core' : 'cores'}`;
}
/** Parse a plain object count (`count/pods`, `persistentvolumeclaims`). */
function toCount(value: string): number | null {
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

function formatCount(n: number): string {
  return `${n}`;
}

/**
 * "2 cores are", "1 core is", "544Mi is".
 *
 * A formatted quantity is plural only when it names a countable unit and
 * there is more than one of it; `544Mi` of memory is a mass noun and stays
 * singular however large it gets.
 */
function agrees(formatted: string): string {
  if (/cores$/.test(formatted)) return 'are';
  if (/^\d+$/.test(formatted)) return Number(formatted) === 1 ? 'is' : 'are';
  return 'is';
}


interface QuotaResource {
  readonly key: string;
  readonly label: string;
  /**
   * Quantities as Kubernetes wrote them — kept for the diagnostics table so
   * the decoded numbers can always be checked against the raw ones.
   */
  readonly requested: string;
  readonly used: string;
  readonly limit: string;
  /**
   * The same three, normalised and unit-suffixed, plus headroom and
   * shortfall. Null when a quantity did not parse.
   *
   * ★ Mixing raw and formatted values is how the sentence came to read
   * "only 0m of your 2 plan is free": `free` had been through the formatter
   * and `limit` had not, so one number carried a unit and the other did not.
   * Either every number in a sentence is formatted or none is.
   */
  readonly requestedF: string | null;
  readonly usedF: string | null;
  readonly limitF: string | null;
  readonly free: string | null;
  readonly shortBy: string | null;
}

/**
 * Pull the `requested: k=v, …` / `used: …` / `limited: …` sections out of a
 * Kubernetes quota rejection.
 *
 * Kubernetes emits one entry per exhausted resource and a pod blocked on
 * memory is usually listed twice (`limits.memory` AND `requests.memory`)
 * because tenant workloads set request == limit. Deduplicated by label so the
 * table says "Memory" once.
 */
function parseQuotaResources(message: string): QuotaResource[] {
  const section = (name: string): Record<string, string> => {
    const m = new RegExp(`${name}:\\s*([^:]*?)(?:,\\s*(?:requested|used|limited):|$)`).exec(message);
    if (!m) return {};
    const out: Record<string, string> = {};
    for (const pair of m[1].split(/,\s*/)) {
      const [k, v] = pair.split('=');
      if (k && v) out[k.trim()] = v.trim();
    }
    return out;
  };

  const requested = section('requested');
  const used = section('used');
  const limited = section('limited');

  const seen = new Set<string>();
  const rows: QuotaResource[] = [];

  for (const key of Object.keys(requested)) {
    const { label } = kindFor(key);
    // Memory is listed under both of its keys because tenant workloads set
    // request == limit, so one row is right. The two CPU keys are different
    // budgets with different labels, and both survive.
    if (seen.has(label)) continue;
    seen.add(label);

    const req = requested[key];
    const use = used[key] ?? '';
    const lim = limited[key] ?? '';

    let free: string | null = null;
    let shortBy: string | null = null;
    let requestedF: string | null = null;
    let usedF: string | null = null;
    let limitF: string | null = null;
    const isCpu = key.endsWith('cpu');
    const isCount = !isCpu && (key.startsWith('count/') || key === 'persistentvolumeclaims');
    const parse = isCpu ? toCores : isCount ? toCount : toMiB;
    const format = isCpu ? formatCores : isCount ? formatCount : formatMiB;
    const pReq = parse(req);
    const pUse = parse(use);
    const pLim = parse(lim);
    if (pReq !== null && pUse !== null && pLim !== null) {
      requestedF = format(pReq);
      usedF = format(pUse);
      limitF = format(pLim);
      free = format(Math.max(0, pLim - pUse));
      shortBy = format(Math.max(0, pReq - (pLim - pUse)));
    }

    rows.push({
      key, label, requested: req, used: use, limit: lim,
      requestedF, usedF, limitF, free, shortBy,
    });
  }

  return rows;
}

/**
 * An `OperatorError` the platform already built, JSON-encoded.
 *
 * The status reconciler stores its envelope in `lastError`, so most of what
 * reaches this function is NOT a raw Kubernetes body — it is a structured
 * error that only *looks* like noise because it arrives as a string. Rendering
 * it without unpacking puts `{"code":"UNKNOWN","title":…}` on the card, which
 * is the exact failure decoding was added to remove, reached by another door.
 */
function parseOperatorEnvelope(raw: string): OperatorError | null {
  if (!raw.startsWith('{')) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.code === 'string' && typeof p.title === 'string' && typeof p.detail === 'string') {
      return p as unknown as OperatorError;
    }
  } catch { /* not an envelope — fall through to the plain-text paths */ }
  return null;
}

/**
 * The platform's own rendering of a quota rejection, e.g.
 * `memory limit: requesting 512Mi, already using 1792Mi of 2Gi limit`.
 *
 * By the time a quota failure has been through the status reconciler the
 * original `requested:/used:/limited:` key-value form is gone — it has already
 * been formatted for a human. Both shapes therefore have to be readable here,
 * or the table is only ever built for whichever path happens to reach the
 * panel first.
 */
// `already (using|claimed)`: the backend said "using" for a long time, and
// deployments still carry that wording in their stored lastError. A parser
// that only knows the new phrasing would silently stop decoding every error
// written before the change.
const FORMATTED_QUOTA = /([A-Za-z ]+?):\s*requesting\s+(\S+?),\s*already (?:using|claimed)\s+(\S+?)\s+of\s+(\S+?)\s+limit/g;

/**
 * The backend's own label (`CPU limit`, `memory request`, …) back to the
 * Kubernetes quota key it came from.
 *
 * ★ This is the fact the tenant-facing sentence needs and the old code threw
 * away: "CPU limit" and "CPU request" are two different budgets, and both
 * were being flattened to the label "CPU".
 */
function keyForFormattedLabel(raw: string): string {
  const l = raw.trim().toLowerCase();
  if (l.includes('cpu')) return l.includes('limit') ? 'limits.cpu' : 'requests.cpu';
  if (l.includes('memory')) return l.includes('limit') ? 'limits.memory' : 'requests.memory';
  if (l.includes('storage')) return 'requests.storage';
  if (l.includes('pod')) return 'count/pods';
  if (l.includes('service')) return 'count/services';
  if (l.includes('pvc') || l.includes('volume')) return 'persistentvolumeclaims';
  return raw.trim();
}

function parseFormattedQuota(message: string): QuotaResource[] {
  const seen = new Set<string>();
  const rows: QuotaResource[] = [];
  for (const m of message.matchAll(FORMATTED_QUOTA)) {
    // "memory limit" / "memory request" are one resource to a tenant — that
    // distinction really is Kubernetes' bookkeeping. The two CPU budgets are
    // not: one is what the apps reserve, the other is what they may burst to.
    const key = keyForFormattedLabel(m[1]);
    const { label } = kindFor(key);
    if (seen.has(label)) continue;
    seen.add(label);
    const [, , requested, used, limit] = m;
    const isCpu = key.endsWith('cpu');
    const isCount = !isCpu && (key.startsWith('count/') || key === 'persistentvolumeclaims');
    const parse = isCpu ? toCores : isCount ? toCount : toMiB;
    const format = isCpu ? formatCores : isCount ? formatCount : formatMiB;
    const pReq = parse(requested), pUse = parse(used), pLim = parse(limit);
    const known = pReq !== null && pUse !== null && pLim !== null;
    rows.push({
      key, label, requested, used, limit,
      requestedF: known ? format(pReq!) : null,
      usedF: known ? format(pUse!) : null,
      limitF: known ? format(pLim!) : null,
      free: known ? format(Math.max(0, pLim! - pUse!)) : null,
      shortBy: known ? format(Math.max(0, pReq! - (pLim! - pUse!))) : null,
    });
  }
  return rows;
}

/**
 * Unwrap the Kubernetes Status envelope, if there is one.
 *
 * The client stringifies the whole HTTP response, so the useful message sits
 * inside a JSON object somewhere in the middle of the text.
 */
function unwrapK8sStatus(raw: string): { message: string; fields: Record<string, unknown> } {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { message: raw, fields: {} };

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.message !== 'string') return { message: raw, fields: {} };

    const fields: Record<string, unknown> = {};
    if (typeof parsed.reason === 'string') fields.Reason = parsed.reason;
    if (typeof parsed.code === 'number') fields['HTTP status'] = parsed.code;
    return { message: parsed.message, fields };
  } catch {
    // Not JSON after all (a brace inside a plain message). Keep the raw text —
    // a failed parse must not cost the operator the message itself.
    return { message: raw, fields: {} };
  }
}

export function describeDeploymentError(raw: string): OperatorError {
  const trimmed = raw.trim();

  // Structured already? Then the work is to USE it, not to rebuild it.
  const envelope = parseOperatorEnvelope(trimmed);
  if (envelope) {
    // `detail` is capped at 240 chars upstream and can stop mid-word;
    // `diagnostics.raw` carries the whole message.
    const upstream = typeof envelope.diagnostics?.raw === 'string'
      ? envelope.diagnostics.raw
      : envelope.detail;
    const rows = parseFormattedQuota(upstream);
    if (rows.length > 0) return quotaError(rows, {}, trimmed);
    return {
      ...envelope,
      diagnostics: { ...(envelope.diagnostics ?? {}), 'Raw error': trimmed },
    };
  }

  const { message, fields } = unwrapK8sStatus(trimmed);

  if (message.includes('exceeded quota')) {
    return quotaError(parseQuotaResources(message), fields, trimmed);
  }

  return {
    code: 'DEPLOYMENT_FAILED',
    title: 'Deployment failed',
    detail: message,
    remediation: ['Retry the deployment.', 'If it keeps failing, send the details below to your provider.'],
    retryable: true,
    diagnostics: { ...fields, 'Raw error': trimmed },
  };
}

/** One rendering of a quota rejection, whichever shape it arrived in. */
function quotaError(
  rows: readonly QuotaResource[],
  fields: Record<string, unknown>,
  trimmed: string,
): OperatorError {
  {
    const primary = rows[0];

    const diagnostics: Record<string, unknown> = {};
    for (const r of rows) {
      const k = kindFor(r.key);
      diagnostics[`${r.label} requested`] = r.requested;
      diagnostics[`${r.label} already ${k.charge}`] = r.used;
      diagnostics[`${r.label} limit`] = r.limit;
      // The quota key itself: the one fact that says which budget this is,
      // and the first thing worth quoting to a provider.
      diagnostics[`${r.label} quota key`] = r.key;
      if (r.free !== null) diagnostics[`${r.label} free`] = r.free;
      if (r.shortBy !== null) diagnostics[`${r.label} short by`] = r.shortBy;
    }
    Object.assign(diagnostics, fields);
    diagnostics['Raw error'] = trimmed;

    // Numbers go in subject position so singular and plural agree without a
    // special case, and every one of them carries its unit.
    const kind = primary ? kindFor(primary.key) : null;
    const detail = primary && kind
      ? primary.free !== null
        ? `This app asks for ${primary.requestedF} of ${kind.noun}. Of the ${primary.limitF} `
          + `${kind.budget}, ${primary.free} is free — ${primary.usedF} `
          + `${agrees(primary.usedF ?? '')} already ${kind.charge}.`
          + (kind.note ? ` ${kind.note}` : '')
        : `This app asks for ${primary.requested} of ${kind.noun}, which is more than the `
          + `${primary.limit} ${kind.budget} (${primary.used} already ${kind.charge}).`
      : 'This app needs more resources than your plan allows.';

    const nothingShort = !primary?.shortBy || primary.shortBy === '0Mi' || primary.shortBy === '0m'
      || primary.shortBy === '0';
    const ceiling = primary?.key === 'limits.cpu';
    const how = ceiling ? 'by stopping or deleting another app' : 'by stopping, deleting, or shrinking another app';
    const remediation = [
      nothingShort
        ? `Free up capacity ${how}.`
        : `Free at least ${primary?.shortBy} ${how}.`,
      ceiling
        // Shrinking will not help here: a container's ceiling comes from the
        // account's plan, not from anything on the deployment form.
        ? 'Stopping an app frees its whole ceiling, not just the CPU it was using.'
        : 'Or reduce this app’s resource request on the deployment form.',
      'Or ask your provider to raise the plan limit.',
    ];

    const title = rows.length > 1
      ? 'Plan limit reached'
      : kind?.title ?? `Not enough ${kind ? kind.noun : 'capacity'} in your plan`;

    return {
      code: 'QUOTA_EXCEEDED',
      title,
      detail,
      remediation,
      // Retrying changes nothing until something is freed — offering a Retry
      // button here would invite the tenant to click it forever.
      retryable: false,
      diagnostics,
    };
  }
}
