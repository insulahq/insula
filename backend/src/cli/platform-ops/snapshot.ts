/**
 * `platform-ops snapshot` — CNPG backup subcommands (ADR-045 / W17).
 *
 *   snapshot capture [--cluster <name>] [--namespace <ns>]
 *                    [--description <text>] [--kubeconfig <p>] [--json]
 *                    On-demand CNPG base backup (creates a Backup CR; the
 *                    barman upload runs asynchronously in the control plane).
 *   snapshot list    [--namespace <ns>] [--object-store <name>]
 *                    [--kubeconfig <p>] [--json]
 *                    List object-store backups by reading the store directly
 *                    via the backup-rclone-shim — works EVEN WHEN THE CNPG
 *                    OPERATOR IS DOWN (the shim owns the upstream connection).
 *                    NOTE: the catalogue reaches the shim over its
 *                    cluster-internal Service DNS, so `list` needs the cluster
 *                    pod network — it returns CATALOGUE_UNAVAILABLE from a bare
 *                    host (use it in-cluster; capture + dr rescue are host-native
 *                    via the k8s API). Always degrades gracefully, never crashes.
 *
 * Defaults target the platform system DB (platform-system/system-db, object
 * store system-db-store) — the 90% case is "snapshot the platform DB before
 * an upgrade". Both wrap backend modules directly (no platform-api), so they
 * work from a signed host binary when the API is degraded.
 *
 * Exit codes: 0 = success, 1 = runtime failure, 2 = usage error.
 */
import type { Deps, SnapshotBackupInfo, SnapshotCaptureRequest, SnapshotListRequest } from './deps.js';

// Canonical platform system DB identity (matches the live cluster + backend:
// cnpg-backup-health WATCHED_NAMESPACES=['platform'], the `system-db` CNPG
// Cluster, and the `system-postgres-objectstore` ObjectStore in
// k8s/base/database.yaml). The 90% case is "snapshot the platform DB before
// an upgrade"; operators override per-flag for tenant clusters.
const SYSTEM_NAMESPACE = 'platform';
const SYSTEM_CLUSTER = 'system-db';
const SYSTEM_OBJECT_STORE = 'system-postgres-objectstore';
/** Backup CR descriptions are a free-form annotation; cap the CLI input so a
 *  multi-kilobyte value can't be stamped onto a cluster object by accident. */
const MAX_DESCRIPTION_LEN = 256;

/**
 * Strip control / non-printable bytes from a CLUSTER-SOURCED string before
 * echoing it to the operator terminal. The Backup CR `description` is a
 * free-form annotation any admin can set; a crafted value could otherwise
 * smuggle ANSI escape sequences into the operator's terminal. JSON output
 * deliberately keeps the raw value (machines, not terminals, consume it).
 */
function safeTerm(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, '?');
}

export type ParseSnapshotResult =
  | { ok: true; sub: 'capture'; req: SnapshotCaptureRequest }
  | { ok: true; sub: 'list'; req: SnapshotListRequest }
  | { ok: false; code: number; message: string };

type Fail = { ok: false; code: number; message: string };
type TakeResult = { ok: true; value: string } | Fail;
const usage = (message: string): Fail => ({ ok: false, code: 2, message });

/**
 * Walk a flag/value argv — refuses an end-of-argv or a following `--flag`
 * as a value (so `--cluster --namespace` is "missing value", never a silent
 * mis-bind). Mirrors the helper in dr.ts.
 */
function takeValue(args: string[], i: number, flag: string): TakeResult {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    return usage(`snapshot: ${flag} requires a value`);
  }
  return { ok: true, value: v };
}

function parseCapture(rest: string[]): ParseSnapshotResult {
  let namespace = SYSTEM_NAMESPACE;
  let clusterName = SYSTEM_CLUSTER;
  let description: string | undefined;
  let kubeconfig: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--cluster': case '--namespace': case '--description': case '--kubeconfig': {
        const t = takeValue(rest, i, a);
        if (!t.ok) return t;
        if (a === '--cluster') clusterName = t.value;
        else if (a === '--namespace') namespace = t.value;
        else if (a === '--description') description = t.value;
        else kubeconfig = t.value;
        i++;
        break;
      }
      case '--json':
        break; // formatting flag, consumed by the command layer
      default:
        return usage(`snapshot capture: unknown argument '${a}'`);
    }
  }
  if (description !== undefined && description.length > MAX_DESCRIPTION_LEN) {
    return usage(`snapshot capture: --description must be ≤${MAX_DESCRIPTION_LEN} characters (got ${description.length})`);
  }
  return { ok: true, sub: 'capture', req: { namespace, clusterName, description, kubeconfig } };
}

