/**
 * Guard: no server holds two replicas of one platform workload.
 *
 * Every Deployment / StatefulSet the platform ships that can run more than one
 * replica must carry a HARD per-node rule — topology spread DoNotSchedule on
 * the hostname, or required pod anti-affinity on it. A soft rule (preferred,
 * ScheduleAnyway) let CrowdSec, tenant-errors and the Longhorn global manager
 * all start on the first server back after a full-cluster restart and stay
 * there; preferred CNPG anti-affinity put two platform-database instances on
 * one production server. The rebalance (rebalance.ts) only moves replicas of
 * workloads with a hard rule, and only in its namespace list — so a workload
 * missing from either is one that can stay doubled up for good.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { LEADER_ELECT_DEPLOYMENTS, STATELESS_DEPLOYMENTS } from '../platform-storage-policy/service.js';
import { LAPI_REPLICAS_POSTGRES } from '../crowdsec-db/reconciler.js';
import { REBALANCE_NAMESPACES } from './rebalance.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
// base holds the workloads; overlays and components can raise a replica
// count or add the rule, so they are read as patches of the same workload.
const roots = ['k8s/base', 'k8s/overlays', 'k8s/components'].map((d) => join(repoRoot, d));

interface Selector {
  readonly matchLabels?: Record<string, string>;
}

interface Workload {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly metadata?: { readonly name?: string; readonly namespace?: string };
  readonly spec?: {
    readonly replicas?: number;
    readonly instances?: number;
    readonly affinity?: { readonly podAntiAffinityType?: string; readonly topologyKey?: string };
    readonly selector?: Selector;
    readonly template?: {
      readonly metadata?: { readonly labels?: Record<string, string> };
      readonly spec?: {
        readonly topologySpreadConstraints?: ReadonlyArray<{ topologyKey?: string; whenUnsatisfiable?: string; maxSkew?: number; labelSelector?: Selector }>;
        readonly affinity?: { readonly podAntiAffinity?: { readonly requiredDuringSchedulingIgnoredDuringExecution?: ReadonlyArray<{ topologyKey?: string; labelSelector?: Selector }> } };
      };
    };
  };
}

function yamlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return yamlFiles(p);
    return /\.ya?ml$/.test(f) ? [p] : [];
  });
}

const unparsed: string[] = [];

function docs(): Array<{ file: string; doc: Workload }> {
  return roots.flatMap(yamlFiles).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    let all: unknown[];
    try {
      all = yaml.loadAll(text);
    } catch {
      // Not plain YAML (an envsubst template). Fine — unless it declares a
      // workload this guard would then never see.
      if (/^kind:\s*(Deployment|StatefulSet|Cluster)\s*$/m.test(text)) unparsed.push(relative(repoRoot, file));
      return [];
    }
    return all
      .filter((d): d is Workload => typeof d === 'object' && d !== null)
      .map((doc) => ({ file: relative(repoRoot, file), doc }));
  });
}

// Workloads whose replica count a reconciler owns (absent from the manifest),
// and can exceed one.
const SCALED = new Set([
  ...STATELESS_DEPLOYMENTS.map((d) => `${d.namespace}/${d.name}`),
  ...LEADER_ELECT_DEPLOYMENTS.map((d) => `${d.namespace}/${d.name}`),
  ...(LAPI_REPLICAS_POSTGRES > 1 ? ['crowdsec/crowdsec'] : []),
  'redis-system/valkey',
]);

// The rule must count the workload's own replicas: its selector's labels are
// on the pod template (or, for a patch, in the workload's own selector).
function selectsOwn(sel: Selector | undefined, podLabels: Record<string, string>): boolean {
  const ml = Object.entries(sel?.matchLabels ?? {});
  return ml.length > 0 && ml.every(([k, v]) => podLabels[k] === v);
}

function hardPerNode(w: Workload, podLabels: Record<string, string>): boolean {
  const t = w.spec?.template?.spec;
  const spread = (t?.topologySpreadConstraints ?? []).some(
    (c) => c.topologyKey === 'kubernetes.io/hostname' && c.whenUnsatisfiable === 'DoNotSchedule' && c.maxSkew === 1
      && selectsOwn(c.labelSelector, podLabels),
  );
  const anti = (t?.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution ?? [])
    .some((a) => a.topologyKey === 'kubernetes.io/hostname' && selectsOwn(a.labelSelector, podLabels));
  return spread || anti;
}

const all = docs();

// A workload and the kustomize patches that target it (same kind + name +
// namespace) are read together — barman-cloud's vendored manifest gets its
// spread from patch-barman-cloud-ha.yaml.
const byWorkload = new Map<string, Array<{ file: string; doc: Workload }>>();
for (const entry of all) {
  const { doc } = entry;
  if (doc.kind !== 'Deployment' && doc.kind !== 'StatefulSet') continue;
  const key = `${doc.metadata?.namespace}/${doc.metadata?.name}`;
  byWorkload.set(key, [...(byWorkload.get(key) ?? []), entry]);
}
const multiReplica = [...byWorkload.entries()]
  .filter(([key, parts]) => SCALED.has(key) || parts.some(({ doc }) => (doc.spec?.replicas ?? 1) > 1))
  .map(([key, parts]) => ({
    key,
    files: parts.map((p) => p.file).join(', '),
    docs: parts.map((p) => p.doc),
    podLabels: Object.assign({}, ...parts.map(({ doc }) => ({ ...doc.spec?.selector?.matchLabels, ...doc.spec?.template?.metadata?.labels }))) as Record<string, string>,
  }));

describe('one replica per server', () => {
  it('reads every manifest that declares a workload', () => {
    expect(unparsed).toEqual([]);
  });

  it('finds the multi-replica workloads (the guard is not vacuous)', () => {
    const names = multiReplica.map(({ key }) => key);
    for (const expected of ['crowdsec/crowdsec', 'platform-system/tenant-errors', 'traefik/modsec-crs', 'platform/platform-api', 'cnpg-system/barman-cloud']) {
      expect(names).toContain(expected);
    }
  });

  it.each(multiReplica.map(({ key, files, docs: d, podLabels }) => [key, files, d, podLabels] as const))(
    '%s (%s) keeps one replica per node, hard',
    (_name, _files, d, podLabels) => {
      expect(d.some((w) => hardPerNode(w, podLabels))).toBe(true);
    },
  );

  it.each([...new Set(multiReplica.map(({ key }) => key.slice(0, key.indexOf('/'))))].map((ns) => [ns] as const))(
    'the rebalance covers namespace %s',
    (ns) => {
      expect(REBALANCE_NAMESPACES).toContain(ns);
    },
  );

  it('keeps every CNPG cluster one instance per server', () => {
    // Every one: the tier scales instances, so a manifest's `instances: 1`
    // says nothing. A cluster and its overlay patches are read together; one
    // must set `required` and none may set anything else.
    const byCluster = new Map<string, Workload[]>();
    for (const { doc } of all) {
      if (doc.kind !== 'Cluster' || !(doc.apiVersion ?? '').startsWith('postgresql.cnpg.io/')) continue;
      const name = doc.metadata?.name ?? '';
      byCluster.set(name, [...(byCluster.get(name) ?? []), doc]);
    }
    expect(byCluster.size).toBeGreaterThan(0);
    for (const [name, parts] of byCluster) {
      const types = parts.map((d) => d.spec?.affinity?.podAntiAffinityType).filter((t) => t !== undefined);
      expect({ name, types }).toEqual({ name, types: types.length > 0 ? types.map(() => 'required') : ['required'] });
      for (const d of parts) {
        if (d.spec?.affinity?.podAntiAffinityType !== undefined) expect(d.spec.affinity.topologyKey).toBe('kubernetes.io/hostname');
      }
    }
  });

  it('scales the Longhorn global manager as a leader-elect operator', () => {
    expect(LEADER_ELECT_DEPLOYMENTS).toContainEqual(
      expect.objectContaining({ namespace: 'longhorn-system', name: 'longhorn-global-manager', optional: true }),
    );
  });
});
