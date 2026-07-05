/**
 * `platform-ops dr` — disaster-recovery subcommands (ADR-045 / W17).
 *
 *   dr verify   --bundle <p> --age-key <p> [--age-binary <p>] [--json]
 *               Read-only: decrypt + inspect a DR bundle. No DB, no cluster.
 *   dr restore  --bundle <p> --age-key <p> --mode partial|full [--strict]
 *               [--age-binary <p>] [--kubeconfig <p>] [--target-mail-node <n>]
 *               [--confirm-cluster <name> ...] [--json]
 *               Import DR rows (partial) or full CNPG + mail recovery.
 *   dr tenant-restore --tenant <id> [--bundle <id>] [--components <csv>]
 *               [--mailbox-mode <m>] [--no-provision] [--json]
 *               One-button tenant DR recover: drive the recover route (which
 *               orchestrates provision → cart → execute) from a RUNNING
 *               platform-api pod. Unlike verify/restore/rescue, this needs the
 *               API up — it POSTs to the pod's local server (via deps.tenantRecover).
 *
 * This wraps the backend `dr-restore` primitive directly (via deps.dr) —
 * the same module `scripts/dr-restore-bundle.sh` drives today. The argv
 * surface mirrors that shim so operators carry no new muscle memory; the
 * marquee difference is this runs from a signed host binary with no
 * node/tsx and works when platform-api is down.
 *
 * Exit codes: 0 = success, 1 = runtime failure, 2 = usage error.
 */
import type {
  Deps,
  DrBundleManifest,
  DrRescueRequest,
  DrRestoreRequest,
  TenantRecoverComponent,
  TenantRecoverMailboxMode,
  TenantRecoverRequest,
} from './deps.js';
import type { EmbeddedScriptKey } from './embedded-scripts.js';
import { scrubCreds } from './redact.js';
import { drPreflight } from './dr-preflight.js';

export type ParseDrResult =
  | { ok: true; sub: 'verify'; bundlePath: string; ageKeyPath: string; ageBinary?: string }
  | { ok: true; sub: 'restore'; req: DrRestoreRequest }
  | { ok: true; sub: 'rescue'; req: DrRescueRequest }
  | { ok: true; sub: 'tenant-restore'; req: TenantRecoverRequest }
  | { ok: false; code: number; message: string };

type Fail = { ok: false; code: number; message: string };
type TakeResult = { ok: true; value: string } | Fail;
const usage = (message: string): Fail => ({ ok: false, code: 2, message });

/**
 * Walk a flag/value argv. `--strict`, `--json` and `--confirm-cluster`
 * are handled by the caller's spec; everything else with a value uses
 * `takeValue`, which refuses an end-of-argv or a following `--flag`
 * (so `--bundle --age-key` is "missing value", never a silent mis-bind).
 * Returns an explicitly-discriminated union so call sites narrow on `t.ok`.
 */
function takeValue(args: string[], i: number, flag: string): TakeResult {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    return usage(`dr: ${flag} requires a value`);
  }
  return { ok: true, value: v };
}

function parseVerify(rest: string[]): ParseDrResult {
  let bundlePath: string | undefined;
  let ageKeyPath: string | undefined;
  let ageBinary: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--bundle': case '--age-key': case '--age-binary': {
        const t = takeValue(rest, i, a);
        if (!t.ok) return t;
        if (a === '--bundle') bundlePath = t.value;
        else if (a === '--age-key') ageKeyPath = t.value;
        else ageBinary = t.value;
        i++;
        break;
      }
      case '--json':
        break; // formatting flag, consumed by the command layer
      default:
        return usage(`dr verify: unknown argument '${a}'`);
    }
  }
  if (!bundlePath) return usage('dr verify: --bundle <path> is required');
  if (!ageKeyPath) return usage('dr verify: --age-key <path> is required');
  return { ok: true, sub: 'verify', bundlePath, ageKeyPath, ageBinary };
}