function parseList(rest: string[]): ParseSnapshotResult {
  let namespace = SYSTEM_NAMESPACE;
  let objectStoreName = SYSTEM_OBJECT_STORE;
  let kubeconfig: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--namespace': case '--object-store': case '--kubeconfig': {
        const t = takeValue(rest, i, a);
        if (!t.ok) return t;
        if (a === '--namespace') namespace = t.value;
        else if (a === '--object-store') objectStoreName = t.value;
        else kubeconfig = t.value;
        i++;
        break;
      }
      case '--json':
        break;
      default:
        return usage(`snapshot list: unknown argument '${a}'`);
    }
  }
  return { ok: true, sub: 'list', req: { namespace, objectStoreName, kubeconfig } };
}

export function parseSnapshotArgs(args: string[]): ParseSnapshotResult {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'capture': return parseCapture(rest);
    case 'list': return parseList(rest);
    case undefined:
      return usage('snapshot: expected a subcommand (capture | list)');
    default:
      return usage(`snapshot: unknown subcommand '${sub}' (expected capture | list)`);
  }
}

/** Compact human byte size. `null` (unparseable) renders as `?`. */
function fmtBytes(n: number | null): string {
  if (n === null) return '?';
  if (n < 1024) return `${n}B`;
  const kib = n / 1024;
  if (kib < 1024) return `${kib.toFixed(0)}KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)}MiB`;
  return `${(mib / 1024).toFixed(2)}GiB`;
}

function printBackup(b: SnapshotBackupInfo, deps: Deps): void {
  // backupId / status / description are read back from the object store +
  // cluster — sanitise before echoing to the terminal (see safeTerm).
  const parts = [safeTerm(b.backupId), safeTerm(b.status ?? '?'), fmtBytes(b.dataSizeBytes), b.startedAt ?? '?'];
  if (b.kind) parts.push(`[${safeTerm(b.kind)}]`);
  if (b.description) parts.push(`"${safeTerm(b.description)}"`);
  deps.out(`  ${parts.join('  ')}`);
}

async function captureCommand(req: SnapshotCaptureRequest, json: boolean, deps: Deps): Promise<number> {
  const outcome = await deps.snapshot.capture(req);
  if (!outcome.ok) {
    // Label only in JSON — the detail (scrubbed by the seam) goes to stderr.
    if (json) deps.out(JSON.stringify({ ok: false, errorCode: outcome.errorCode ?? 'UNEXPECTED' }));
    deps.err(`snapshot capture: ${outcome.errorCode ?? 'UNEXPECTED'}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
    return 1;
  }
  if (json) {
    deps.out(JSON.stringify({ ok: true, backup: outcome.backup }));
  } else if (outcome.backup) {
    const b = outcome.backup;
    deps.out(`Backup CR '${b.backupName}' created for ${b.namespace}/${b.clusterName} (${b.createdAt}).`);
    deps.out('The upload runs asynchronously — track it with `platform-ops snapshot list`.');
  }
  return 0;
}

async function listCommand(req: SnapshotListRequest, json: boolean, deps: Deps): Promise<number> {
  const outcome = await deps.snapshot.list(req);
  if (!outcome.ok) {
    if (json) deps.out(JSON.stringify({ ok: false, errorCode: outcome.errorCode ?? 'UNEXPECTED' }));
    deps.err(`snapshot list: ${outcome.errorCode ?? 'UNEXPECTED'}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
    return 1;
  }
  const backups = outcome.backups ?? [];
  const ns = outcome.namespace ?? req.namespace;
  const store = outcome.objectStoreName ?? req.objectStoreName;
  if (json) {
    deps.out(JSON.stringify({ ok: true, objectStoreName: store, namespace: ns, backups }));
    return 0;
  }
  if (backups.length === 0) {
    deps.out(`No backups found in object store ${ns}/${store}.`);
    return 0;
  }
  deps.out(`${backups.length} backup(s) in ${ns}/${store}:`);
  for (const b of backups) printBackup(b, deps);
  return 0;
}

export async function snapshotCommand(args: string[], deps: Deps): Promise<number> {
  const parsed = parseSnapshotArgs(args);
  if (!parsed.ok) {
    deps.err(parsed.message);
    return parsed.code;
  }
  const json = args.includes('--json');
  if (parsed.sub === 'capture') return captureCommand(parsed.req, json, deps);
  return listCommand(parsed.req, json, deps);
}
