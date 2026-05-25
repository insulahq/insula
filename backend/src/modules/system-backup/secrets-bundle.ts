/**
 * Secrets-bundle export (DR-bundle bundle-everything redesign).
 *
 * Lists EVERY Secret in the cluster, filters out the controller-
 * managed `denied` bucket via the shared `secrets-denylist.ts`
 * predicate, tags each survivor with a `restoreTier`, and tars +
 * age-encrypts the result.
 *
 * Bundle layout (format v2):
 *   MANIFEST.txt   plain-text header (operator-readable via `tar tf`)
 *   MANIFEST.json  machine-readable record consumed by the restore
 *                  profile gating in `bootstrap.sh` /
 *                  `make secrets-restore`
 *   <ns>__<name>.yaml per Secret
 *
 * The on-disk format matches `scripts/bootstrap.sh:bundle_bootstrap_secrets`
 * and the nightly `secrets-backup-cronjob.yaml` (both rewritten in
 * the same change). Parity is asserted by
 * `scripts/integration-secrets-bundle.sh` Phase 1.
 *
 * Why subprocess `age` and not pure-JS:
 *   - Matches `make secrets-restore` (uses /usr/bin/age already)
 *   - Matches `bootstrap.sh` (also subprocess)
 *   - Smaller attack surface than a new npm dep for crypto
 *   - `age` is a tiny static Go build on Alpine via `apk add age`
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as tar from 'tar-stream';
import {
  type BundleManifest,
  type BundleEntry,
  type BundleSkipAtRestore,
} from '@k8s-hosting/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { isAutoManaged } from './secrets-denylist.js';
import { restoreTierForNamespace, findMissingCriticalSecrets } from './secrets-tiers.js';
import { readAllowlist } from './secrets-audit.js';
import {
  buildDrInputs,
  buildDrRows,
  serializeDrInputs,
  serializeDrRows,
} from './dr-sidecars.js';
import type { Database } from '../../db/index.js';

export interface BundleManifestItem {
  readonly namespace: string;
  readonly name: string;
  readonly kind: 'Secret';
}

export interface SecretsBundle {
  readonly payload: Buffer;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** Audit trail of what's in the tar. */
  readonly manifest: ReadonlyArray<BundleManifestItem>;
  readonly operatorRecipient: string;
  /** v2 machine-readable manifest. */
  readonly manifestV2: BundleManifest;
}

export type ExportSecretsBundleDeps = {
  readonly k8s: K8sClients;
  /** Override `age` binary path for tests. Defaults to PATH lookup. */
  readonly ageBinary?: string;
  /** Identify who built the bundle in MANIFEST.json. */
  readonly generator?: BundleManifest['generator'];
  /** Optional cluster hostname for forensics. */
  readonly clusterHostname?: string | null;
} & DrSidecarOpts;

interface SecretYaml {
  readonly apiVersion: string;
  readonly kind: 'Secret';
  readonly metadata: {
    readonly namespace: string;
    readonly name: string;
    readonly ownerReferences?: ReadonlyArray<{
      readonly apiVersion?: string;
      readonly kind?: string;
      readonly name?: string;
    }>;
  };
  readonly type?: string;
  readonly data?: Record<string, string>;
}

interface SecretListItem extends SecretYaml {
  readonly metadata: SecretYaml['metadata'] & { readonly creationTimestamp?: Date | string };
}

interface SecretList {
  readonly items?: ReadonlyArray<SecretListItem>;
}

/** Read the operator's age recipient (public key) from the cluster. */
export async function readOperatorRecipient(k8s: K8sClients): Promise<string> {
  const core = k8s.core as unknown as {
    readNamespacedConfigMap: (
      a: { namespace: string; name: string },
    ) => Promise<{ data?: Record<string, string> }>;
  };
  const cm = await core.readNamespacedConfigMap({
    namespace: 'platform',
    name: 'platform-operator-recipient',
  }).catch((err: unknown) => {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      throw new Error(
        'platform-operator-recipient ConfigMap missing. Run scripts/bootstrap.sh '
        + 'on a server, OR pre-create the ConfigMap with --operator-age-recipient.',
      );
    }
    throw err;
  });
  const recipient = cm.data?.recipient;
  if (!recipient || !/^age1[ac-hj-np-z02-9]{58}$/i.test(recipient)) {
    throw new Error(`platform-operator-recipient ConfigMap.data.recipient invalid: ${recipient ?? '(missing)'}`);
  }
  return recipient;
}

/**
 * List every Secret in the cluster, filter out `denied`, tar each
 * survivor with its restore-tier classification, embed MANIFEST.txt +
 * MANIFEST.json. Returns the plaintext tar bytes (caller age-encrypts).
 */