function parseRestore(rest: string[]): ParseDrResult {
  let bundlePath: string | undefined;
  let ageKeyPath: string | undefined;
  let mode: string | undefined;
  let strict = false;
  let ageBinary: string | undefined;
  let targetMailNode: string | undefined;
  let kubeconfig: string | undefined;
  const confirmClusterNames = new Map<string, string>();

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--bundle': case '--age-key': case '--mode':
      case '--age-binary': case '--target-mail-node': case '--kubeconfig':
      case '--confirm-cluster': {
        const t = takeValue(rest, i, a);
        if (!t.ok) return t;
        switch (a) {
          case '--bundle': bundlePath = t.value; break;
          case '--age-key': ageKeyPath = t.value; break;
          case '--mode': mode = t.value; break;
          case '--age-binary': ageBinary = t.value; break;
          case '--target-mail-node': targetMailNode = t.value; break;
          case '--kubeconfig': kubeconfig = t.value; break;
          // Confirmation value = cluster name verbatim; map key + value are
          // the same string (the module enforces value === clusterName).
          case '--confirm-cluster': confirmClusterNames.set(t.value, t.value); break;
        }
        i++;
        break;
      }
      case '--strict':
        strict = true;
        break;
      case '--json':
        break;
      default:
        return usage(`dr restore: unknown argument '${a}'`);
    }
  }

  if (!bundlePath) return usage('dr restore: --bundle <path> is required');
  if (!ageKeyPath) return usage('dr restore: --age-key <path> is required');
  if (mode !== 'partial' && mode !== 'full') {
    return usage(`dr restore: --mode must be 'partial' or 'full' (got ${mode ?? '<missing>'})`);
  }

  const base = { bundlePath, ageKeyPath, strict, ageBinary, kubeconfig };
  if (mode === 'full') {
    // Destructive: require the mail target + a typed confirmation per cluster.
    // After these guards `targetMailNode` is narrowed to a non-empty string,
    // so the full-request shape needs no non-null assertion downstream.
    if (!targetMailNode) return usage('dr restore: --target-mail-node <name> is required for --mode full');
    if (confirmClusterNames.size === 0) {
      return usage('dr restore: --mode full requires at least one --confirm-cluster <name> (one per CNPG cluster in the bundle)');
    }
    return { ok: true, sub: 'restore', req: { ...base, mode: 'full', targetMailNode, confirmClusterNames } };
  }
  return { ok: true, sub: 'restore', req: { ...base, mode: 'partial' } };
}

/**
 * `dr rescue` — block-level Longhorn safety snapshots before a destructive
 * recovery. No required args: a bare `dr rescue` snapshots every system PVC.
 * `--volume` narrows to one Longhorn volume; `--label` stamps the snapshots.
 */
function parseRescue(rest: string[]): ParseDrResult {
  let kubeconfig: string | undefined;
  let label: string | undefined;
  let volume: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--kubeconfig': case '--label': case '--volume': {
        const t = takeValue(rest, i, a);
        if (!t.ok) return t;
        if (a === '--kubeconfig') kubeconfig = t.value;
        else if (a === '--label') label = t.value;
        else volume = t.value;
        i++;
        break;
      }
      case '--json':
        break;
      default:
        return usage(`dr rescue: unknown argument '${a}'`);
    }
  }
  return { ok: true, sub: 'rescue', req: { kubeconfig, label, volume } };
}

/** Components a tenant recover can pull (kept in sync with the api-contract enum). */
const TENANT_RECOVER_COMPONENTS: readonly TenantRecoverComponent[] = ['files', 'mailboxes', 'config'];
/** Mailbox merge strategies the recover route accepts. */
const TENANT_RECOVER_MAILBOX_MODES: readonly TenantRecoverMailboxMode[] = [
  'merge-skip-duplicates', 'merge-overwrite', 'replace',
];

const isTenantRecoverComponent = (c: string): c is TenantRecoverComponent =>
  (TENANT_RECOVER_COMPONENTS as readonly string[]).includes(c);
const isTenantRecoverMailboxMode = (m: string): m is TenantRecoverMailboxMode =>
  (TENANT_RECOVER_MAILBOX_MODES as readonly string[]).includes(m);

