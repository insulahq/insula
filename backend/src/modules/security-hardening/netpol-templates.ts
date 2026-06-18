/**
 * NetworkPolicy hardening templates + bulk apply (R11 / Phase 2.4.1).
 *
 * Tenant namespaces ship three INGRESS-only NetworkPolicies at provision
 * (default-deny-ingress + allow-intra-namespace + allow-platform-api), so pods
 * can egress freely. These operator-applied templates add an EGRESS restriction
 * on top — they compose cleanly with the ingress baseline.
 *
 * Safety model (encoded in @insula/api-contracts):
 *   • dry-run first (`apply: false`) returns affected + skipped, writes nothing;
 *   • per-namespace opt-out via the `insula.host/netpol-hardening=optout` label
 *     OR explicit `excludeNamespaces`;
 *   • a namespace that already has a NON-managed Egress NetworkPolicy is skipped
 *     (we never union-loosen an operator's custom egress policy);
 *   • exactly one managed policy per namespace (fixed name) — applying a
 *     template replaces the previous one; `removeNetworkPolicyHardening`
 *     reverses it. Only policies we labelled are ever touched.
 */
import type {
  ApplyNetworkPolicyTemplateRequest,
  ApplyNetworkPolicyTemplateResponse,
  ListNetworkPolicyTemplatesResponse,
  NetworkPolicyTemplate,
  NetworkPolicyTemplateCoverage,
  NetworkPolicyTemplateId,
  RemoveNetworkPolicyHardeningRequest,
  RemoveNetworkPolicyHardeningResponse,
} from '@insula/api-contracts';
import type { SecurityHardeningClients } from './k8s-client.js';

const TENANT_LABEL = 'tenant';
const OPTOUT_LABEL = 'insula.host/netpol-hardening';
const OPTOUT_VALUE = 'optout';
const MANAGED_BY_LABEL = 'insula.host/managed-by';
const MANAGED_BY_VALUE = 'netpol-hardening';
const TEMPLATE_ANNOTATION = 'insula.host/netpol-template';
/** Single managed hardening policy per namespace — replacing it switches templates. */
const POLICY_NAME = 'insula-hardening-egress';

const TEMPLATE_IDS: readonly NetworkPolicyTemplateId[] = ['isolate-tenant', 'deny-all-egress', 'allow-dns-only'];
function isTemplateId(v: unknown): v is NetworkPolicyTemplateId {
  return typeof v === 'string' && (TEMPLATE_IDS as readonly string[]).includes(v);
}

const TEMPLATE_META: Record<NetworkPolicyTemplateId, { title: string; description: string }> = {
  'isolate-tenant': {
    title: 'Isolate tenant',
    description: 'Pods may only reach other pods in the same namespace and cluster DNS. All other outbound traffic (internet, other tenants, the mail relay) is blocked.',
  },
  'deny-all-egress': {
    title: 'Deny all egress',
    description: 'Pods cannot make ANY outbound connection — not even DNS. For maximally locked-down tenants that only serve inbound traffic.',
  },
  'allow-dns-only': {
    title: 'Allow DNS only',
    description: 'Pods may resolve DNS via cluster DNS but cannot make any other outbound connections.',
  },
};

// ─── NetworkPolicy spec per template (Egress) ────────────────────────────────
const DNS_EGRESS = {
  to: [{
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
    podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
  }],
  ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
};
const SAME_NS_EGRESS = { to: [{ podSelector: {} }] };

function buildSpec(id: NetworkPolicyTemplateId): Record<string, unknown> {
  switch (id) {
    case 'isolate-tenant':
      return { podSelector: {}, policyTypes: ['Egress'], egress: [SAME_NS_EGRESS, DNS_EGRESS] };
    case 'allow-dns-only':
      return { podSelector: {}, policyTypes: ['Egress'], egress: [DNS_EGRESS] };
    case 'deny-all-egress':
      return { podSelector: {}, policyTypes: ['Egress'], egress: [] };
  }
}

export function buildPolicyBody(id: NetworkPolicyTemplateId, namespace: string): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: POLICY_NAME,
      namespace,
      labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
      annotations: { [TEMPLATE_ANNOTATION]: id },
    },
    spec: buildSpec(id),
  };
}

const PREVIEW: Record<NetworkPolicyTemplateId, string> = {
  'isolate-tenant': `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${POLICY_NAME}
  namespace: <tenant-namespace>
  labels: { ${MANAGED_BY_LABEL}: ${MANAGED_BY_VALUE} }
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to: [{ podSelector: {} }]            # same namespace
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
          podSelector: { matchLabels: { k8s-app: kube-dns } }
      ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]`,
  'deny-all-egress': `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${POLICY_NAME}
  namespace: <tenant-namespace>
  labels: { ${MANAGED_BY_LABEL}: ${MANAGED_BY_VALUE} }
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress: []                                # deny ALL egress (incl. DNS)`,
  'allow-dns-only': `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${POLICY_NAME}
  namespace: <tenant-namespace>
  labels: { ${MANAGED_BY_LABEL}: ${MANAGED_BY_VALUE} }
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
          podSelector: { matchLabels: { k8s-app: kube-dns } }
      ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]`,
};

export function listTemplates(): NetworkPolicyTemplate[] {
  return TEMPLATE_IDS.map((id) => ({ id, title: TEMPLATE_META[id].title, description: TEMPLATE_META[id].description, manifestPreview: PREVIEW[id] }));
}

// ─── K8s reads ───────────────────────────────────────────────────────────────
interface NsItem { readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string> } }
interface NpItem { readonly metadata?: { readonly namespace?: string; readonly labels?: Record<string, string>; readonly annotations?: Record<string, string> }; readonly spec?: { readonly policyTypes?: string[] } }

