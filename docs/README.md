# Insula Platform Documentation

> **Last restructured:** 2026-06-07 — documentation split into current-state docs,
> a forward-looking roadmap, and frozen historical artifacts.

## Taxonomy — where does a document go?

| Bucket | Question it answers | Maintained? |
|---|---|---|
| **[`architecture/`](architecture/)** | "How is the system designed **today**?" — system design, data model, security model, API conventions, [ADRs](architecture/adr/) | Yes — source for the user manual |
| **[`operations/`](operations/)** | "How do I run it?" — runbooks, deployment, maintenance, incident response | Yes — source for the operator manual |
| **[`features/`](features/)** | "What does feature X do?" — per-feature behavior reference | Yes — source for the tenant/admin manual |
| **[`development/`](development/)** | "How do I contribute?" — local dev, testing, CI/CD, fork-and-deploy | Yes |
| **[`roadmap/`](roadmap/ROADMAP.md)** | "What is planned but not built?" — the R1–R14 follow-up register + future specs | Yes |
| **[`history/`](history/README.md)** | Planning-era artifacts: initial plans, requirement specs for shipped features, descoped features, spikes, logs | **No — frozen.** Deleted once the user manual ships |

**Rules:**
1. New docs go into one of the maintained buckets — never into `history/`.
2. A doc that describes *intent* belongs in `roadmap/`; once shipped, rewrite it as
   current-state in `architecture/`/`features/` and move the planning version to `history/`.
3. Anything referenced from code, scripts, or CI must live outside `history/`
   (enforced by `scripts/ci-docs-link-check.sh`).

## Key entry points

- **Architecture:** [architecture/PLATFORM_ARCHITECTURE.md](architecture/PLATFORM_ARCHITECTURE.md) · [architecture/TECH_STACK_SUMMARY.md](architecture/TECH_STACK_SUMMARY.md)
- **Database schema:** [architecture/DATABASE_SCHEMA.md](architecture/DATABASE_SCHEMA.md) (authoritative source: `backend/src/db/schema.ts`)
- **API spec:** [architecture/MANAGEMENT_API_SPEC.md](architecture/MANAGEMENT_API_SPEC.md) · [architecture/API_ERROR_HANDLING.md](architecture/API_ERROR_HANDLING.md) · [architecture/API_PAGINATION_STRATEGY.md](architecture/API_PAGINATION_STRATEGY.md)
- **ADR index:** [architecture/adr/ARCHITECTURE_DECISION_RECORDS.md](architecture/adr/ARCHITECTURE_DECISION_RECORDS.md)
- **Deployment:** [operations/K3S_DEPLOYMENT_GUIDE.md](operations/K3S_DEPLOYMENT_GUIDE.md) · [development/FORK-AND-DEPLOY.md](development/FORK-AND-DEPLOY.md)
- **Runbooks:** [operations/OPERATIONAL_RUNBOOKS.md](operations/OPERATIONAL_RUNBOOKS.md) · [operations/INCIDENT_RESPONSE_RUNBOOK.md](operations/INCIDENT_RESPONSE_RUNBOOK.md) · [operations/DISASTER_RECOVERY.md](operations/DISASTER_RECOVERY.md)
- **Cluster network & firewall:** [operations/CLUSTER_NETWORK.md](operations/CLUSTER_NETWORK.md)
- **Backups:** [operations/TENANT_BACKUP.md](operations/TENANT_BACKUP.md) · [architecture/BACKUP_COMPONENT_MODEL.md](architecture/BACKUP_COMPONENT_MODEL.md)
- **Mail:** [operations/MAIL_SERVER_OPERATIONS.md](operations/MAIL_SERVER_OPERATIONS.md) · [features/EMAIL_SERVICES.md](features/EMAIL_SERVICES.md)
- **Security:** [architecture/SECURITY_ARCHITECTURE.md](architecture/SECURITY_ARCHITECTURE.md) · [operations/SECURITY_HARDENING.md](operations/SECURITY_HARDENING.md)
- **Roadmap:** [roadmap/ROADMAP.md](roadmap/ROADMAP.md)
- **Historical archive:** [history/README.md](history/README.md)

> **Note (ADR-022, ADR-025):** DNS (PowerDNS), VPN mesh (NetBird), and IAM (Dex/OIDC)
> are external services provided by a separate infrastructure project; workload catalog
> definitions live in external GitHub repositories. This platform consumes their APIs.
