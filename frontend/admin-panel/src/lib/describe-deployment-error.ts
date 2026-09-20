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

/** Kubernetes quota keys → what a tenant calls them. */
const RESOURCE_LABELS: Record<string, string> = {
  'limits.cpu': 'CPU',
  'requests.cpu': 'CPU',
  'limits.memory': 'Memory',
  'requests.memory': 'Memory',
  'requests.storage': 'Storage',
  'count/pods': 'Pods',
  'count/services': 'Services',
  persistentvolumeclaims: 'Volumes',
};

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
  return cores < 1 ? `${Math.round(cores * 1000)}m` : `${Number(cores.toFixed(3))} cores`;
}

interface QuotaResource {
  readonly key: string;
  readonly label: string;
  readonly requested: string;
  readonly used: string;
  readonly limit: string;
  /** Headroom and shortfall, when the quantities parse. */
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
    const label = RESOURCE_LABELS[key] ?? key;
    if (seen.has(label)) continue;
    seen.add(label);

    const req = requested[key];
    const use = used[key] ?? '';
    const lim = limited[key] ?? '';

    let free: string | null = null;
    let shortBy: string | null = null;
    const isCpu = key.endsWith('cpu');
    const parse = isCpu ? toCores : toMiB;
    const format = isCpu ? formatCores : formatMiB;
    const pReq = parse(req);
    const pUse = parse(use);
    const pLim = parse(lim);
    if (pReq !== null && pUse !== null && pLim !== null) {
      free = format(Math.max(0, pLim - pUse));
      shortBy = format(Math.max(0, pReq - (pLim - pUse)));
    }

    rows.push({ key, label, requested: req, used: use, limit: lim, free, shortBy });
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
  const { message, fields } = unwrapK8sStatus(trimmed);

  if (message.includes('exceeded quota')) {
    const rows = parseQuotaResources(message);
    const primary = rows[0];

    const diagnostics: Record<string, unknown> = {};
    for (const r of rows) {
      diagnostics[`${r.label} requested`] = r.requested;
      diagnostics[`${r.label} already in use`] = r.used;
      diagnostics[`${r.label} plan limit`] = r.limit;
      if (r.free !== null) diagnostics[`${r.label} free`] = r.free;
      if (r.shortBy !== null) diagnostics[`${r.label} short by`] = r.shortBy;
    }
    Object.assign(diagnostics, fields);
    diagnostics['Raw error'] = trimmed;

    // "already in use" is the honest phrase: the number includes reservations
    // the tenant cannot see on this page (an init container is charged for the
    // life of its pod), so "your other apps use X" would be a claim we cannot
    // stand behind.
    const detail = primary
      ? primary.free !== null
        ? `This app asks for ${primary.requested} of ${primary.label.toLowerCase()}, but only ${primary.free} of your ${primary.limit} plan is free — ${primary.used} is already in use.`
        : `This app asks for ${primary.requested} of ${primary.label.toLowerCase()}, which is more than your ${primary.limit} plan allows (${primary.used} already in use).`
      : 'This app needs more resources than your plan allows.';

    const remediation = [
      primary?.shortBy && primary.shortBy !== '0Mi' && primary.shortBy !== '0m'
        ? `Free at least ${primary.shortBy} by stopping, deleting, or shrinking another app.`
        : 'Free up resources by stopping, deleting, or shrinking another app.',
      'Or reduce this app’s resource request on the deployment form.',
      'Or ask your provider to raise the plan limit.',
    ];

    const title = rows.length > 1
      ? 'Plan limit reached'
      : `Not enough ${primary ? primary.label.toLowerCase() : 'capacity'} in your plan`;

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

  return {
    code: 'DEPLOYMENT_FAILED',
    title: 'Deployment failed',
    detail: message,
    remediation: ['Retry the deployment.', 'If it keeps failing, send the details below to your provider.'],
    retryable: true,
    diagnostics: { ...fields, 'Raw error': trimmed },
  };
}
