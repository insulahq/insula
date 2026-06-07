# Insula Platform Documentation

> **Last restructured:** 2026-06-07 — documentation split into current-state docs,
> a forward-looking roadmap, and frozen historical artifacts.

## Taxonomy — where does a document go?

| Bucket | Question it answers | Maintained? |
|---|---|---|
| **`architecture/`** *(arriving — see migration note)* | "How is the system designed **today**?" — system design, data model, security model, API conventions, ADRs | Yes — source for the user manual |
| **`operations/`** *(arriving)* | "How do I run it?" — runbooks, deployment, maintenance, incident response | Yes — source for the operator manual |
| **`features/`** *(arriving)* | "What does feature X do?" — per-feature behavior reference | Yes — source for the tenant/admin manual |
| **`development/`** *(arriving)* | "How do I contribute?" — local dev, testing, CI/CD | Yes |
| **`roadmap/`** *(arriving)* | "What is planned but not built?" — follow-up register + future specs | Yes |
| **[`history/`](history/README.md)** | Planning-era artifacts: initial plans, requirement specs for shipped features, descoped features, spikes, logs | **No — frozen.** Deleted once the user manual ships |

**Rules:**
1. New docs go into one of the maintained buckets — never into `history/`.
2. A doc that describes *intent* belongs in `roadmap/`; once shipped, rewrite it as
   current-state in `architecture/`/`features/` and move the planning version to `history/`.
3. Anything referenced from code, scripts, or CI must live outside `history/`
   (enforced by `scripts/ci-docs-link-check.sh`).

## Migration note (transitional)

The restructure lands in stages. The legacy numbered directories below are being
dissolved into the new buckets; until that lands, they remain the home of all
**current-state** documentation:

| Legacy directory | Contents today | Destination |
|---|---|---|
| `01-core/` | Platform architecture, schema, plans, DNS, workloads | `architecture/` |
| `02-operations/` | Runbooks, backup, sizing, mail ops | `operations/` |
| `03-security/` | Auth, RBAC, secrets, TLS, compliance | `architecture/` |
| `03-features/` | Custom containers user guide | `features/` |
| `04-deployment/` | Deploy guides, API spec, CI/CD, cluster network | `operations/` + `architecture/` |
| `05-advanced/` / `05-storage/` / `05-infrastructure/` / `05-integrations/` | DR, HA mode, tenant lifecycle, local dev, DNS providers | `operations/` + `architecture/` + `development/` |
| `06-features/` | Feature specs (email, WAF, cron, backups, webmail) | `features/` |
| `07-reference/` | ADRs, FAQ, terminology, tech stack | `architecture/` (+ superseded ADRs → `history/`) |

## Key entry points (current locations)

- **Architecture:** [01-core/PLATFORM_ARCHITECTURE.md](01-core/PLATFORM_ARCHITECTURE.md)
- **Database schema:** [01-core/DATABASE_SCHEMA.md](01-core/DATABASE_SCHEMA.md)
- **API spec:** [04-deployment/MANAGEMENT_API_SPEC.md](04-deployment/MANAGEMENT_API_SPEC.md)
- **ADR index:** [07-reference/ARCHITECTURE_DECISION_RECORDS.md](07-reference/ARCHITECTURE_DECISION_RECORDS.md)
- **Deployment:** [04-deployment/K3S_DEPLOYMENT_GUIDE.md](04-deployment/K3S_DEPLOYMENT_GUIDE.md) · [04-deployment/FORK-AND-DEPLOY.md](04-deployment/FORK-AND-DEPLOY.md)
- **Operations runbooks:** [02-operations/OPERATIONAL_RUNBOOKS.md](02-operations/OPERATIONAL_RUNBOOKS.md) · [04-deployment/INCIDENT_RESPONSE_RUNBOOK.md](04-deployment/INCIDENT_RESPONSE_RUNBOOK.md)
- **Tenant backups:** [02-operations/TENANT_BACKUP.md](02-operations/TENANT_BACKUP.md)
- **Cluster network & firewall:** [04-deployment/CLUSTER_NETWORK.md](04-deployment/CLUSTER_NETWORK.md)
- **Mail:** [04-deployment/MAIL_SERVER_OPERATIONS.md](04-deployment/MAIL_SERVER_OPERATIONS.md) · [06-features/EMAIL_SERVICES.md](06-features/EMAIL_SERVICES.md)
- **Historical archive:** [history/README.md](history/README.md)

> **Note (ADR-022, ADR-025):** DNS (PowerDNS), VPN mesh (NetBird), and IAM (Dex/OIDC)
> are external services provided by a separate infrastructure project; workload catalog
> definitions live in external GitHub repositories. This platform consumes their APIs.
