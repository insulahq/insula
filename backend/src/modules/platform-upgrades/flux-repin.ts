/**
 * Flux source re-pin (ADR-045 W13) — move the cluster's deployed revision by
 * PATCHing a Flux `GitRepository.spec.ref` to a release tag.
 *
 * Proven by the PR-18 spike (decision #14): a single merge-patch of `spec.ref`
 * is honoured by Flux's source-controller and is reversible. The re-pin is
 * ATOMIC (one API call) so it is safe to issue from either the backend pod or
 * host-side `platform-ops` — neither needs to do anything after the patch; Flux
 * then reconciles every Deployment (incl. platform-api itself) to the new tag.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

const FLUX_SRC_GROUP = 'source.toolkit.fluxcd.io';
const FLUX_SRC_VERSION = 'v1';
const FLUX_SRC_PLURAL = 'gitrepositories';
export const FLUX_NAMESPACE = 'flux-system';

export interface GitRepoRef {
  readonly branch?: string;
  readonly tag?: string;
  readonly commit?: string;
}

/**
 * Map a clean release version (CalVer, no leading v) to its git tag `vX.Y.Z`.
 * Validated with the SAME strict tag regex the patch path uses — a prerelease /
 * dev pin (`-<sha>`, `-rc.1`) or anything non-`X.Y.Z` is refused outright (not
 * just by composing isValidVersion, which accepts prereleases).
 */
export function gitTagForVersion(version: string): string | null {
  const v = version.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) return null;
  return `v${v}`;
}

const FLUX_KS_GROUP = 'kustomize.toolkit.fluxcd.io';
const FLUX_KS_PLURAL = 'kustomizations';

/**
 * Resolve WHICH GitRepository the platform's Flux Kustomization tracks — so the
 * re-pin targets the right source regardless of its name (production vs staging).
 * Reads `Kustomization/<ksName>.spec.sourceRef.name`; null if absent or not a
 * GitRepository source.
 */
export async function resolveUpgradeGitRepository(
  k8s: K8sClients,
  ksName = process.env.PLATFORM_FLUX_KS_NAME || 'platform',
  namespace = FLUX_NAMESPACE,
): Promise<string | null> {
  // Refuse a nonsensical Kustomization name (e.g. a spoofed env) before querying.
  if (!/^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/.test(ksName)) return null;
  try {
    const obj = (await k8s.custom.getNamespacedCustomObject({
      group: FLUX_KS_GROUP,
      version: FLUX_SRC_VERSION,
      namespace,
      plural: FLUX_KS_PLURAL,
      name: ksName,
    } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0])) as {
      spec?: { sourceRef?: { kind?: string; name?: string } };
    };
    const ref = obj.spec?.sourceRef;
    if (!ref || (ref.kind && ref.kind !== 'GitRepository') || !ref.name) return null;
    return ref.name;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number }).statusCode ?? (err as { code?: number }).code;
    if (code === 404) return null;
    throw err;
  }
}

export async function readGitRepositoryRef(
  k8s: K8sClients,
  name: string,
  namespace = FLUX_NAMESPACE,
): Promise<GitRepoRef | null> {
  try {
    const obj = (await k8s.custom.getNamespacedCustomObject({
      group: FLUX_SRC_GROUP,
      version: FLUX_SRC_VERSION,
      namespace,
      plural: FLUX_SRC_PLURAL,
      name,
    } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0])) as { spec?: { ref?: GitRepoRef } };
    return obj.spec?.ref ?? {};
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number }).statusCode ?? (err as { code?: number }).code;
    if (code === 404) return null;
    throw err;
  }
}

export interface RepinResult {
  readonly ok: boolean;
  readonly name: string;
  readonly previousRef: GitRepoRef | null;
  readonly tag: string;
  readonly reason?: string;
}

/** A single git-ref component (tag/branch/commit) must be the git-ref charset. */
function refValueValid(v: string): boolean {
  return /^[A-Za-z0-9._/+-]{1,250}$/.test(v);
}

/** A GitRepository name must be a DNS-1123 label (defends against a poisoned manifest). */
function k8sNameValid(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/.test(name);
}

/**
 * Re-pin a GitRepository's `spec.ref` to an arbitrary recorded ref (tag OR
 * branch OR commit) — the ROLLBACK counterpart to repinGitRepositoryTag, which
 * only writes a tag. Used to restore the exact pre-upgrade ref (which on
 * dev/staging is a branch, on production a tag). Validates exactly one component
 * with the git-ref charset; clears the others. Never throws.
 */
export async function repinGitRepositoryRef(
  k8s: K8sClients,
  name: string,
  ref: GitRepoRef,
  namespace = FLUX_NAMESPACE,
): Promise<RepinResult> {
  if (!k8sNameValid(name)) {
    return { ok: false, name, previousRef: null, tag: '', reason: `refusing malformed GitRepository name ${JSON.stringify(name)}` };
  }
  const tag = ref.tag, branch = ref.branch, commit = ref.commit;
  const present = [tag, branch, commit].filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (present.length !== 1) {
    return { ok: false, name, previousRef: null, tag: '', reason: `refusing to restore an ambiguous/empty ref ${JSON.stringify(ref)}` };
  }
  if (!refValueValid(present[0])) {
    return { ok: false, name, previousRef: null, tag: present[0], reason: `refusing malformed ref value ${JSON.stringify(present[0])}` };
  }
  const previousRef = await readGitRepositoryRef(k8s, name, namespace);
  if (previousRef === null) {
    return { ok: false, name, previousRef: null, tag: present[0], reason: `GitRepository ${namespace}/${name} not found` };
  }
  await (k8s.custom as unknown as {
    patchNamespacedCustomObject: (
      a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
      mw: typeof MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedCustomObject(
    {
      group: FLUX_SRC_GROUP, version: FLUX_SRC_VERSION, namespace, plural: FLUX_SRC_PLURAL, name,
      body: { spec: { ref: { tag: tag ?? null, branch: branch ?? null, commit: commit ?? null } } },
    },
    MERGE_PATCH,
  );
  return { ok: true, name, previousRef, tag: present[0] };
}

/**
 * Re-pin a GitRepository's `spec.ref` to `tag`, clearing any `branch`/`commit`
 * (so a branch-tracking source switches cleanly to the tag). The tag is
 * re-validated here as the second gate. Returns ok:false (never throws) when the
 * source is absent or the tag is malformed.
 */
export async function repinGitRepositoryTag(
  k8s: K8sClients,
  name: string,
  tag: string,
  namespace = FLUX_NAMESPACE,
): Promise<RepinResult> {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    return { ok: false, name, previousRef: null, tag, reason: `refusing malformed tag ${JSON.stringify(tag)}` };
  }
  const previousRef = await readGitRepositoryRef(k8s, name, namespace);
  if (previousRef === null) {
    return { ok: false, name, previousRef: null, tag, reason: `GitRepository ${namespace}/${name} not found` };
  }
  await (k8s.custom as unknown as {
    patchNamespacedCustomObject: (
      a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
      mw: typeof MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedCustomObject(
    {
      group: FLUX_SRC_GROUP,
      version: FLUX_SRC_VERSION,
      namespace,
      plural: FLUX_SRC_PLURAL,
      name,
      body: { spec: { ref: { tag, branch: null, commit: null } } },
    },
    MERGE_PATCH,
  );
  return { ok: true, name, previousRef, tag };
}
