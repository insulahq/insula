/**
 * Platform-migration 0009 — create the wildcard DNS-01 ClusterIssuers on an
 * existing cluster (ADR-058).
 *
 * The solver webhook itself (APIService, Service, serving certificate, RBAC)
 * ships through Flux, so every cluster picks it up on the next reconcile. The
 * two ClusterIssuers that USE it cannot: they carry the operator's Let's
 * Encrypt contact address, which is not knowable when the manifests are
 * rendered — shipping them would deploy `operator@example.com`, and Let's
 * Encrypt rejects that contact. A fresh install gets them from bootstrap.sh
 * with the real address; this covers everyone already running.
 *
 * The address is copied off the HTTP-01 issuer that is already on the cluster,
 * so it is by construction the one the operator configured. If no source
 * issuer exists (a cluster with TLS entirely off), the migration no-ops rather
 * than guessing an address that would make orders fail at ACME registration.
 *
 * CREATE-IF-ABSENT: never overwrites an existing issuer, so an operator who
 * hand-tuned theirs keeps it. Idempotent, order-stable, and a no-op without a
 * k8s client.
 */
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { PlatformMigration } from '../registry/types.js';

const CERTMANAGER_GROUP = 'cert-manager.io';
const CERTMANAGER_VERSION = 'v1';
const CLUSTERISSUER_PLURAL = 'clusterissuers';

/** Issuers we read the ACME contact address from, best first. */
const EMAIL_SOURCE_ISSUERS = [
  'letsencrypt-prod-http01',
  'letsencrypt-staging-http01',
  'acme-custom-http01',
] as const;

interface IssuerSpec {
  readonly name: string;
  readonly server: string;
  readonly accountSecret: string;
}

const ISSUERS: readonly IssuerSpec[] = [
  {
    name: 'letsencrypt-prod-dns01-insula',
    server: 'https://acme-v02.api.letsencrypt.org/directory',
    accountSecret: 'letsencrypt-prod-dns01-insula-account',
  },
  {
    name: 'letsencrypt-staging-dns01-insula',
    server: 'https://acme-staging-v02.api.letsencrypt.org/directory',
    accountSecret: 'letsencrypt-staging-dns01-insula-account',
  },
];

function statusCode(err: unknown): number | undefined {
  return (err as { statusCode?: number; code?: number })?.statusCode
    ?? (err as { code?: number })?.code;
}

async function getClusterIssuer(k8s: K8sClients, name: string): Promise<Record<string, unknown> | null> {
  try {
    return (await k8s.custom.getClusterCustomObject({
      group: CERTMANAGER_GROUP,
      version: CERTMANAGER_VERSION,
      plural: CLUSTERISSUER_PLURAL,
      name,
    } as never)) as Record<string, unknown>;
  } catch (err) {
    if (statusCode(err) === 404) return null;
    throw err;
  }
}

/** The ACME contact address this cluster is already registered with. */
async function resolveAcmeEmail(k8s: K8sClients): Promise<string | null> {
  for (const name of EMAIL_SOURCE_ISSUERS) {
    const issuer = await getClusterIssuer(k8s, name).catch(() => null);
    const email = (issuer as { spec?: { acme?: { email?: string } } } | null)?.spec?.acme?.email;
    if (email && email.includes('@') && !email.endsWith('@example.com')) return email;
  }
  return null;
}

export const seedWildcardDns01Issuers: PlatformMigration = {
  id: '0009_seed_wildcard_dns01_issuers',
  version: '2026.8.4',
  description: 'Create the platform-solver wildcard DNS-01 ClusterIssuers if absent (ADR-058)',
  async up(ctx) {
    if (!ctx.k8s) {
      ctx.log.warn('[0009_seed_wildcard_dns01_issuers] no k8s client at startup — skipping (retried next boot)');
      return;
    }

    const missing: IssuerSpec[] = [];
    for (const issuer of ISSUERS) {
      if (await getClusterIssuer(ctx.k8s, issuer.name)) {
        ctx.log.info(`[0009_seed_wildcard_dns01_issuers] ${issuer.name} already present — leaving it alone`);
      } else {
        missing.push(issuer);
      }
    }
    if (missing.length === 0) return;

    const email = await resolveAcmeEmail(ctx.k8s);
    if (!email) {
      // Guessing an address would produce issuers that fail at ACME
      // account registration — worse than not having them, because the
      // selector would then route wildcard orders at a broken issuer,
      // which is the exact failure mode this whole change removes.
      ctx.log.warn(
        '[0009_seed_wildcard_dns01_issuers] no existing ACME issuer to copy a contact address from — ' +
          'skipping. Re-run bootstrap with --acme-email, or create the issuers manually.',
      );
      return;
    }

    for (const issuer of missing) {
      if (ctx.dryRun) {
        ctx.log.info(`[0009_seed_wildcard_dns01_issuers] would create ClusterIssuer ${issuer.name}`);
        continue;
      }
      await ctx.k8s.custom.createClusterCustomObject({
        group: CERTMANAGER_GROUP,
        version: CERTMANAGER_VERSION,
        plural: CLUSTERISSUER_PLURAL,
        body: {
          apiVersion: `${CERTMANAGER_GROUP}/${CERTMANAGER_VERSION}`,
          kind: 'ClusterIssuer',
          metadata: {
            name: issuer.name,
            labels: {
              'app.kubernetes.io/part-of': 'hosting-platform',
              'app.kubernetes.io/component': 'acme-webhook',
            },
          },
          spec: {
            acme: {
              server: issuer.server,
              email,
              privateKeySecretRef: { name: issuer.accountSecret },
              solvers: [
                {
                  dns01: {
                    webhook: {
                      groupName: 'acme.insula.host',
                      solverName: 'insula-dns',
                      config: {},
                    },
                  },
                },
              ],
            },
          },
        },
      } as never);
      ctx.log.info(`[0009_seed_wildcard_dns01_issuers] created ClusterIssuer ${issuer.name} (contact ${email})`);
    }
  },
};