/**
 * `dr tenant-restore` — one-button tenant DR recover. `--tenant <id>` is
 * required; `--components` is a comma-separated subset of files|mailboxes|config
 * (each validated), `--no-provision` sets `provision:false`, and `--mailbox-mode`
 * is validated against the three merge strategies. Unknown flags / bad values
 * are usage errors (exit 2) so nothing reaches the running API on a typo.
 */
function parseTenantRestore(rest: string[]): ParseDrResult {
  let tenantId: string | undefined;
  let bundleId: string | undefined;
  let components: TenantRecoverComponent[] | undefined;
  let mailboxMode: TenantRecoverMailboxMode | undefined;
  let provision: boolean | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--tenant': case '--bundle': case '--components': case '--mailbox-mode': {
        const t = takeValue(rest, i, a);
        if (!t.ok) return t;
        switch (a) {
          case '--tenant': tenantId = t.value; break;
          case '--bundle': bundleId = t.value; break;
          case '--components': {
            const parts = t.value.split(',').map((s) => s.trim()).filter(Boolean);
            if (parts.length === 0) {
              return usage('dr tenant-restore: --components must be a comma-separated list of files|mailboxes|config');
            }
            const validated: TenantRecoverComponent[] = [];
            for (const p of parts) {
              if (!isTenantRecoverComponent(p)) {
                return usage(`dr tenant-restore: unknown component '${p}' (expected files|mailboxes|config)`);
              }
              validated.push(p);
            }
            components = validated;
            break;
          }
          case '--mailbox-mode': {
            if (!isTenantRecoverMailboxMode(t.value)) {
              return usage(`dr tenant-restore: --mailbox-mode must be one of ${TENANT_RECOVER_MAILBOX_MODES.join('|')} (got ${t.value})`);
            }
            mailboxMode = t.value;
            break;
          }
        }
        i++;
        break;
      }
      case '--no-provision':
        provision = false;
        break;
      case '--json':
        break; // formatting flag, consumed by the command layer
      default:
        return usage(`dr tenant-restore: unknown argument '${a}'`);
    }
  }
  if (!tenantId) return usage('dr tenant-restore: --tenant <id> is required');
  const req: TenantRecoverRequest = { tenantId, bundleId, components, mailboxMode, provision };
  return { ok: true, sub: 'tenant-restore', req };
}

export function parseDrArgs(args: string[]): ParseDrResult {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'verify': return parseVerify(rest);
    case 'restore': return parseRestore(rest);
    case 'rescue': return parseRescue(rest);
    case 'tenant-restore': return parseTenantRestore(rest);
    case undefined:
      return usage('dr: expected a subcommand (verify | restore | rescue | tenant-restore)');
    default:
      return usage(`dr: unknown subcommand '${sub}' (expected verify | restore | rescue | tenant-restore)`);
  }
}

/**
 * Bundle errors set `.name` to the class name; map to the runner taxonomy.
 * `verify` maps by name (it catches a thrown error post-bundle-read and the
 * error-class refs live in the backend module); `runRestore` maps by
 * `instanceof` in dr-ops.ts. Both fall back to UNEXPECTED, never throw.
 */
function labelFromErrorName(name: string | undefined): string {
  switch (name) {
    case 'BundleDecryptError': return 'DECRYPT_ERROR';
    case 'LegacyBundleError': return 'LEGACY_BUNDLE';
    case 'BundleVersionError': return 'UNKNOWN_VERSION';
    default: return 'UNEXPECTED';
  }
}

function printManifest(m: DrBundleManifest, deps: Deps): void {
  deps.out(`Bundle for ${m.apexDomain} (cluster '${m.clusterName}', topology ${m.bundleTopology})`);
  deps.out(`  platform version: ${m.platformVersion}`);
  deps.out(`  created:          ${m.createdAt}`);
  deps.out(`  secret YAMLs:     ${m.secretYamlCount}`);
  deps.out(`  CNPG clusters:    ${m.cnpgClusters.length}`);
  for (const c of m.cnpgClusters) {
    deps.out(`    - ${c.namespace}/${c.clusterName} (server ${c.serverName}, store ${c.objectStoreName})`);
  }
}