async function listTenantNamespaces(core: SecurityHardeningClients['core']): Promise<Array<{ name: string; optedOut: boolean }>> {
  const res = await (core as unknown as { listNamespace: (a: { labelSelector?: string }) => Promise<{ items?: NsItem[] }> })
    .listNamespace({ labelSelector: TENANT_LABEL });
  const out: Array<{ name: string; optedOut: boolean }> = [];
  for (const ns of res.items ?? []) {
    const name = ns.metadata?.name;
    if (!name) continue;
    out.push({ name, optedOut: ns.metadata?.labels?.[OPTOUT_LABEL] === OPTOUT_VALUE });
  }
  return out;
}

/** All NetworkPolicies cluster-wide → managed coverage + namespaces with a custom egress policy. */
async function readNetworkPolicies(networking: SecurityHardeningClients['networking']): Promise<{ coverage: NetworkPolicyTemplateCoverage[]; customEgressNamespaces: Set<string> }> {
  const res = await (networking as unknown as { listNetworkPolicyForAllNamespaces: (a?: { labelSelector?: string }) => Promise<{ items?: NpItem[] }> })
    .listNetworkPolicyForAllNamespaces();
  const coverage: NetworkPolicyTemplateCoverage[] = [];
  const customEgressNamespaces = new Set<string>();
  for (const np of res.items ?? []) {
    const ns = np.metadata?.namespace;
    if (!ns) continue;
    const managed = np.metadata?.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE;
    if (managed) {
      const id = np.metadata?.annotations?.[TEMPLATE_ANNOTATION];
      if (isTemplateId(id)) coverage.push({ namespace: ns, templateId: id });
    } else if ((np.spec?.policyTypes ?? []).includes('Egress')) {
      customEgressNamespaces.add(ns);
    }
  }
  return { coverage, customEgressNamespaces };
}

export async function getNetworkPolicyHardeningState(clients: SecurityHardeningClients): Promise<ListNetworkPolicyTemplatesResponse> {
  const [namespaces, { coverage }] = await Promise.all([
    listTenantNamespaces(clients.core),
    readNetworkPolicies(clients.networking),
  ]);
  // coverage may include stale entries for deleted namespaces — keep only live tenant ns
  const liveNs = new Set(namespaces.map((n) => n.name));
  return {
    data: listTemplates(),
    tenantNamespaceCount: namespaces.length,
    coverage: coverage.filter((c) => liveNs.has(c.namespace)),
    optedOut: namespaces.filter((n) => n.optedOut).map((n) => n.name),
  };
}

// ─── Apply / remove ──────────────────────────────────────────────────────────
function partition(
  namespaces: Array<{ name: string; optedOut: boolean }>,
  exclude: Set<string>,
  customEgress: Set<string>,
): { affected: string[]; skipped: string[] } {
  const affected: string[] = [];
  const skipped: string[] = [];
  for (const ns of namespaces) {
    if (ns.optedOut || exclude.has(ns.name) || customEgress.has(ns.name)) skipped.push(ns.name);
    else affected.push(ns.name);
  }
  return { affected, skipped };
}

export async function applyNetworkPolicyTemplate(
  clients: SecurityHardeningClients,
  req: ApplyNetworkPolicyTemplateRequest,
): Promise<ApplyNetworkPolicyTemplateResponse> {
  const [namespaces, { customEgressNamespaces }] = await Promise.all([
    listTenantNamespaces(clients.core),
    readNetworkPolicies(clients.networking),
  ]);
  const { affected, skipped } = partition(namespaces, new Set(req.excludeNamespaces), customEgressNamespaces);
  if (!req.apply) return { taskId: null, affectedNamespaces: affected, skipped, dryRun: true };

  const net = clients.networking as unknown as {
    deleteNamespacedNetworkPolicy: (a: { name: string; namespace: string }) => Promise<unknown>;
    createNamespacedNetworkPolicy: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  };
  for (const ns of affected) {
    // delete-then-create keeps a single fixed-name managed policy idempotent and
    // lets a template switch in cleanly (the egress gap is sub-second).
    try { await net.deleteNamespacedNetworkPolicy({ name: POLICY_NAME, namespace: ns }); } catch { /* absent — fine */ }
    await net.createNamespacedNetworkPolicy({ namespace: ns, body: buildPolicyBody(req.templateId, ns) });
  }
  return { taskId: null, affectedNamespaces: affected, skipped, dryRun: false };
}

export async function removeNetworkPolicyHardening(
  clients: SecurityHardeningClients,
  req: RemoveNetworkPolicyHardeningRequest,
): Promise<RemoveNetworkPolicyHardeningResponse> {
  const { coverage } = await readNetworkPolicies(clients.networking);
  const exclude = new Set(req.excludeNamespaces);
  const affected: string[] = [];
  const skipped: string[] = [];
  for (const c of coverage) {
    if (exclude.has(c.namespace)) skipped.push(c.namespace);
    else affected.push(c.namespace);
  }
  if (!req.apply) return { affectedNamespaces: affected, skipped, dryRun: true };

  const net = clients.networking as unknown as { deleteNamespacedNetworkPolicy: (a: { name: string; namespace: string }) => Promise<unknown> };
  for (const ns of affected) {
    try { await net.deleteNamespacedNetworkPolicy({ name: POLICY_NAME, namespace: ns }); } catch { /* gone */ }
  }
  return { affectedNamespaces: affected, skipped, dryRun: false };
}