// DR sidecars: present in production callers, omitted by tests/legacy
// callers. Discriminated union ensures both-or-neither at the type
// layer — a partial provision (only one field) is a TS error, which
// would otherwise silently produce a Secrets-only bundle that Unit B
// would later refuse to import.
type DrSidecarOpts =
  | { readonly db: Database; readonly config: Parameters<typeof buildDrInputs>[0]['config'] }
  | { readonly db?: undefined; readonly config?: undefined };

export type BuildSecretsTarOpts = {
  readonly generator?: BundleManifest['generator'];
  readonly clusterHostname?: string | null;
} & DrSidecarOpts;

export async function buildSecretsTar(
  k8s: K8sClients,
  recipient: string,
  opts: BuildSecretsTarOpts = {},
): Promise<{ tarBytes: Buffer; manifest: BundleManifestItem[]; manifestV2: BundleManifest }> {
  const generator = opts.generator ?? 'in-cluster';
  const clusterHostname = opts.clusterHostname ?? null;
  const generatedAt = new Date().toISOString();

  // List + filter via shared predicate.
  const allSecrets = await listAllSecrets(k8s);
  const survivors: SecretListItem[] = [];
  for (const s of allSecrets) {
    const owner = s.metadata.ownerReferences?.[0];
    const decision = isAutoManaged({
      name: s.metadata.name,
      type: s.type ?? 'Opaque',
      owner: owner ? { kind: owner.kind, apiVersion: owner.apiVersion } : null,
    });
    if (!decision.denied) survivors.push(s);
  }

  // Snapshot the operator's skip-at-restore decisions into the bundle
  // so restore on a fresh cluster honours them without needing the
  // original ConfigMap.
  const allowlist = await readAllowlist(k8s);
  const skipAtRestore: BundleSkipAtRestore[] = allowlist.map((e) => ({
    namespace: e.namespace,
    name: e.name,
    reason: e.reason,
  }));

  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (chunk: Buffer) => chunks.push(chunk));
  const manifest: BundleManifestItem[] = [];
  const entries: BundleEntry[] = [];

  for (const sec of survivors) {
    const yaml = renderSecretYaml(sec);
    const fileName = `${sec.metadata.namespace}__${sec.metadata.name}.yaml`;
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: fileName, size: yaml.length }, yaml, (err?: Error | null) => {
        if (err) reject(err); else resolve();
      });
    });
    manifest.push({ namespace: sec.metadata.namespace, name: sec.metadata.name, kind: 'Secret' });
    entries.push({
      namespace: sec.metadata.namespace,
      name: sec.metadata.name,
      type: sec.type ?? 'Opaque',
      restoreTier: restoreTierForNamespace(sec.metadata.namespace),
      sha256OfYaml: sha256Hex(yaml),
    });
  }

  const manifestV2: BundleManifest = {
    bundleFormat: 2,
    generatedAt,
    generator,
    operatorRecipient: recipient,
    clusterHostname,
    entries: entries.sort((a, b) => {
      if (a.namespace !== b.namespace) return a.namespace.localeCompare(b.namespace);
      return a.name.localeCompare(b.name);
    }),
    skipAtRestore,
  };
  const manifestJson = Buffer.from(JSON.stringify(manifestV2, null, 2) + '\n', 'utf8');
  await new Promise<void>((resolve, reject) => {
    pack.entry({ name: 'MANIFEST.json', size: manifestJson.length }, manifestJson, (err?: Error | null) => {
      if (err) reject(err); else resolve();
    });
  });

  const txtLines: string[] = [];
  txtLines.push(`secrets bundle (v${manifestV2.bundleFormat})`);
  txtLines.push(`generator:   ${manifestV2.generator}`);
  txtLines.push(`created:     ${manifestV2.generatedAt}`);
  if (manifestV2.clusterHostname) txtLines.push(`hostname:    ${manifestV2.clusterHostname}`);
  txtLines.push(`recipient:   ${manifestV2.operatorRecipient}`);
  txtLines.push(`entries:     ${manifestV2.entries.length}`);
  txtLines.push(`  tier-1-platform: ${manifestV2.entries.filter((e) => e.restoreTier === 'tier-1-platform').length}`);
  txtLines.push(`  tier-2-tenant:   ${manifestV2.entries.filter((e) => e.restoreTier === 'tier-2-tenant').length}`);
  txtLines.push(`  unclassified:    ${manifestV2.entries.filter((e) => e.restoreTier === 'unclassified').length}`);
  txtLines.push(`skip-at-restore: ${manifestV2.skipAtRestore.length}`);
  txtLines.push('');
  txtLines.push('contents:');
  for (const e of manifestV2.entries) {
    txtLines.push(`  ${e.namespace}/${e.name}  [${e.restoreTier}]`);
  }
  const manifestTxt = Buffer.from(txtLines.join('\n') + '\n', 'utf8');
  await new Promise<void>((resolve, reject) => {
    pack.entry({ name: 'MANIFEST.txt', size: manifestTxt.length }, manifestTxt, (err?: Error | null) => {
      if (err) reject(err); else resolve();
    });
  });

  // ─── DR sidecars (A2) ──────────────────────────────────────────────
  // Only emitted when the caller supplies db + config. Tests can omit
  // these and still build a Secrets-only bundle; production routes
  // always pass them.
  //
  // Both sidecars are schema-validated inside their builders. If the
  // critical-Secret presence check fails, we throw — a bundle that
  // doesn't include the keys needed to decrypt its own dr-rows.json
  // is unrestorable and worse than no bundle.
  if (opts.db && opts.config) {
    const missing = findMissingCriticalSecrets(manifest);
    if (missing.length > 0) {
      throw new Error(
        `secrets bundle missing critical Secrets — bundle would be unrestorable: ${missing.join(', ')}. `
        + 'These Secrets are tier-1 by namespace; check that the namespace is in TIER_1_PLATFORM_NAMESPACES '
        + 'and that the denylist predicate is not filtering them out.',
      );
    }
    const drInputs = await buildDrInputs({ db: opts.db, k8s, config: opts.config });
    const drInputsBytes = serializeDrInputs(drInputs);
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: 'dr-inputs.yaml', size: drInputsBytes.length }, drInputsBytes, (err?: Error | null) => {
        if (err) reject(err); else resolve();
      });
    });
    const drRows = await buildDrRows(opts.db);
    const drRowsBytes = serializeDrRows(drRows);
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: 'dr-rows.json', size: drRowsBytes.length }, drRowsBytes, (err?: Error | null) => {
        if (err) reject(err); else resolve();
      });
    });
  }

  pack.finalize();
  await new Promise<void>((resolve) => { pack.on('end', () => resolve()); });
  return { tarBytes: Buffer.concat(chunks), manifest, manifestV2 };
}