async function verifyCommand(parsed: Extract<ParseDrResult, { sub: 'verify' }>, json: boolean, deps: Deps): Promise<number> {
  try {
    const m = await deps.dr.verifyBundle(parsed.bundlePath, parsed.ageKeyPath, parsed.ageBinary);
    if (json) deps.out(JSON.stringify(m));
    else printManifest(m, deps);
    return 0;
  } catch (err) {
    const label = labelFromErrorName(err instanceof Error ? err.name : undefined);
    if (json) {
      // Label only — the error body can carry the age key path / recipient
      // fingerprint (security review M-S2). The detail goes to stderr.
      deps.out(JSON.stringify({ ok: false, errorCode: label }));
    }
    // Stderr is the operator's terminal; still scrub any DSN credentials that
    // a module-init error might carry, consistent with the runRestore path.
    deps.err(`dr verify: ${label} — ${scrubCreds(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}

async function restoreCommand(parsed: Extract<ParseDrResult, { sub: 'restore' }>, json: boolean, deps: Deps): Promise<number> {
  const outcome = await deps.dr.runRestore(parsed.req);
  if (!outcome.ok) {
    if (json) deps.out(JSON.stringify({ ok: false, errorCode: outcome.errorCode ?? 'UNEXPECTED' }));
    deps.err(`dr restore: ${outcome.errorCode ?? 'UNEXPECTED'}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
    return 1;
  }
  if (json) {
    deps.out(JSON.stringify({ ok: true, bundleInfo: outcome.bundleInfo, summary: outcome.summary, driftNotes: outcome.driftNotes }));
  } else {
    if (outcome.bundleInfo) printManifest(outcome.bundleInfo, deps);
    for (const line of outcome.summary ?? []) deps.out(line);
  }
  // Drift is non-fatal (unless --strict made the import throw) — always warn.
  if (outcome.driftNotes?.length) {
    deps.err('dr restore: WARN drift detected between bundle and live cluster:');
    for (const note of outcome.driftNotes) deps.err(`  - ${note}`);
  }
  return 0;
}

async function rescueCommand(req: DrRescueRequest, json: boolean, deps: Deps): Promise<number> {
  const outcome = await deps.dr.rescue(req);
  if (!outcome.ok) {
    // Label only in JSON — detail (scrubbed by the seam) goes to stderr.
    if (json) deps.out(JSON.stringify({ ok: false, errorCode: outcome.errorCode ?? 'UNEXPECTED' }));
    deps.err(`dr rescue: ${outcome.errorCode ?? 'UNEXPECTED'}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
    return 1;
  }
  const snapshots = outcome.snapshots ?? [];
  const failures = outcome.failures ?? [];
  if (json) {
    deps.out(JSON.stringify({ ok: true, snapshots, failures: failures.length ? failures : undefined }));
  } else if (snapshots.length === 0 && failures.length === 0) {
    deps.out('No system volumes found to snapshot.');
  } else {
    deps.out(`Rescued ${snapshots.length} system volume(s):`);
    for (const s of snapshots) {
      deps.out(`  ${s.namespace}/${s.pvcName} (${s.volumeName}) → ${s.snapshotName}`);
    }
  }
  // Per-volume failures are non-fatal but surface as warnings + a non-zero
  // exit so an operator scripting `dr rescue` notices a partial result.
  if (failures.length) {
    deps.err(`dr rescue: WARN ${failures.length} volume(s) could not be snapshotted:`);
    for (const f of failures) deps.err(`  - ${f.volumeName}: ${f.reason}`);
    return 1;
  }
  return 0;
}

/**
 * `dr tenant-restore` — call the recover seam and render its outcome. On success
 * the seam returns the route's response `data` (cartId, bundleId, components,
 * provisioned, status); print a human summary or, with --json, the raw result.
 * Failure → errorCode (label-only in --json; detail to stderr) + exit 1.
 */
async function tenantRestoreCommand(req: TenantRecoverRequest, json: boolean, deps: Deps): Promise<number> {
  const outcome = await deps.tenantRecover(req);
  if (!outcome.ok) {
    // Label only in JSON — detail (scrubbed by the seam) goes to stderr.
    if (json) deps.out(JSON.stringify({ ok: false, errorCode: outcome.errorCode ?? 'UNEXPECTED' }));
    deps.err(`dr tenant-restore: ${outcome.errorCode ?? 'UNEXPECTED'}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
    return 1;
  }
  if (json) {
    deps.out(JSON.stringify({ ok: true, result: outcome.json }));
    return 0;
  }
  const data = (outcome.json ?? {}) as {
    cartId?: string;
    bundleId?: string;
    status?: string;
    components?: readonly string[];
    provisioned?: boolean;
  };
  deps.out(`Tenant DR recover accepted for tenant ${req.tenantId}.`);
  if (data.bundleId) deps.out(`  bundle:       ${data.bundleId}`);
  if (data.cartId) deps.out(`  restore cart: ${data.cartId}`);
  if (data.components?.length) deps.out(`  components:   ${data.components.join(', ')}`);
  if (data.provisioned !== undefined) deps.out(`  provisioned:  ${data.provisioned ? 'yes' : 'no'}`);
  if (data.status) deps.out(`  status:       ${data.status}`);
  return 0;
}

// Node-level component restores from the backup-rclone-shim. The proven bash
// (scripts/restore-*-from-shim.sh) is embedded as a SEA asset and launched
// verbatim — ONE source of truth, no TS re-port of complex/destructive CNPG/k3s
// logic. The standalone scripts stay as break-glass. Args pass straight through.
const DR_COMPONENT_ASSETS = {
  etcd: 'dr/restore-etcd-from-shim.sh',
  mail: 'dr/restore-mail-from-shim.sh',
  postgres: 'dr/restore-postgres-from-shim.sh',
} satisfies Record<string, EmbeddedScriptKey>;
type DrComponent = keyof typeof DR_COMPONENT_ASSETS;
const isDrComponent = (c: string): c is DrComponent => c in DR_COMPONENT_ASSETS;

async function drRestoreComponent(args: string[], deps: Deps): Promise<number> {
  const [component, ...rest] = args;
  if (!component || !isDrComponent(component)) {
    deps.err(`dr restore-component: expected one of etcd|mail|postgres, got ${component ? `'${component}'` : 'none'}`);
    deps.err('  e.g. platform-ops dr restore-component etcd --local         (Tier 0: local k3s snapshot, no network)');
    deps.err('       platform-ops dr restore-component etcd --offline --bundle <p> --age-key <k> --latest');
    deps.err('       platform-ops dr restore-component postgres --latest');
    return 2;
  }
  // etcd has three tiers selected by a leading flag, all sharing one
  // passthrough surface. `--local` reads the on-node k3s snapshot dir
  // (no network/kubectl); `--offline` reads the off-site target direct
  // from a bundle descriptor (no kubectl); bare uses the kubectl→shim
  // path. The flag is consumed here so the chosen script never sees it.
  if (component === 'etcd' && rest.includes('--local')) {
    return deps.runEmbeddedScript('dr/restore-etcd-local.sh', rest.filter((a) => a !== '--local'));
  }
  return deps.runEmbeddedScript(DR_COMPONENT_ASSETS[component], rest);
}

export async function drCommand(args: string[], deps: Deps): Promise<number> {
  // restore-component passes its args straight through to the embedded bash, so
  // it bypasses the structured DR (verify/restore/rescue) arg parser.
  if (args[0] === 'restore-component') return drRestoreComponent(args.slice(1), deps);
  // preflight is an in-binary readiness check (kubectl + host probes).
  if (args[0] === 'preflight') return drPreflight(args.slice(1), deps);
  const parsed = parseDrArgs(args);
  if (!parsed.ok) {
    deps.err(parsed.message);
    return parsed.code;
  }
  const json = args.includes('--json');
  if (parsed.sub === 'verify') return verifyCommand(parsed, json, deps);
  if (parsed.sub === 'restore') return restoreCommand(parsed, json, deps);
  if (parsed.sub === 'tenant-restore') return tenantRestoreCommand(parsed.req, json, deps);
  return rescueCommand(parsed.req, json, deps);
}
