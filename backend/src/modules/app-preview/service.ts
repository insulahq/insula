/**
 * App preview — target resolution.
 *
 * A "target" is a (Service, port) pair the preview proxy may reach for a
 * given deployment. Targets are derived from the SAME naming rules the
 * deployers use to create the Services (catalog: k8s-deployer
 * k8sResourceName; custom: serviceObjectName), so preview works the moment
 * the workload runs — no ingress route required.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { catalogEntries, deployments, tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { PreviewTarget } from '@insula/api-contracts';
import { resolveIngressBackend, NotIngressableError } from '../domains/k8s-ingress.js';
import { serviceObjectName } from '../custom-deployments/k8s-deployer.js';

interface EntryComponentPort {
  port: number;
  protocol?: string;
  ingress?: boolean;
}
interface EntryComponent {
  name: string;
  type?: string;
  ports?: EntryComponentPort[];
}

interface CustomSpecPort {
  containerPort: number;
  name: string;
  protocol?: string;
  exposeAsService?: boolean;
  ingressEligible?: boolean;
}

export interface ResolvedPreview {
  namespace: string;
  deploymentName: string;
  targets: PreviewTarget[];
}

export async function resolvePreviewTargets(
  db: Database,
  tenantId: string,
  deploymentId: string,
): Promise<ResolvedPreview> {
  const [row] = await db
    .select({
      id: deployments.id,
      name: deployments.name,
      status: deployments.status,
      source: deployments.source,
      catalogEntryId: deployments.catalogEntryId,
      customSpec: deployments.customSpec,
    })
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new ApiError('DEPLOYMENT_NOT_FOUND', 'Deployment not found', 404);
  if (row.status !== 'running' && row.status !== 'deploying') {
    throw new ApiError(
      'PREVIEW_NOT_RUNNING',
      `Deployment is ${row.status} — start it before previewing.`,
      409,
    );
  }

  const [tenant] = await db
    .select({ ns: tenants.kubernetesNamespace })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant?.ns) throw new ApiError('TENANT_NOT_FOUND', 'Tenant namespace not found', 404);

  const targets =
    row.source === 'custom'
      ? customTargets(row.name, row.customSpec as Record<string, unknown> | null)
      : await catalogTargets(db, row.name, row.catalogEntryId);

  if (targets.length === 0) {
    throw new ApiError(
      'PREVIEW_NO_HTTP_PORTS',
      'This deployment exposes no Service ports to preview.',
      409,
    );
  }
  return { namespace: tenant.ns, deploymentName: row.name, targets };
}

async function catalogTargets(
  db: Database,
  deploymentName: string,
  catalogEntryId: string | null,
): Promise<PreviewTarget[]> {
  if (!catalogEntryId) return [];
  const [entry] = await db
    .select({
      type: catalogEntries.type,
      components: catalogEntries.components,
      networking: catalogEntries.networking,
    })
    .from(catalogEntries)
    .where(eq(catalogEntries.id, catalogEntryId))
    .limit(1);
  if (!entry) return [];

  // The port an ingress route would bind to — the default pick, when the
  // entry is routable at all (databases/services aren't; they can still
  // be previewed via their declared ports below, which mostly matters
  // for services with web UIs).
  let primary: { serviceName: string; port: number } | null = null;
  try {
    primary = resolveIngressBackend(
      entry as Parameters<typeof resolveIngressBackend>[0],
      deploymentName,
    );
  } catch (err) {
    if (!(err instanceof NotIngressableError)) throw err;
  }

  const components = (entry.components ?? []) as EntryComponent[];
  const out: PreviewTarget[] = [];
  if (components.length > 0) {
    for (const comp of components) {
      // Mirror the deployer: cronjob/job components get no Service.
      if (comp.type === 'cronjob' || comp.type === 'job') continue;
      const serviceName =
        components.length <= 1 ? deploymentName : `${deploymentName}-${comp.name}`;
      for (const p of comp.ports ?? []) {
        if ((p.protocol ?? 'TCP').toUpperCase() !== 'TCP') continue;
        out.push({
          serviceName,
          port: p.port,
          memberName: comp.name,
          portName: null,
          primary: primary?.serviceName === serviceName && primary.port === p.port,
        });
      }
    }
  } else {
    // Legacy single-image entries: networking.ingress_ports.
    const ports = (entry.networking as { ingress_ports?: EntryComponentPort[] } | null)
      ?.ingress_ports ?? [];
    for (const p of ports) {
      out.push({
        serviceName: deploymentName,
        port: p.port,
        memberName: null,
        portName: null,
        primary: primary?.port === p.port,
      });
    }
  }
  if (out.length > 0 && !out.some((t) => t.primary)) out[0] = { ...out[0], primary: true };
  return out;
}

function customTargets(
  deploymentName: string,
  customSpec: Record<string, unknown> | null,
): PreviewTarget[] {
  const services = (customSpec?.services ?? {}) as Record<string, { ports?: CustomSpecPort[] }>;
  const names = Object.keys(services);
  const out: PreviewTarget[] = [];
  for (const svcName of names) {
    for (const p of services[svcName]?.ports ?? []) {
      if (p.exposeAsService === false) continue;
      if ((p.protocol ?? 'TCP').toUpperCase() !== 'TCP') continue;
      out.push({
        // One Service object PER PORT — see custom-deployments/k8s-deployer.
        serviceName: serviceObjectName(deploymentName, svcName, names.length, p.name),
        port: p.containerPort,
        memberName: svcName,
        portName: p.name,
        primary: p.ingressEligible === true,
      });
    }
  }
  if (out.length > 0 && !out.some((t) => t.primary)) out[0] = { ...out[0], primary: true };
  return out;
}