async function listAllSecrets(k8s: K8sClients): Promise<SecretListItem[]> {
  const core = k8s.core as unknown as {
    listSecretForAllNamespaces: () => Promise<SecretList>;
  };
  const list = await core.listSecretForAllNamespaces();
  return [...(list.items ?? [])];
}

/** Serialise a Secret to apply-ready YAML, stripping server-managed fields. */
function renderSecretYaml(sec: SecretYaml): Buffer {
  const lines: string[] = [];
  lines.push('apiVersion: v1');
  lines.push('kind: Secret');
  lines.push('metadata:');
  lines.push(`  namespace: ${yamlEscape(sec.metadata.namespace)}`);
  lines.push(`  name: ${yamlEscape(sec.metadata.name)}`);
  if (sec.type) lines.push(`type: ${yamlEscape(sec.type)}`);
  if (sec.data && Object.keys(sec.data).length > 0) {
    lines.push('data:');
    for (const [k, v] of Object.entries(sec.data)) {
      lines.push(`  ${yamlEscape(k)}: ${v}`);
    }
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

function yamlEscape(s: string): string {
  if (/^[A-Za-z0-9_./\-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** Pipe tarBytes through `age -r <recipient>` and return encrypted output. */
export async function ageEncrypt(
  tarBytes: Buffer,
  recipient: string,
  ageBinary: string = 'age',
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ageBinary, ['-r', recipient], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => out.push(c));
    proc.stderr.on('data', (c: Buffer) => err.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`age exit ${code}: ${Buffer.concat(err).toString()}`));
        return;
      }
      resolve(Buffer.concat(out));
    });
    proc.stdin.end(tarBytes);
  });
}

/** Top-level: list → filter → tar with v2 MANIFEST → age. */
export async function exportSecretsBundle(deps: ExportSecretsBundleDeps): Promise<SecretsBundle> {
  const recipient = await readOperatorRecipient(deps.k8s);
  // The discriminated union on BuildSecretsTarOpts enforces both-or-
  // neither at the type layer. Build the options object explicitly
  // along the right branch.
  const tarOpts: BuildSecretsTarOpts = deps.db
    ? {
        generator: deps.generator,
        clusterHostname: deps.clusterHostname,
        db: deps.db,
        config: deps.config,
      }
    : {
        generator: deps.generator,
        clusterHostname: deps.clusterHostname,
      };
  const { tarBytes, manifest, manifestV2 } = await buildSecretsTar(deps.k8s, recipient, tarOpts);
  const encrypted = await ageEncrypt(tarBytes, recipient, deps.ageBinary);
  const sha256 = createHash('sha256').update(encrypted).digest('hex');
  return {
    payload: encrypted,
    sizeBytes: encrypted.length,
    sha256,
    manifest,
    operatorRecipient: recipient,
    manifestV2,
  };
}
